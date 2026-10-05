/**
 * Memecoins - MemeToken, and the whole /molibra/memes flow, executed on
 * Molibra's OWN EVM (src/evm.js against a real State, the path a mined
 * transaction takes).
 *
 *   1. MemeToken: transfer / approve / transferFrom / burn and their edges.
 *   2. CARAMELO and BOLSO: deploy -> factory pool -> approve -> seed at parity
 *      -> buy -> sell, with the bytecode and encoders the PAGE uses.
 *   3. FAZOL on Molibra: BridgedAsset trusting the keyless authority derived
 *      from the Ethereum FAZOL address, BRIDGE_REGISTER through consensus,
 *      units minted as the bridge would, then its MOLI market.
 *   4. The page: selectors, registry shape, the meme disclaimers.
 *
 * ⛔ The operator's MOLI is the live balance read 5 Oct 2026 (72,374.998 MOLI),
 * so the seeds below are checked against what he actually holds. The
 * contracts the flow touches are all new, so no other live state is involved.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { State, applyTransaction } from '../src/state.js';
import { runEvm, simulate } from '../src/evm.js';
import { intrinsicGas } from '../src/tx.js';
import { keccak256, toHex, fromHex } from '../src/crypto.js';
import { foreignTokenId } from '../src/foreign.js';
import { bridgeAuthority, encodeBridgeRegister, BRIDGE_REGISTER_TAG, mintCall } from '../src/bridgemint.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const MEME = JSON.parse(read('contracts/artifacts/MemeToken.json'));
const POOLART = JSON.parse(read('contracts/artifacts/pool.json'));
const page = read('src/web/memes.html');
const REG = JSON.parse(read('src/web/markets.json'));

let passed = 0; let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

/* ---------------------------------------------- the page's own code */
const region = page.match(/\/\* ABI-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* ABI-END \*\//);
check('memes.html has an ABI-BEGIN/ABI-END region', !!region);
const L = new Function(region[1] + `
return { word, addr32, encCtor, encBridgedCtor, decString, isqrt, parseDec, parityTokens, quoteOut,
  impactBp, firstShares, sqrtAtTick, tickAtSqrt, v4Plan, bridgeIds, encBridgeRegister };`)();
const pageConst = (name) => { const m = page.match(new RegExp(`const ${name} = '([^']*)';`)); return m && m[1]; };
const MEME_BYTECODE = pageConst('MEME_BYTECODE');
const FACTORY_BYTECODE = pageConst('FACTORY_BYTECODE');
const BRIDGED_BYTECODE = pageConst('BRIDGED_BYTECODE');
check('the page carries the built MemeToken bytecode', MEME_BYTECODE === MEME.bytecode,
  'rebuild with contracts/memes-build-and-test.mjs');
check('the page carries the BridgedAsset WSRO uses', BRIDGED_BYTECODE === POOLART.BridgedAsset.bytecode);
check('the page carries swap.html\'s factory', FACTORY_BYTECODE && read('src/web/swap.html').includes(FACTORY_BYTECODE));

/* ---------------------------------------------------------- harness */
const utf8 = (s) => new TextEncoder().encode(s);
const sel = (s) => toHex(keccak256(utf8(s))).slice(0, 10);
const word = L.word; const addr = L.addr32;
const asBig = (b) => (b.length ? BigInt(toHex(b)) : 0n);
const UNIT = 10n ** 18n;
const GAS = 8_000_000n;
const fmt = (w, p = 4) => (Number(w) / 1e18).toLocaleString('en-US', { maximumFractionDigits: p });

const OPERATOR = '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a';
const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const MINER = '0x000000000000000000000000000000000000beef';
const OPERATOR_LIVE_MOLI = 72374998173349000000000n;   // eth_getBalance, 5 Oct 2026

const state = new State();
state.credit(OPERATOR, OPERATOR_LIVE_MOLI);
state.credit(ALICE, 10_000n * UNIT);
state.credit(BOB, 10_000n * UNIT);

const gasLog = {};
async function deploy(from, bytecode, args = '', label = null) {
  const r = await runEvm(state, { from, to: null, data: bytecode + args, gasLimit: GAS });
  if (r.failed) throw new Error(`deploy failed: ${r.error}`);
  state.bumpNonce(from);
  if (label) gasLog[label] = r.gasUsed;
  return r.createdAddress;
}
async function send(from, to, data, value = 0n, label = null) {
  const r = await runEvm(state, { from, to, data, value, gasLimit: GAS });
  if (!r.failed) state.bumpNonce(from);
  if (label && !r.failed) gasLog[label] = r.gasUsed;
  return r;
}
async function view(to, data) {
  return (await simulate(state, { from: ALICE, to, data, gasLimit: GAS })).returnValue;
}
const num = async (to, data) => asBig(await view(to, data));
const str = async (to, data) => L.decString(toHex(await view(to, data)));
const bal = (tok, who) => num(tok, sel('balanceOf(address)') + addr(who));

/* ----------------------------------------------- 1. MemeToken basics */
console.log('\n1. MemeToken\n');
{
  const SUPPLY = 1000n * UNIT;
  const desc = 'meme não oficial — test';
  const t = await deploy(ALICE, MEME.bytecode, L.encCtor('Test', 'TST', desc, SUPPLY, ALICE));
  check('deploys with the page-encoded constructor', state.hasCode(t), t);
  check('name / symbol / description read back exactly',
    await str(t, sel('name()')) === 'Test' && await str(t, sel('symbol()')) === 'TST'
    && await str(t, sel('description()')) === desc);
  check('decimals 18, totalSupply minted to the holder',
    await num(t, sel('decimals()')) === 18n && await num(t, sel('totalSupply()')) === SUPPLY
    && await bal(t, ALICE) === SUPPLY);

  const bad = await runEvm(state, { from: ALICE, to: null, data: MEME.bytecode + L.encCtor('x', 'X', '', 1n, '0x' + '00'.repeat(20)), gasLimit: GAS });
  check('⛔ a zero holder is refused at construction', bad.failed);

  let r = await send(ALICE, t, sel('transfer(address,uint256)') + addr(BOB) + word(100n * UNIT));
  check('transfer moves units', !r.failed && await bal(t, BOB) === 100n * UNIT && await bal(t, ALICE) === 900n * UNIT);
  check('  and emits Transfer(from, to, value)', r.logs.length === 1 && r.logs[0].topics[0] === toHex(keccak256(utf8('Transfer(address,address,uint256)'))));
  r = await send(BOB, t, sel('transfer(address,uint256)') + addr(ALICE) + word(101n * UNIT));
  check('⛔ a transfer above the balance reverts', r.failed);
  r = await send(BOB, t, sel('transfer(address,uint256)') + addr('0x' + '00'.repeat(20)) + word(1n));
  check('⛔ a transfer to the zero address reverts (burning is burn())', r.failed);
  r = await send(BOB, t, sel('transfer(address,uint256)') + addr(ALICE) + word(0n));
  check('a zero-value transfer succeeds, as ERC-20 requires', !r.failed);

  r = await send(ALICE, t, sel('approve(address,uint256)') + addr(BOB) + word(50n * UNIT));
  check('approve sets the allowance', !r.failed && await num(t, sel('allowance(address,address)') + addr(ALICE) + addr(BOB)) === 50n * UNIT);
  r = await send(ALICE, t, sel('approve(address,uint256)') + addr('0x' + '00'.repeat(20)) + word(1n));
  check('⛔ approving the zero address reverts', r.failed);
  r = await send(BOB, t, sel('transferFrom(address,address,uint256)') + addr(ALICE) + addr(BOB) + word(51n * UNIT));
  check('⛔ transferFrom above the allowance reverts', r.failed);
  r = await send(BOB, t, sel('transferFrom(address,address,uint256)') + addr(ALICE) + addr(BOB) + word(30n * UNIT));
  check('transferFrom within the allowance moves units and spends it',
    !r.failed && await bal(t, BOB) === 130n * UNIT
    && await num(t, sel('allowance(address,address)') + addr(ALICE) + addr(BOB)) === 20n * UNIT);
  await send(ALICE, t, sel('approve(address,uint256)') + addr(BOB) + 'f'.repeat(64));
  await send(BOB, t, sel('transferFrom(address,address,uint256)') + addr(ALICE) + addr(BOB) + word(1n * UNIT));
  check('an unlimited allowance is not decremented', await num(t, sel('allowance(address,address)') + addr(ALICE) + addr(BOB)) === (1n << 256n) - 1n);
  r = await send(BOB, t, sel('transferFrom(address,address,uint256)') + addr(ALICE) + addr(BOB) + word(10_000n * UNIT));
  check('⛔ even unlimited, transferFrom above the owner balance reverts', r.failed);

  const before = await num(t, sel('totalSupply()'));
  r = await send(BOB, t, sel('burn(uint256)') + word(31n * UNIT));
  const burnLog = r.logs[0];
  check('burn destroys the caller\'s units and lowers totalSupply',
    !r.failed && await num(t, sel('totalSupply()')) === before - 31n * UNIT && await bal(t, BOB) === 100n * UNIT);
  check('⭐ burn emits Transfer(caller, 0x0, amount) - the log src/burnproof.js findBurn proves',
    burnLog && burnLog.topics[2] === '0x' + '00'.repeat(32) && burnLog.topics[1].endsWith(BOB.slice(2))
    && BigInt(burnLog.data) === 31n * UNIT);
  r = await send(BOB, t, sel('burn(uint256)') + word(101n * UNIT));
  check('⛔ burning above the balance reverts', r.failed);
  for (const fn of ['mint(address,uint256)', 'owner()', 'pause()', 'burnFrom(address,uint256)']) {
    r = await runEvm(state.clone(), { from: ALICE, to: t, data: sel(fn) + word(1n) + word(1n), gasLimit: GAS });
    check(`⛔ there is no ${fn}`, r.failed);
  }
}

/* -------------------------------- 2. CARAMELO and BOLSO, end to end */
console.log('\n2. Molibra memecoins: deploy, market, seed at parity, buy, sell\n');
const snap = REG.snapshot;
const moliUsdE18 = L.parseDec(snap.moliUsd);
const factory = await deploy(OPERATOR, FACTORY_BYTECODE, '', 'factory deploy');
check('the factory deploys', state.hasCode(factory), factory);
const report = [];

async function market(sym, token, seedMoli, seedTok, cpUsd) {
  let r = await send(OPERATOR, factory, sel('create(address)') + addr(token), 0n, `${sym} create pool`);
  check(`${sym}: the factory creates its MOLI market`, !r.failed);
  const pool = '0x' + toHex(await view(factory, sel('poolOf(address)') + addr(token))).slice(-40);
  r = await send(OPERATOR, token, sel('approve(address,uint256)') + addr(pool) + word(seedTok), 0n, `${sym} approve`);
  check(`${sym}: approve exactly the seed`, !r.failed);
  const minShares = L.firstShares(seedMoli, seedTok);
  r = await send(OPERATOR, pool, sel('addLiquidity(uint256,uint256)') + word(seedTok) + word(minShares), seedMoli, `${sym} addLiquidity`);
  check(`${sym}: seeded with minShares = sqrt(m·t) − 1000 exactly`, !r.failed, r.error ?? '');
  const res = toHex(await view(pool, sel('reserves()'))).slice(2);
  const rm = BigInt('0x' + res.slice(0, 64)); const rt = BigInt('0x' + res.slice(64, 128));
  const spot = (rm * UNIT) / rt;                       // MOLI per token, 18 dp
  const parity = (L.parseDec(cpUsd) * UNIT) / moliUsdE18;
  const err = spot > parity ? spot - parity : parity - spot;
  check(`${sym}: the pool's spot price IS the parity`, err * 1_000_000n <= parity,
    `${fmt(spot, 6)} MOLI vs parity ${fmt(parity, 6)}`);

  const rows = [];
  for (const x of [10n, 100n, 1000n]) {
    const s = state.clone();
    const want = L.quoteOut(x * UNIT, rm, rt);
    const r2 = await runEvm(s, { from: ALICE, to: pool, data: sel('swapMoliForToken(uint256)') + word(want), value: x * UNIT, gasLimit: GAS });
    const got = asBig((await simulate(s, { from: ALICE, to: token, data: fromHex(sel('balanceOf(address)') + addr(ALICE)), gasLimit: GAS })).returnValue);
    check(`${sym}: a ${x}-MOLI buy executes and pays exactly the page's quote`, !r2.failed && got === want, `${fmt(got, 6)} ${sym}`);
    rows.push({ x, out: got, bp: L.impactBp(x * UNIT, rm, rt) });
  }
  // A real buy, then sell all of it back.
  const out = L.quoteOut(100n * UNIT, rm, rt);
  r = await send(BOB, pool, sel('swapMoliForToken(uint256)') + word(out), 100n * UNIT, `${sym} buy`);
  check(`${sym}: buy 100 MOLI`, !r.failed);
  await send(BOB, token, sel('approve(address,uint256)') + addr(pool) + word(out));
  const before = state.balanceOf(BOB);
  r = await send(BOB, pool, sel('swapTokenForMoli(uint256,uint256)') + word(out) + word(1n), 0n, `${sym} sell`);
  const back = state.balanceOf(BOB) - before;
  check(`${sym}: sell it all back; the round trip costs the two 0.3% fees and no more`,
    !r.failed && back < 100n * UNIT && back > 99_39n * UNIT / 100n, `${fmt(back, 4)} MOLI back of 100`);
  report.push({ sym, pool, rm, rt, spot, rows, roundTrip: back });
  return pool;
}

const used = {};
for (const key of ['caramelo', 'bolso']) {
  const m = REG.markets.find((x) => x.key === key);
  const cp = REG.counterparts[m.meme.counterpart];
  const supply = L.parseDec(m.meme.supply);
  const token = await deploy(OPERATOR, MEME_BYTECODE, L.encCtor(m.meme.name, m.symbol, m.meme.description, supply, OPERATOR), `${m.symbol} deploy`);
  check(`${m.symbol}: deploys, whole supply to the operator`, await bal(token, OPERATOR) === supply,
    `${Number(m.meme.supply).toLocaleString('en-US')} ${m.symbol}`);
  check(`${m.symbol}: the on-chain description is the registry's, disclaimer included`,
    await str(token, sel('description()')) === m.meme.description);
  const seedMoli = L.parseDec(m.meme.seedMoli);
  const seedTok = L.parityTokens(seedMoli, moliUsdE18, L.parseDec(cp.usd));
  used[key] = seedMoli;
  await market(m.symbol, token, seedMoli, seedTok, cp.usd);
}

/* ------------------------------------------- 3. FAZOL on Molibra */
console.log('\n3. FAZOL: BridgedAsset, BRIDGE_REGISTER, market\n');
{
  const m = REG.markets.find((x) => x.key === 'fazol');
  // Any Ethereum address works for the derivation; the plan script predicts
  // the real one from the operator's Ethereum nonce.
  const ETH_FAZOL = '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
  const keccak = (hex) => toHex(keccak256(fromHex('0x' + hex.replace(/^0x/, ''))));
  const ids = L.bridgeIds(keccak, 1, ETH_FAZOL);
  check('page bridgeIds: token id == src/foreign.js foreignTokenId', ids.tokenId === foreignTokenId(1n, ETH_FAZOL));
  check('page bridgeIds: authority == src/bridgemint.js bridgeAuthority', ids.authority === bridgeAuthority(ids.tokenId));
  check('page BRIDGE_REGISTER tag == src/bridgemint.js', pageConst('BRIDGE_REGISTER_TAG') === BRIDGE_REGISTER_TAG);

  const asset = await deploy(OPERATOR, BRIDGED_BYTECODE, L.encBridgedCtor(m.meme.name, 'FAZOL', ids.authority), 'FAZOL BridgedAsset deploy');
  check('the FAZOL BridgedAsset deploys trusting the keyless authority',
    '0x' + toHex(await view(asset, sel('bridge()'))).slice(-40) === ids.authority);
  const CAP = L.parseDec(m.meme.ethereum.bridgeCap);
  const payload = L.encBridgeRegister(1, ETH_FAZOL, asset, CAP, 'FAZOL');
  check('page encBridgeRegister == src/bridgemint.js encodeBridgeRegister',
    payload === encodeBridgeRegister({ originChainId: 1n, contract: ETH_FAZOL, assetContract: asset, cap: CAP, symbol: 'FAZOL' }));
  const tx = { from: OPERATOR, to: asset, value: 0n, nonce: state.nonceOf(OPERATOR), gasPrice: 1n, gasLimit: 500_000n, data: payload };
  const out = await applyTransaction(state, tx, intrinsicGas(tx), MINER, 150_000n);
  check('⭐ BRIDGE_REGISTER is accepted by consensus', out.bridgeAsset === ids.tokenId, out.bridgeAsset);
  check('  the operator is the asset\'s registrar', state.inbound.get(ids.tokenId).registrar === OPERATOR);

  // The claim path (proof of the Ethereum burn) is covered for WSRO by
  // test/bridgemint.mjs. Here the authority mints directly, as the claim
  // would, so the market can be exercised.
  const IN = L.parseDec(m.meme.ethereum.bridgeIn);
  const minted = await runEvm(state, { from: ids.authority, to: asset, data: mintCall(OPERATOR, IN), gasLimit: GAS });
  check(`stand-in for the proved claim: ${m.meme.ethereum.bridgeIn} FAZOL minted to the operator`, !minted.failed && await bal(asset, OPERATOR) === IN);
  const cp = REG.counterparts[m.meme.counterpart];
  const seedMoli = L.parseDec(m.meme.seedMoli);
  const seedTok = L.parityTokens(seedMoli, moliUsdE18, L.parseDec(cp.usd));
  check('the bridged-in amount covers the seed', seedTok <= IN, `${fmt(seedTok, 4)} of ${fmt(IN, 0)}`);
  used.fazol = seedMoli;
  await market('FAZOL', asset, seedMoli, seedTok, cp.usd);
}

const spent = Object.values(used).reduce((a, b) => a + b, 0n);
check('the three seeds fit in the operator\'s live MOLI with room to spare', spent * 4n < OPERATOR_LIVE_MOLI,
  `${fmt(spent, 0)} of ${fmt(OPERATOR_LIVE_MOLI, 0)} MOLI`);

console.log('\n  pool        reserves                         spot (MOLI)   buy 10       buy 100      buy 1000     100-MOLI round trip');
for (const r of report) {
  console.log(`  ${r.sym.padEnd(10)}  ${fmt(r.rm, 0)} MOLI / ${fmt(r.rt, 4)} ${r.sym}`.padEnd(50)
    + `  ${fmt(r.spot, 4).padStart(10)}  ` + r.rows.map((x) => `${(Number(x.bp) / 100).toFixed(2)}%`.padStart(10)).join('   ')
    + `   ${fmt(r.roundTrip, 4)} MOLI`);
}
console.log('\n  gas used (Molibra, at 1 gwei = 1e-9 MOLI per gas):');
for (const [k, g] of Object.entries(gasLog)) console.log(`    ${k.padEnd(28)} ${g}`);

/* ------------------------------------------------------- 4. the page */
console.log('\n4. The page and the registry\n');
const SIGS = {
  name: 'name()', symbol: 'symbol()', description: 'description()', totalSupply: 'totalSupply()',
  balanceOf: 'balanceOf(address)', approve: 'approve(address,uint256)', allowance: 'allowance(address,address)',
  burn: 'burn(uint256)', create: 'create(address)', poolOf: 'poolOf(address)',
  addLiquidity: 'addLiquidity(uint256,uint256)', reserves: 'reserves()', totalShares: 'totalShares()',
  bridge: 'bridge()', initializePool: 'initializePool((address,address,uint24,int24,address),uint160)',
  modifyLiquidities: 'modifyLiquidities(bytes,uint256)', multicall: 'multicall(bytes[])',
  permit2Approve: 'approve(address,address,uint160,uint48)', getSlot0: 'getSlot0(bytes32)',
  latestRoundData: 'latestRoundData()',
};
const block = page.match(/const SEL = \{[\s\S]*?\n\};/)[0];
for (const [k, s] of Object.entries(SIGS)) {
  const m = block.match(new RegExp(`${k}:\\s*'(0x[0-9a-f]{8})'`));
  check(`SEL.${k} is keccak of ${s}`, !!m && m[1] === sel(s), m ? m[1] : 'missing');
}
for (const [k, s] of [['initializePool', SIGS.initializePool], ['modifyLiquidities', SIGS.modifyLiquidities], ['multicall', SIGS.multicall]]) {
  check(`SEL_V4.${k} agrees`, region[1].includes(`${k}: '${sel(s).slice(2)}'`));
}
check('encPermit2Approve uses the Permit2 approve selector', region[1].includes(`'${sel(SIGS.permit2Approve)}'`));

check('the registry lists WSRO with its live pool', REG.markets.some((m) => m.key === 'wsro' && m.pool === '0x4f34d9bc5db2396640d8eb564667e8701528b43d'));
for (const key of ['caramelo', 'bolso', 'fazol']) {
  const m = REG.markets.find((x) => x.key === key);
  check(`${key} is in the registry`, !!m && !!m.meme);
  const d = m.meme.description;
  check(`  ${m.symbol}: the description says it is a meme with no promise of value (PT + EN)`,
    /meme/i.test(d) && /sem nenhuma promessa de valor/.test(d) && /no promise of value/.test(d));
  if (key !== 'caramelo') {
    check(`  ${m.symbol}: unofficial, not affiliated, not endorsed (PT + EN)`,
      /não oficial/.test(d) && /sem vínculo|Não tem vínculo/.test(d) && /not affiliated with or endorsed by/i.test(d));
  }
  check(`  ${m.symbol}: its counterpart has a price`, !!REG.counterparts[m.meme.counterpart]?.usd);
}
const bolso = REG.markets.find((x) => x.key === 'bolso');
check('BOLSO names the person it is NOT affiliated with, and the family and parties',
  bolso.symbol === 'BOLSO' && bolso.meme.name === 'Bolsonaro' && /Jair Bolsonaro, sua família ou qualquer partido\/campanha/.test(bolso.meme.description));
check('FAZOL: not affiliated with Lula or any party or campaign',
  /Luiz Inácio Lula da Silva nem com nenhum partido ou campanha/.test(REG.markets.find((x) => x.key === 'fazol').meme.description));
check('⛔ the page shows no image of anybody', !/<img|background-image|\.jpg|\.png/i.test(page.replace(/\/icon\.png/g, '')));
check('⛔ the page and registry add no electoral clause (electoral law attaches to GIZ only)',
  // Word boundaries: "querySelectorAll" contains "electorAl".
  !/\bTSE\b|\beleitora(l|is)\b|\belectoral\b/i.test(page + JSON.stringify(REG)));
check('the page reads addresses from /molibra/markets.json', page.includes("'/molibra/markets.json'"));
check('⛔ every Molibra step is simulated before the wallet is asked',
  /eth_estimateGas/.test(page) && /a simulação reverte/.test(page));
check('⛔ every Ethereum step uses a 0.05 gwei tip and maxFee = 2×base + tip',
  page.includes('const ETH_TIP = 50000000n;') && page.includes('const maxFee = 2n * base + ETH_TIP;'));
check('⛔ the first deposit refuses a pool that already has liquidity', page.includes('if (ts !== 0n)'));
check('⛔ the v4 step refuses an already-initialised pool', page.includes('este pool já foi inicializado'));
{
  // The page's main script must at least PARSE: a syntax error kills every button at once.
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let err = null;
  try { for (const sc of scripts) new Function(sc); } catch (e) { err = e.message; }
  check('the page script parses', scripts.length > 0 && !err, err ?? `${scripts.length} inline script(s)`);
}
check('⛔ a price-setting step refuses to run on the snapshot prices',
  (page.match(/needLive\(\);/g) || []).length >= 3);
check('⛔ only the operator account may run a step', page.includes("if (account !== OPERATOR)"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
