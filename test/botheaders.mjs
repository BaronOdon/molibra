/**
 * Molibra - the header bot: a second, capped Ethereum header committer.
 *
 * Operator decision, 2 Oct 2026: "yes, with a daily cap". Every transaction
 * goes through `applyTransaction`, the function a mined block calls. Under test:
 *
 *   - below BOT_HEADER_ACTIVATION nothing changes: the bot is refused like
 *     anybody else, and no new state line can appear;
 *   - from it, the bot commits chain-1 roots, and a MOLI_RETURN resting ONLY
 *     on one is capped at 5,000 MOLI per rolling 5,760 blocks, refused whole;
 *   - the operator's root always wins: the bot can never override or repeat
 *     one, and the operator replaces a conflicting bot root (kept as botRoot);
 *   - the operator confirming a bot root lifts the cap for that block;
 *   - a WSRO claim never rests on a bot root.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RLP } from '@ethereumjs/rlp';

import { State, applyTransaction } from '../src/state.js';
import { runEvm } from '../src/evm.js';
import { intrinsicGas } from '../src/tx.js';
import { fromHex } from '../src/crypto.js';
import { foreignTokenId } from '../src/foreign.js';
import { TRANSFER_TOPIC } from '../src/burnproof.js';
import { buildTrie } from '../src/ethreceipts.js';
import {
  bridgeAuthority, encodeBridgeRegister, encodeHeaderCommit, encodeBridgeClaim,
} from '../src/bridgemint.js';
import { encodeMoliBurn, OutboundLedger } from '../src/moliburn.js';
import { InboundLedger } from '../src/inbound.js';
import {
  MOLI_RETURN_ADDRESS, BMOLI_CONTRACT, ETH_HEADER_AUTHORITY, ETH_HEADER_BOT,
  BRIDGE_V2_ACTIVATION, BOT_HEADER_ACTIVATION, BOT_RETURN_CAP, BOT_RETURN_WINDOW,
  encodeMoliReturn, returnKey,
} from '../src/molireturn.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = JSON.parse(readFileSync(join(HERE, '..', 'contracts', 'artifacts', 'pool.json'), 'utf8'));

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

/* --------------------------------------------------------------- receipts */

const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const topic = (a) => fromHex('0x' + a.slice(2).padStart(64, '0'));

function receipt(transfers, status = 1) {
  const logs = transfers.map(({ contract, from, to, amount }) => [
    fromHex(contract), [fromHex(TRANSFER_TOPIC), topic(from), topic(to)], fromHex('0x' + word(amount)),
  ]);
  const body = RLP.encode([status ? new Uint8Array([1]) : new Uint8Array(0),
    new Uint8Array([0x10]), new Uint8Array(256), logs]);
  const out = new Uint8Array(body.length + 1);
  out[0] = 2;
  out.set(body, 1);
  return out;
}

/** A block of receipts, ours at `index`; returns its root and our proof. */
function block(ours, index = 2, size = 5) {
  const filler = receipt([{ contract: '0x' + '99'.repeat(20), from: '0x' + '98'.repeat(20),
    to: '0x' + '97'.repeat(20), amount: 1n }]);
  const receipts = Array.from({ length: size }, (_, i) => (i === index ? ours : filler));
  const trie = buildTrie(receipts.map((r, i) => [RLP.encode(i), r]));
  return { root: trie.root, proof: trie.proofFor(RLP.encode(index)), index: BigInt(index) };
}
const returning = (from, amount) =>
  receipt([{ contract: BMOLI_CONTRACT, from, to: MOLI_RETURN_ADDRESS, amount }]);

/* ------------------------------------------------------------------- cast */

const E18 = 10n ** 18n;
const OP = ETH_HEADER_AUTHORITY;
const BOT = ETH_HEADER_BOT;
const ALICE = '0x2222222222222222222222222222222222222222';
const MALLORY = '0x3333333333333333333333333333333333333333';
const MINER = '0x4444444444444444444444444444444444444444';
const H = BOT_HEADER_ACTIVATION;

const state = new State();
for (const a of [OP, BOT, ALICE, MALLORY]) state.credit(a, 30_000n * E18);

const tx = (from, data, to = from) => ({
  from, to, value: 0n, nonce: state.nonceOf(from), gasPrice: 1n, gasLimit: 3_000_000n, data,
});
const apply = (t, height) => applyTransaction(state, t, intrinsicGas(t), MINER, height);
async function refuses(label, t, height, mustSay = null) {
  const before = state.root(height);
  let threw = null;
  try { await apply(t, height); } catch (e) { threw = e; }
  const said = threw ? String(threw.message) : '';
  check(label, threw !== null && state.root(height) === before
    && (!mustSay || said.includes(mustSay)), threw ? said.slice(0, 110) : 'IT WAS ACCEPTED');
}
const commit = (from, blockNumber, root) =>
  tx(from, encodeHeaderCommit({ originChainId: 1n, blockNumber, receiptsRoot: root }));
const ret = (from, b, blockNumber) =>
  tx(from, encodeMoliReturn({ blockNumber, txIndex: b.index, proof: b.proof }));

/* ------------------------------------------------------------ 1. constants */

console.log('the constants');
check('the bot flag day is after the bridge-v2 flag day', H > BRIDGE_V2_ACTIVATION, `H = ${H}`);
check('⛔ the flag day is ahead of the live tip (138,700 on 2 Oct 2026)', H > 138_700n);
check('the bot is not the operator', BOT !== OP, BOT);
check('the bot address is lower-case normalised', BOT === BOT.toLowerCase() && /^0x[0-9a-f]{40}$/.test(BOT));
check('the cap is 5,000 MOLI', BOT_RETURN_CAP === 5_000n * E18);
check('the window is 5,760 blocks', BOT_RETURN_WINDOW === 5_760n);

/* --------------------------------------------------- 2. before the flag day */

console.log('\nbefore the flag day: exactly today\'s chain');

await apply(tx(ALICE, encodeMoliBurn(ALICE, 20_000n * E18)), 100_000n);
check('Alice burned 20,000 MOLI (outstanding)', state.outbound.outstanding() === 20_000n * E18);

const E = 26_200_000n;   // Ethereum block numbers used below
const pre = block(returning(ALICE, 1n * E18));
await refuses('⛔⛔ the bot cannot commit a chain-1 root before the flag day', commit(BOT, E, pre.root), H - 1n,
  'committed by');
await apply(commit(OP, E, pre.root), H - 1n);
await apply(ret(MALLORY, pre, E), H - 1n);
{
  const lines = state.rootLines().join('\n');
  check('⛔ an operator commit + return before it writes no new kind of state line',
    !lines.includes(':bot:') && !lines.includes('molireturnbot'), 'root lines unchanged in shape');
  check('the operator-only return is paid as before', state.outbound.returned === 1n * E18);
}

/* ------------------------------------------------ 3. the bot, from the flag day */

console.log('\nfrom the flag day: the bot commits, returns are capped');

await refuses('⛔ a stranger still cannot commit a chain-1 root', commit(MALLORY, E + 1n, pre.root), H);

const b1 = block(returning(ALICE, 3_000n * E18));
await apply(commit(BOT, E + 1n, b1.root), H);
check('the bot commits a chain-1 root at the flag day', state.inbound.headerFor(1n, E + 1n)?.by === BOT);
{
  const a = state.balanceOf(ALICE);
  await apply(ret(MALLORY, b1, E + 1n), H);
  check('⭐ a return on a bot root pays the sender', state.balanceOf(ALICE) === a + 3_000n * E18);
  check('and counts against the window', state.outbound.botWindowUsed(H, BOT_RETURN_WINDOW) === 3_000n * E18);
}

const b2 = block(returning(ALICE, 2_500n * E18));
await apply(commit(BOT, E + 2n, b2.root), H + 10n);
await refuses('⛔⛔ a return that would pass 5,000 in the window is refused WHOLE',
  ret(MALLORY, b2, E + 2n), H + 10n, 'header bot committed');
check('⛔ and is not consumed: its key is still unspent',
  !state.outbound.returnKeys.has(returnKey(E + 2n, b2.index)));

const b3 = block(returning(ALICE, 2_000n * E18));
await apply(commit(BOT, E + 3n, b3.root), H + 11n);
await apply(ret(MALLORY, b3, E + 3n), H + 11n);
check('a return that fits under the cap is paid', state.outbound.botWindowUsed(H + 11n, BOT_RETURN_WINDOW)
  === 5_000n * E18, 'exactly 5,000 used');

await refuses('⛔ at the last block of the window the earlier return still counts',
  ret(MALLORY, b2, E + 2n), H + BOT_RETURN_WINDOW - 1n);
{
  const a = state.balanceOf(ALICE);
  await apply(ret(MALLORY, b2, E + 2n), H + BOT_RETURN_WINDOW);
  check('⭐ once the window has rolled past it, the waiting return goes through',
    state.balanceOf(ALICE) === a + 2_500n * E18);
  check('the window has dropped the expired entry from state',
    state.outbound.botReturns.every((r) => r.height > H + BOT_RETURN_WINDOW - BOT_RETURN_WINDOW));
}

/* --------------------------------------------- 4. the operator lifts the cap */

console.log('\nthe operator confirming a bot root lifts the cap');

const big = block(returning(ALICE, 6_000n * E18));
const T = H + 2n * BOT_RETURN_WINDOW;
await apply(commit(BOT, E + 4n, big.root), T);
await refuses('⛔⛔ one return above the cap on a bot-only root is refused', ret(MALLORY, big, E + 4n), T);
await apply(commit(OP, E + 4n, big.root), T);
{
  const h = state.inbound.headerFor(1n, E + 4n);
  check('the operator confirming the same root takes the record', h.by === OP && h.botRoot === big.root);
  const used = state.outbound.botWindowUsed(T, BOT_RETURN_WINDOW);
  const a = state.balanceOf(ALICE);
  await apply(ret(MALLORY, big, E + 4n), T);
  check('⭐ and the 6,000 MOLI return goes through, uncapped', state.balanceOf(ALICE) === a + 6_000n * E18);
  check('⛔ without touching the bot window', state.outbound.botWindowUsed(T, BOT_RETURN_WINDOW) === used);
}

/* ------------------------------------------------ 5. conflicts: operator wins */

console.log('\nconflicting roots: the operator always wins');

const c = block(returning(ALICE, 10n * E18));
await apply(commit(OP, E + 5n, c.root), T);
await refuses('⛔⛔ the bot cannot override an operator root', commit(BOT, E + 5n, '0x' + 'ee'.repeat(32)), T,
  'never overrides');
await refuses('⛔ nor even repeat it', commit(BOT, E + 5n, c.root), T, 'never overrides');

const real = block(returning(ALICE, 7n * E18));
const forged = block(returning(MALLORY, 4_000n * E18), 2, 3);
await apply(commit(BOT, E + 6n, forged.root), T);
await apply(commit(OP, E + 6n, real.root), T);
{
  const h = state.inbound.headerFor(1n, E + 6n);
  check('⭐ the operator\'s DIFFERENT root replaces the bot\'s', h.by === OP && h.receiptsRoot === real.root);
  check('⛔ and the bot\'s root stays on the record', h.botRoot === forged.root
    && state.rootLines().some((l) => l.endsWith(`:bot:${forged.root}`)));
}
await refuses('⛔⛔ the forged receipt no longer proves anything', ret(MALLORY, forged, E + 6n), T);
{
  const a = state.balanceOf(ALICE);
  await apply(ret(MALLORY, real, E + 6n), T);
  check('the real one proves against the operator\'s root, uncapped', state.balanceOf(ALICE) === a + 7n * E18);
}
await refuses('⛔ the bot cannot re-commit its old root over the operator\'s', commit(BOT, E + 6n, forged.root), T);
await refuses('⛔ and the operator cannot change their own root', commit(OP, E + 6n, forged.root), T, 'draft');

const d = block(returning(ALICE, 1n * E18));
await apply(commit(BOT, E + 7n, d.root), T);
await refuses('⛔ the bot cannot change its own root either', commit(BOT, E + 7n, '0x' + 'dd'.repeat(32)), T,
  'draft');
await apply(commit(BOT, E + 7n, d.root), T);
check('the bot repeating its own root changes nothing', state.inbound.headerFor(1n, E + 7n).by === BOT
  && !state.inbound.headerFor(1n, E + 7n).botRoot);

/* ---------------------------------------------- 6. never for WSRO claims */

console.log('\nWSRO claims never rest on a bot root');

const WSRO = '0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8';
const ZERO = '0x0000000000000000000000000000000000000000';
const ctor = (bridge, sym) => word(0x60) + word(0xa0) + bridge.slice(2).padStart(64, '0')
  + word(sym.length) + Buffer.from(sym).toString('hex').padEnd(64, '0')
  + word(sym.length) + Buffer.from(sym).toString('hex').padEnd(64, '0');
const WSRO_ID = foreignTokenId(1n, WSRO);
const deployed = await runEvm(state, { from: OP, to: null,
  data: ART.BridgedAsset.bytecode + ctor(bridgeAuthority(WSRO_ID), 'WSRO'), gasLimit: 6_000_000n });
state.bumpNonce(OP);
await apply(tx(OP, encodeBridgeRegister({ originChainId: 1n, contract: WSRO,
  assetContract: deployed.createdAddress, cap: 1_000n * E18, symbol: 'WSRO' })), 1n);

const burn = block(receipt([{ contract: WSRO, from: ALICE, to: ZERO, amount: 5n * E18 }]));
await apply(commit(BOT, E + 8n, burn.root), T);
const claim = () => tx(MALLORY, encodeBridgeClaim({ tokenId: WSRO_ID, blockNumber: E + 8n,
  txIndex: Number(burn.index), recipient: ALICE, ethTxHash: '0x' + '0b'.repeat(32), proof: burn.proof }));
await refuses('⛔⛔ a WSRO claim against a bot-only root is refused, by name', claim(), T,
  'bot roots count for MOLI returns alone');
await apply(commit(OP, E + 8n, burn.root), T);
await apply(claim(), T);
check('once the operator commits that root, the claim mints', state.inbound.get(WSRO_ID).minted === 5n * E18);

/* --------------------------------------- 7. state plumbing: clone, save, root */

console.log('\nthe new state survives clone, save and load');
{
  const copy = state.clone();
  copy.outbound.recordBotReturn(T, '0xfeed', 1n, BOT_RETURN_WINDOW);
  check('a clone shares no window', state.outbound.botReturns.length !== copy.outbound.botReturns.length);
  const back = State.fromJSON(JSON.parse(JSON.stringify(state.toJSON())));
  check('⛔ save and load keep the root (window + botRoot)', back.root(T) === state.root(T));
  check('and the window itself', back.outbound.botWindowUsed(T, BOT_RETURN_WINDOW)
    === state.outbound.botWindowUsed(T, BOT_RETURN_WINDOW));
}
{
  const l = new OutboundLedger();
  l.burn(ALICE, 10n);
  const before = JSON.stringify(l.rootLines());
  l.recordReturn('0xaa', new Map([[ALICE, 1n]]));
  check('⛔ an operator-only return writes no window line', !JSON.stringify(l.rootLines()).includes('molireturnbot')
    && before !== JSON.stringify(l.rootLines()));
  const i = new InboundLedger();
  i.commitHeader({ originChainId: 1n, blockNumber: 5n, receiptsRoot: '0x' + '11'.repeat(32), by: OP, authority: true });
  check('⛔ a header committed without tiers writes the old line, byte for byte',
    i.rootLines()[0] === `bhead:1:5:${'0x' + '11'.repeat(32)}:${OP}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
