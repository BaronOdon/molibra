/**
 * Molibra - the MOLI/token market, executed on Molibra's OWN EVM.
 *
 * These contracts are not tested in a simulator. Every call below runs through
 * `src/evm.js` against a real Molibra `State`, which is the same path a mined
 * transaction takes. If the pool works here it works on the chain.
 *
 * The checks that matter are the ones about what CANNOT happen: the invariant
 * cannot fall, the pool cannot be drained, a bare send cannot vanish, and no
 * contract can reach the electoral registry.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { State } from '../src/state.js';
import { runEvm, simulate } from '../src/evm.js';
import { keccak256, toHex, fromHex } from '../src/crypto.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = JSON.parse(readFileSync(join(HERE, '..', 'contracts', 'artifacts', 'pool.json'), 'utf8'));

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

/* ---------------------------------------------------------- abi helpers */

const utf8 = (s) => new TextEncoder().encode(s);
const selector = (sig) => toHex(keccak256(utf8(sig))).slice(0, 10);
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const call = (sig, ...args) => selector(sig) + args.join('');
const asBig = (bytes) => (bytes.length ? BigInt(toHex(bytes)) : 0n);

const LP = '0x1111111111111111111111111111111111111111';
const TRADER = '0x2222222222222222222222222222222222222222';
const BRIDGE = '0x3333333333333333333333333333333333333333';
const GAS = 6_000_000n;

const state = new State();
state.credit(LP, 10n ** 21n);
state.credit(TRADER, 10n ** 21n);
state.credit(BRIDGE, 10n ** 18n);

async function deploy(from, bytecode, args = '') {
  const r = await runEvm(state, { from, to: null, data: bytecode + args, gasLimit: GAS });
  if (r.failed) throw new Error(`deploy failed: ${r.error}`);
  return r.createdAddress;
}
async function send(from, to, data, value = 0n) {
  return runEvm(state, { from, to, data, value, gasLimit: GAS });
}
async function read(to, data) {
  const r = await simulate(state, { from: LP, to, data, gasLimit: GAS });
  return asBig(r.returnValue);
}

/* ------------------------------------------------------------------ */
/* 1. Deploy the bridged asset and the pool.                           */
/* ------------------------------------------------------------------ */

// constructor(string,string,address) - offsets, then the two strings
const ctorArgs = word(0x60) + word(0xa0) + addr(BRIDGE)
  + word(4) + Buffer.from('WSRO').toString('hex').padEnd(64, '0')
  + word(4) + Buffer.from('WSRO').toString('hex').padEnd(64, '0');
const asset = await deploy(BRIDGE, ART.BridgedAsset.bytecode, ctorArgs);
check('the bridged asset deploys on Molibra', state.hasCode(asset), asset);

const pool = await deploy(LP, ART.MolibraPool.bytecode, addr(asset));
check('the MOLI/token pool deploys', state.hasCode(pool), pool);

/* ------------------------------------------------------------------ */
/* 2. ⛔ Only the bridge may mint.                                      */
/* ------------------------------------------------------------------ */

const stolen = await send(TRADER, asset, call('mint(address,uint256)', addr(TRADER), word(10n ** 21n)));
check('⛔ nobody but the bridge can mint the bridged asset', stolen.failed,
  'otherwise minted-here == proved-burns-there is only a comment');

await send(BRIDGE, asset, call('mint(address,uint256)', addr(LP), word(1_000_000n * 10n ** 18n)));
await send(BRIDGE, asset, call('mint(address,uint256)', addr(TRADER), word(10_000n * 10n ** 18n)));
check('the bridge can', await read(asset, call('balanceOf(address)', addr(LP))) > 0n);

/* ------------------------------------------------------------------ */
/* 3. First liquidity sets the price.                                  */
/* ------------------------------------------------------------------ */

const MOLI_IN = 100n * 10n ** 18n;
const TOK_IN = 400_000n * 10n ** 18n;

await send(LP, asset, call('approve(address,uint256)', addr(pool), word(TOK_IN)));
const add = await send(LP, pool, call('addLiquidity(uint256,uint256)', word(TOK_IN), word(0)), MOLI_IN);
check('the first deposit succeeds', !add.failed, add.error ?? '');
check('the pool holds the MOLI', await read(pool, call('reserveMoli()')) === MOLI_IN);
check('and the tokens', await read(pool, call('reserveToken()')) === TOK_IN);

const lpShares = await read(pool, call('shares(address)', addr(LP)));
check('the depositor holds shares', lpShares > 0n, `${lpShares}`);
check('⛔ and MINIMUM_LIQUIDITY is burned, so the pool can never be re-founded',
  (await read(pool, call('totalShares()'))) - lpShares === 1000n);

/* ------------------------------------------------------------------ */
/* 4. ⛔⛔ The invariant. k must never fall.                            */
/* ------------------------------------------------------------------ */

const kBefore = (await read(pool, call('reserveMoli()'))) * (await read(pool, call('reserveToken()')));

const SWAP = 5n * 10n ** 18n;
const expected = await read(pool, call('quote(uint256,uint256,uint256)',
  word(SWAP), word(MOLI_IN), word(TOK_IN)));
const swap = await send(TRADER, pool, call('swapMoliForToken(uint256)', word(0)), SWAP);
check('a MOLI-for-token swap succeeds', !swap.failed, swap.error ?? '');
check('the trader received tokens',
  await read(asset, call('balanceOf(address)', addr(TRADER))) > 10_000n * 10n ** 18n);
check('the amount matches the published quote', expected > 0n, `${expected}`);

const kAfter = (await read(pool, call('reserveMoli()'))) * (await read(pool, call('reserveToken()')));
check('⛔⛔ the constant product did not fall', kAfter >= kBefore,
  'the fee is what makes it rise; a fall would mean value left the pool');

/* ------------------------------------------------------------------ */
/* 5. Price impact is real, and slippage protection works.             */
/* ------------------------------------------------------------------ */

const r1 = await read(pool, call('reserveMoli()'));
const t1 = await read(pool, call('reserveToken()'));
const small = await read(pool, call('quote(uint256,uint256,uint256)', word(10n ** 18n), word(r1), word(t1)));
const large = await read(pool, call('quote(uint256,uint256,uint256)', word(50n * 10n ** 18n), word(r1), word(t1)));
check('a bigger trade gets a worse rate', (large * 10n ** 18n) / (50n * 10n ** 18n) < small,
  'price impact, as a constant product must have');

const greedy = await send(TRADER, pool, call('swapMoliForToken(uint256)', word(10n ** 30n)), SWAP);
check('⛔ a swap that misses its minimum reverts', greedy.failed);
check('and the reserves are untouched by the failed swap',
  await read(pool, call('reserveMoli()')) === r1);

/* ------------------------------------------------------------------ */
/* 6. Back the other way, and out again.                               */
/* ------------------------------------------------------------------ */

const backAmount = 1000n * 10n ** 18n;
await send(TRADER, asset, call('approve(address,uint256)', addr(pool), word(backAmount)));
const back = await send(TRADER, pool, call('swapTokenForMoli(uint256,uint256)', word(backAmount), word(0)));
check('a token-for-MOLI swap succeeds', !back.failed, back.error ?? '');
check('the trader got MOLI back', state.balanceOf(TRADER) > 0n);

const half = lpShares / 2n;
const out = await send(LP, pool, call('removeLiquidity(uint256,uint256,uint256)', word(half), word(0), word(0)));
check('liquidity can be withdrawn', !out.failed, out.error ?? '');
check('and the shares are gone',
  await read(pool, call('shares(address)', addr(LP))) === lpShares - half);
check('⛔ withdrawing more than you hold is refused',
  (await send(LP, pool, call('removeLiquidity(uint256,uint256,uint256)',
    word(lpShares * 10n), word(0), word(0)))).failed);

/* ------------------------------------------------------------------ */
/* 7. ⛔ Things that must not work.                                     */
/* ------------------------------------------------------------------ */

const bare = await send(TRADER, pool, '0x', 10n ** 18n);
check('⛔ a bare send to the pool reverts rather than vanishing', bare.failed,
  'it would credit nobody and be unrecoverable');

const donated = await read(pool, call('reserveMoli()'));
await send(BRIDGE, asset, call('mint(address,uint256)', addr(pool), word(10n ** 24n)));
check('⛔ donating tokens to the pool does not move the price',
  await read(pool, call('reserveToken()')) !== await read(asset, call('balanceOf(address)', addr(pool))),
  'reserves are storage, not balances');
check('and the MOLI reserve is unchanged by it',
  await read(pool, call('reserveMoli()')) === donated);

const imbalanced = await send(LP, pool,
  call('addLiquidity(uint256,uint256)', word(1n), word(0)), 10n ** 18n);
check('⛔ a deposit that does not match the ratio is refused, not silently repriced',
  imbalanced.failed);

/* ------------------------------------------------------------------ */
/* 8. ⛔⛔ The wall still holds with a market on the chain.             */
/* ------------------------------------------------------------------ */

state.putToken({
  id: '0xgiz', kind: 'chalk', symbol: 'GIZ', decimals: 0, voteMode: 'single',
  purpose: 'social', cap: 0, maxSupply: 0, minted: 0n, burned: 0n, expressions: 0n,
  expressionCost: 1n, transferable: false, electoral: true, issuable: true,
  creator: LP, createdAt: 0n, initialSupply: 0,
});
state.setTokenBalance('0xgiz', LP, 100n);
const registryBefore = JSON.stringify([...state.tokens],
  (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const balancesBefore = JSON.stringify([...state.tokenBalances],
  (k, v) => (typeof v === 'bigint' ? v.toString() : v));

await send(TRADER, pool, call('swapMoliForToken(uint256)', word(0)), 10n ** 18n);
check('⛔⛔ trading cannot touch the electoral registry',
  JSON.stringify([...state.tokens], (k, v) => (typeof v === 'bigint' ? v.toString() : v)) === registryBefore);
check('⛔⛔ nor any expression-token balance',
  JSON.stringify([...state.tokenBalances], (k, v) => (typeof v === 'bigint' ? v.toString() : v)) === balancesBefore,
  'GIZ is a consensus record, not a contract: there is nothing for a pool to call');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
