/**
 * Molibra - MOLI coming back, and the three inbound fixes that ship with it.
 *
 * Every transaction goes through `applyTransaction`, the function a mined
 * block calls. The properties under test:
 *
 *   - a bMOLI transfer into the keyless vault, proved against a root the
 *     Ethereum header authority committed, pays the SENDER here - once;
 *   - never more comes back than went out: returned <= burned;
 *   - below the flag day nothing changes, so history replays byte for byte;
 *   - the WSRO leg no longer accepts a squatted root, a claimant-chosen
 *     recipient, or the same receipt under an invented transaction hash.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RLP } from '@ethereumjs/rlp';

import { State, applyTransaction } from '../src/state.js';
import { runEvm } from '../src/evm.js';
import { intrinsicGas } from '../src/tx.js';
import { keccak256, toHex, fromHex } from '../src/crypto.js';
import { foreignTokenId } from '../src/foreign.js';
import { TRANSFER_TOPIC, toNibbles, decodeHexPrefix } from '../src/burnproof.js';
import {
  bridgeAuthority, encodeBridgeRegister, encodeHeaderCommit, encodeBridgeClaim,
} from '../src/bridgemint.js';
import { encodeMoliBurn, MOLI_BURN_TAG, OutboundLedger } from '../src/moliburn.js';
import {
  MOLI_RETURN_ADDRESS, MOLI_RETURN_TAG, BMOLI_CONTRACT, ETH_HEADER_AUTHORITY,
  BRIDGE_V2_ACTIVATION, encodeMoliReturn, decodeMoliReturn, returnKey,
  inboundPositionKey, HISTORICAL_INBOUND_POSITIONS,
} from '../src/molireturn.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = JSON.parse(readFileSync(join(HERE, '..', 'contracts', 'artifacts', 'pool.json'), 'utf8'));

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

/* ------------------------------------------------ receipts-trie scaffolding */
/* Test-only, as in bridgemint.mjs: a node never builds an Ethereum trie. */

const hexPrefix = (path, isLeaf) => {
  const odd = path.length % 2 === 1;
  const flag = (isLeaf ? 2 : 0) + (odd ? 1 : 0);
  const nibbles = odd ? [flag, ...path] : [flag, 0, ...path];
  const out = new Uint8Array(nibbles.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (nibbles[2 * i] << 4) | nibbles[2 * i + 1];
  return out;
};
const store = new Map();
function ref(node) {
  const raw = RLP.encode(node);
  if (raw.length < 32) return node;
  const h = keccak256(raw);
  store.set(toHex(h), raw);
  return h;
}
function build(entries) {
  if (entries.length === 1) return [hexPrefix(entries[0][0], true), entries[0][1]];
  let common = 0;
  const first = entries[0][0];
  outer: while (common < first.length) {
    const n = first[common];
    for (const [p] of entries) { if (common >= p.length || p[common] !== n) break outer; }
    common++;
  }
  if (common > 0) {
    return [hexPrefix(first.slice(0, common), false),
      ref(build(entries.map(([p, v]) => [p.slice(common), v])))];
  }
  const branch = new Array(17).fill(new Uint8Array(0));
  const buckets = new Map();
  for (const [p, v] of entries) {
    if (p.length === 0) { branch[16] = v; continue; }
    if (!buckets.has(p[0])) buckets.set(p[0], []);
    buckets.get(p[0]).push([p.slice(1), v]);
  }
  for (const [k, sub] of buckets) branch[k] = ref(build(sub));
  return branch;
}
function trieRoot(pairs) {
  const entries = pairs.map(([key, value]) => [toNibbles(key), value]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const raw = RLP.encode(build(entries));
  const h = keccak256(raw);
  store.set(toHex(h), raw);
  return toHex(h);
}
function proofFor(root, key) {
  const path = toNibbles(key);
  const nodes = [];
  let expected = root;
  let i = 0;
  for (;;) {
    const raw = store.get(expected);
    if (!raw) return nodes;
    nodes.push(raw);
    const node = RLP.decode(raw);
    if (node.length === 17) {
      if (i === path.length) return nodes;
      const next = node[path[i]]; i++;
      if (!next || next.length === 0) return nodes;
      expected = toHex(next);
    } else {
      const { isLeaf, path: seg } = decodeHexPrefix(node[0]);
      i += seg.length;
      if (isLeaf) return nodes;
      expected = toHex(node[1]);
    }
  }
}

const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const topic = (a) => fromHex('0x' + a.slice(2).padStart(64, '0'));

/** An EIP-1559 receipt holding the given ERC-20 Transfers. */
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

/** A whole block of receipts: ours at `index`, filler around it. */
function block(ours, index = 3, size = 6) {
  const filler = receipt([{ contract: '0x' + '99'.repeat(20), from: '0x' + '98'.repeat(20),
    to: '0x' + '97'.repeat(20), amount: 1n }]);
  const receipts = Array.from({ length: size }, (_, i) => (i === index ? ours : filler));
  store.clear();
  const root = trieRoot(receipts.map((r, i) => [RLP.encode(i), r]));
  return { root, proof: proofFor(root, RLP.encode(index)), index };
}

/* -------------------------------------------------------------------- cast */

const E18 = 10n ** 18n;
const AUTH = ETH_HEADER_AUTHORITY;
const ALICE = '0x2222222222222222222222222222222222222222';
const MALLORY = '0x3333333333333333333333333333333333333333';
const MINER = '0x4444444444444444444444444444444444444444';
const FAKE_BMOLI = '0x5555555555555555555555555555555555555555';
const V2 = BRIDGE_V2_ACTIVATION;
const BEFORE = V2 - 1n;

const state = new State();
for (const a of [AUTH, ALICE, MALLORY]) state.credit(a, 1000n * E18);

const tx = (from, data, to = from) => ({
  from, to, value: 0n, nonce: state.nonceOf(from), gasPrice: 1n, gasLimit: 3_000_000n, data,
});
const apply = (t, height = V2) => applyTransaction(state, t, intrinsicGas(t), MINER, height);
async function refuses(label, t, height = V2) {
  const before = state.root(height);
  let threw = null;
  try { await apply(t, height); } catch (e) { threw = e; }
  check(label, threw !== null && state.root(height) === before,
    threw ? String(threw.message).slice(0, 96) : 'IT WAS ACCEPTED');
}

/* ------------------------------------------------------- 1. the constants */

console.log('the return vault and the payload');
check('the vault is derived from a string, not typed', MOLI_RETURN_ADDRESS
  === '0x' + toHex(keccak256(new TextEncoder().encode('molibra:moli-return:v1'))).slice(-40),
  MOLI_RETURN_ADDRESS);
check('⛔ it is not the zero address, which bMOLI refuses', !/^0x0{40}$/.test(MOLI_RETURN_ADDRESS));
check('the return tag is not the burn tag', MOLI_RETURN_TAG !== MOLI_BURN_TAG,
  `${MOLI_RETURN_TAG} vs ${MOLI_BURN_TAG}`);
{
  const b = block(receipt([{ contract: BMOLI_CONTRACT, from: ALICE, to: MOLI_RETURN_ADDRESS, amount: 1n }]));
  const d = decodeMoliReturn(encodeMoliReturn({ blockNumber: 7n, txIndex: 3n, proof: b.proof }));
  check('a return payload round-trips', d.blockNumber === 7n && d.txIndex === 3n
    && d.proof.length === b.proof.length);
  check('unrelated data is not a return', decodeMoliReturn('0x1234') === null);
}
{
  const page = readFileSync(join(HERE, '..', 'src', 'web', 'return.html'), 'utf8');
  const vault = page.match(/const VAULT = '(0x[0-9a-f]{40})'/)?.[1];
  const bmoli = page.match(/const BMOLI = '(0x[0-9a-f]{40})'/)?.[1];
  check('⛔⛔ the page sends to the DERIVED vault, not a typo of it', vault === MOLI_RETURN_ADDRESS, vault);
  check('⛔ and the page names the real bMOLI', bmoli === BMOLI_CONTRACT, bmoli);
  check('the vault shown to readers is the same one', page.includes(`<dd id="vault">${MOLI_RETURN_ADDRESS}`));
}
check('⛔ the historical WSRO claim is sealed by position',
  HISTORICAL_INBOUND_POSITIONS.has(inboundPositionKey(1n, 25_882_760n, 291n)));

/* ------------------------------------------------- 2. the ledger alone */

console.log('\nthe outbound ledger');
{
  const l = new OutboundLedger();
  l.burn(ALICE, 10n);
  const linesBefore = JSON.stringify(l.rootLines());
  check('⛔ a ledger with burns and no returns hashes as it always did',
    !linesBefore.includes('molireturn'), linesBefore.slice(0, 80));
  const copy = l.clone();
  copy.recordReturn('0xaa', new Map([[ALICE, 4n]]));
  check('a clone shares nothing', l.returned === 0n && copy.returned === 4n);
  let threw = null;
  try { copy.recordReturn('0xbb', new Map([[ALICE, 7n]])); } catch (e) { threw = e; }
  check('⛔⛔ returned can never pass burned', threw !== null, threw?.message.slice(0, 80));
  threw = null;
  try { copy.recordReturn('0xaa', new Map([[ALICE, 1n]])); } catch (e) { threw = e; }
  check('⛔ the same key is honoured once', threw !== null);
  const back = OutboundLedger.fromJSON(JSON.parse(JSON.stringify(copy.toJSON())));
  check('it survives a save and load', JSON.stringify(back.rootLines()) === JSON.stringify(copy.rootLines()));
}

/* ------------------------------------------ 3. end to end, through consensus */

console.log('\nMOLI goes out, and comes back');

// Alice burns 10 MOLI to cross. The burn has been live since block 80,000.
await apply(tx(ALICE, encodeMoliBurn(ALICE, 10n * E18)), 100_000n);
check('10 MOLI went out', state.outbound.burned === 10n * E18);

const ETH_BLOCK = 26_100_000n;
const good = block(receipt([
  { contract: BMOLI_CONTRACT, from: ALICE, to: MOLI_RETURN_ADDRESS, amount: 4n * E18 },
]));

// ⛔ Below the flag day a return is ordinary data: what an old node does.
await apply(tx(AUTH, encodeHeaderCommit({ originChainId: 1n, blockNumber: ETH_BLOCK, receiptsRoot: good.root })), V2);
check('the header authority commits the Ethereum root', state.inbound.headerFor(1n, ETH_BLOCK)?.by === AUTH);

{
  const before = state.balanceOf(ALICE);
  const t = tx(MALLORY, encodeMoliReturn({ blockNumber: ETH_BLOCK, txIndex: 3n, proof: good.proof }));
  await apply(t, BEFORE);
  check('⛔ below the flag day a return moves nothing', state.balanceOf(ALICE) === before
    && state.outbound.returned === 0n, 'upgraded and old nodes agree on every block before it');
}

{
  const aliceBefore = state.balanceOf(ALICE);
  const malloryBefore = state.balanceOf(MALLORY);
  const t = tx(MALLORY, encodeMoliReturn({ blockNumber: ETH_BLOCK, txIndex: 3n, proof: good.proof }));
  await apply(t);
  check('⭐ at the flag day the return pays the SENDER', state.balanceOf(ALICE) === aliceBefore + 4n * E18,
    '4 MOLI to Alice');
  check('⛔ and not whoever relayed it', state.balanceOf(MALLORY) < malloryBefore,
    'Mallory paid the fee and received nothing');
  check('the ledger counts it', state.outbound.returned === 4n * E18
    && state.outbound.outstanding() === 6n * E18, '6 MOLI still outstanding');
  check('and the receipt is spent by position', state.outbound.returnKeys.has(returnKey(ETH_BLOCK, 3n)));
}

await refuses('⛔⛔ the same receipt cannot be returned twice',
  tx(ALICE, encodeMoliReturn({ blockNumber: ETH_BLOCK, txIndex: 3n, proof: good.proof })));

// More than went out, in a real receipt under a real root: still refused.
const greedy = block(receipt([
  { contract: BMOLI_CONTRACT, from: ALICE, to: MOLI_RETURN_ADDRESS, amount: 50n * E18 },
]));
await apply(tx(AUTH, encodeHeaderCommit({ originChainId: 1n, blockNumber: ETH_BLOCK + 1n, receiptsRoot: greedy.root })));
await refuses('⛔⛔ a return larger than what is outstanding is refused, even with a valid proof',
  tx(ALICE, encodeMoliReturn({ blockNumber: ETH_BLOCK + 1n, txIndex: 3n, proof: greedy.proof })));

const counterfeit = block(receipt([
  { contract: FAKE_BMOLI, from: MALLORY, to: MOLI_RETURN_ADDRESS, amount: 1n * E18 },
]));
await apply(tx(AUTH, encodeHeaderCommit({ originChainId: 1n, blockNumber: ETH_BLOCK + 2n, receiptsRoot: counterfeit.root })));
await refuses('⛔ a transfer of some OTHER token to the vault returns nothing',
  tx(MALLORY, encodeMoliReturn({ blockNumber: ETH_BLOCK + 2n, txIndex: 3n, proof: counterfeit.proof })));

const elsewhere = block(receipt([
  { contract: BMOLI_CONTRACT, from: MALLORY, to: '0x' + '77'.repeat(20), amount: 1n * E18 },
]));
await apply(tx(AUTH, encodeHeaderCommit({ originChainId: 1n, blockNumber: ETH_BLOCK + 3n, receiptsRoot: elsewhere.root })));
await refuses('⛔ bMOLI sent anywhere but the vault returns nothing',
  tx(MALLORY, encodeMoliReturn({ blockNumber: ETH_BLOCK + 3n, txIndex: 3n, proof: elsewhere.proof })));

const reverted = block(receipt([
  { contract: BMOLI_CONTRACT, from: ALICE, to: MOLI_RETURN_ADDRESS, amount: 1n * E18 },
], 0));
await apply(tx(AUTH, encodeHeaderCommit({ originChainId: 1n, blockNumber: ETH_BLOCK + 4n, receiptsRoot: reverted.root })));
await refuses('⛔ a REVERTED transfer returned nothing',
  tx(ALICE, encodeMoliReturn({ blockNumber: ETH_BLOCK + 4n, txIndex: 3n, proof: reverted.proof })));

await refuses('⛔ a return against a block nobody committed is refused',
  tx(ALICE, encodeMoliReturn({ blockNumber: ETH_BLOCK + 99n, txIndex: 3n, proof: good.proof })));

const tampered = good.proof.map((n) => n.slice());
tampered[tampered.length - 1][tampered[tampered.length - 1].length - 1] ^= 1;
await refuses('⛔ a tampered proof is refused',
  tx(ALICE, encodeMoliReturn({ blockNumber: ETH_BLOCK, txIndex: 3n, proof: tampered })));

{
  const batch = block(receipt([
    { contract: BMOLI_CONTRACT, from: ALICE, to: MOLI_RETURN_ADDRESS, amount: 1n * E18 },
    { contract: BMOLI_CONTRACT, from: AUTH, to: MOLI_RETURN_ADDRESS, amount: 2n * E18 },
  ]), 1, 4);
  await apply(tx(AUTH, encodeHeaderCommit({ originChainId: 1n, blockNumber: ETH_BLOCK + 5n, receiptsRoot: batch.root })));
  const a = state.balanceOf(ALICE);
  const o = state.balanceOf(AUTH);
  await apply(tx(MALLORY, encodeMoliReturn({ blockNumber: ETH_BLOCK + 5n, txIndex: 1n, proof: batch.proof })));
  check('a receipt with two senders pays each its own', state.balanceOf(ALICE) === a + 1n * E18
    && state.balanceOf(AUTH) === o + 2n * E18);
  check('and the bound counts both', state.outbound.returned === 7n * E18);
}

/* ------------------------------------------------ 4. the header authority */

console.log('\nwho may commit Ethereum headers');
await refuses('⛔⛔ from the flag day, nobody but the authority commits a chain-1 root',
  tx(MALLORY, encodeHeaderCommit({ originChainId: 1n, blockNumber: ETH_BLOCK + 50n, receiptsRoot: '0x' + '12'.repeat(32) })));

/* ------------------------------------------------ 5. the WSRO leg, fixed */

console.log('\nthe WSRO inbound leg');

const WSRO = '0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8';
const JUNK = '0x' + '66'.repeat(20);
const ctor = (bridge, sym) => word(0x60) + word(0xa0) + bridge.slice(2).padStart(64, '0')
  + word(sym.length) + Buffer.from(sym).toString('hex').padEnd(64, '0')
  + word(sym.length) + Buffer.from(sym).toString('hex').padEnd(64, '0');
async function deployAsset(from, bridge, sym) {
  const r = await runEvm(state, { from, to: null, data: ART.BridgedAsset.bytecode + ctor(bridge, sym), gasLimit: 6_000_000n });
  if (r.failed) throw new Error(`deploy failed: ${r.error}`);
  state.bumpNonce(from);
  return r.createdAddress;
}
const WSRO_ID = foreignTokenId(1n, WSRO);
const JUNK_ID = foreignTokenId(1n, JUNK);
const wsroAsset = await deployAsset(AUTH, bridgeAuthority(WSRO_ID), 'WSRO');
const junkAsset = await deployAsset(MALLORY, bridgeAuthority(JUNK_ID), 'JUNK');
await apply(tx(AUTH, encodeBridgeRegister({ originChainId: 1n, contract: WSRO, assetContract: wsroAsset, cap: 1000n * E18, symbol: 'WSRO' })), 1n);
await apply(tx(MALLORY, encodeBridgeRegister({ originChainId: 1n, contract: JUNK, assetContract: junkAsset, cap: 1n, symbol: 'JUNK' })), 1n);
check('Mallory registered a throwaway asset on chain 1', state.inbound.get(JUNK_ID).registrar === MALLORY,
  'which, before the fix, made Mallory a chain-1 header committer');

// A fabricated WSRO "burn" by Mallory, under a root only Mallory vouches for,
// committed while the old rules still held.
const ZERO = '0x0000000000000000000000000000000000000000';
const fake = block(receipt([{ contract: WSRO, from: MALLORY, to: ZERO, amount: 500n * E18 }]));
await apply(tx(MALLORY, encodeHeaderCommit({ originChainId: 1n, blockNumber: 30_000_000n, receiptsRoot: fake.root })), 1n);
await refuses('⛔⛔ a WSRO claim against a root the WSRO registrar never committed is refused',
  tx(MALLORY, encodeBridgeClaim({ tokenId: WSRO_ID, blockNumber: 30_000_000n, txIndex: 3, recipient: MALLORY,
    ethTxHash: '0x' + 'ab'.repeat(32), proof: fake.proof })));

// A real burn by Alice, under the authority's root.
const burn = block(receipt([{ contract: WSRO, from: ALICE, to: ZERO, amount: 5n * E18 }]));
await apply(tx(AUTH, encodeHeaderCommit({ originChainId: 1n, blockNumber: 30_000_001n, receiptsRoot: burn.root })));
const claimFor = (recipient, hash) => encodeBridgeClaim({ tokenId: WSRO_ID, blockNumber: 30_000_001n,
  txIndex: 3, recipient, ethTxHash: hash, proof: burn.proof });
await refuses('⛔⛔ a watcher cannot claim somebody else\'s burn for themselves',
  tx(MALLORY, claimFor(MALLORY, '0x' + '01'.repeat(32))));
await apply(tx(MALLORY, claimFor(ALICE, '0x' + '01'.repeat(32))));
check('the burn pays its burner, whoever relays it', state.inbound.get(WSRO_ID).minted === 5n * E18);
await refuses('⛔⛔ the same receipt under an INVENTED tx hash is refused',
  tx(ALICE, claimFor(ALICE, '0x' + '02'.repeat(32))));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
