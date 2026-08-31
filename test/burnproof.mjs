/**
 * Molibra - proving an Ethereum burn.
 *
 * The claim being tested is not "my trie code agrees with my trie code". It is
 * that this verifier agrees with ETHEREUM. So the fixture is a real mainnet
 * block: its receipts are rebuilt into a receipts trie here, and the root that
 * comes out must equal the `receiptsRoot` in the real block header. If the
 * encoding, the hex-prefix handling, the typed-receipt handling or the
 * inline-node rule were wrong, that root would differ and every check below
 * would be worthless.
 *
 * The trie BUILDER is test-only scaffolding. A node never builds an Ethereum
 * trie; it only ever checks a proof against a root somebody else published.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RLP } from '@ethereumjs/rlp';
import {
  verifyProof, decodeReceipt, findBurn, proveBurn, toNibbles, decodeHexPrefix,
  HeaderSource, TRANSFER_TOPIC, ProofError,
} from '../src/burnproof.js';
import { keccak256, toHex, fromHex } from '../src/crypto.js';
import { InboundLedger } from '../src/inbound.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

/* ------------------------------------------------------------------ */
/* A minimal Merkle-Patricia trie, for building fixtures only.         */
/* ------------------------------------------------------------------ */

const hexPrefix = (path, isLeaf) => {
  const odd = path.length % 2 === 1;
  const flag = (isLeaf ? 2 : 0) + (odd ? 1 : 0);
  const nibbles = odd ? [flag, ...path] : [flag, 0, ...path];
  const out = new Uint8Array(nibbles.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (nibbles[2 * i] << 4) | nibbles[2 * i + 1];
  return out;
};

const store = new Map(); // hash -> raw node, so a proof can be walked afterwards

/** A node's reference: inline when short, hashed when 32 bytes or more. */
function ref(node) {
  const raw = RLP.encode(node);
  if (raw.length < 32) return node;
  const h = keccak256(raw);
  store.set(toHex(h), raw);
  return h;
}

function build(entries) {
  if (entries.length === 0) return new Uint8Array(0);
  if (entries.length === 1) {
    const [path, value] = entries[0];
    return [hexPrefix(path, true), value];
  }
  // common prefix -> extension
  let common = 0;
  const first = entries[0][0];
  outer: while (common < first.length) {
    const n = first[common];
    for (const [p] of entries) { if (common >= p.length || p[common] !== n) break outer; }
    common++;
  }
  if (common > 0) {
    const child = build(entries.map(([p, v]) => [p.slice(common), v]));
    return [hexPrefix(first.slice(0, common), false), ref(child)];
  }
  const branch = new Array(17).fill(new Uint8Array(0));
  const buckets = new Map();
  for (const [p, v] of entries) {
    if (p.length === 0) { branch[16] = v; continue; }
    const k = p[0];
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push([p.slice(1), v]);
  }
  for (const [k, sub] of buckets) branch[k] = ref(build(sub));
  return branch;
}

function trieRoot(pairs) {
  store.clear();
  const entries = pairs.map(([key, value]) => [toNibbles(key), value]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const root = build(entries);
  const raw = RLP.encode(root);
  const h = keccak256(raw);
  store.set(toHex(h), raw);
  return toHex(h);
}

/** Collect the nodes along the path to `key`, root first. */
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

/* ------------------------------------------------------------------ */
/* 1. ⛔⛔ Agreement with Ethereum itself.                              */
/* ------------------------------------------------------------------ */

const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', 'eth-block.json'), 'utf8'));
const pairs = fixture.receipts.map((r, i) => [RLP.encode(i), fromHex(r)]);
const computed = trieRoot(pairs);

check('⛔⛔ the rebuilt receipts trie reproduces the REAL mainnet receiptsRoot',
  computed === fixture.receiptsRoot.toLowerCase(),
  `block ${fixture.number}, ${fixture.receipts.length} receipts`);
check('  (if that failed nothing else here means anything)',
  computed === fixture.receiptsRoot.toLowerCase(), computed);

/* ------------------------------------------------------------------ */
/* 2. Proving a receipt is in that block.                              */
/* ------------------------------------------------------------------ */

const idx = fixture.proveIndex;
const key = RLP.encode(idx);
const proof = proofFor(computed, key);
const value = verifyProof(computed, key, proof);
check('a receipt in the block is proved against the real root',
  toHex(value) === fixture.receipts[idx].toLowerCase(), `tx index ${idx}`);

const receipt = decodeReceipt(value);
check('the receipt decodes', typeof receipt.status === 'number', `type ${receipt.type}, ${receipt.logs.length} logs`);
check('a typed (EIP-2718) receipt is not fed whole to an RLP decoder',
  receipt.type === fixture.expectedType, `type ${receipt.type}`);

/* ------------------------------------------------------------------ */
/* 3. ⛔ Refusal. A verifier that bends is not a verifier.              */
/* ------------------------------------------------------------------ */

function refuses(label, fn, detail = '') {
  let threw = false;
  try { fn(); } catch (e) { threw = e instanceof ProofError; }
  check(label, threw, detail);
}

refuses('⛔ a proof against the WRONG root is refused',
  () => verifyProof('0x' + '11'.repeat(32), key, proof), 'the root is the whole anchor');

refuses('⛔ a proof with a tampered node is refused', () => {
  const bad = proof.map((n) => n.slice());
  bad[bad.length - 1][5] ^= 0xff;
  verifyProof(computed, key, bad);
}, 'every node is checked by its own hash');

refuses('⛔ an empty proof is refused rather than treated as vacuously true',
  () => verifyProof(computed, key, []));

refuses('⛔ a truncated proof is refused', () => verifyProof(computed, key, proof.slice(0, 1)));

refuses('⛔ a proof for one key does not prove another',
  () => verifyProof(computed, RLP.encode(idx === 0 ? 1 : 0), proof));

/* ------------------------------------------------------------------ */
/* 4. Reading the burn - and refusing things that are not one.         */
/* ------------------------------------------------------------------ */

const CONTRACT = '0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8'; // WSRO
const HOLDER = '0x1111111111111111111111111111111111111111';
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrTopic = (a) => '0x' + a.slice(2).padStart(64, '0');

const burnLog = (to, amount, contract = CONTRACT) => ({
  address: contract,
  topics: [TRANSFER_TOPIC, addrTopic(HOLDER), addrTopic(to)],
  data: '0x' + word(amount),
});
const asReceipt = (logs, status = 1) => ({ type: 2, status, cumulativeGasUsed: 0n, logsBloom: '0x', logs });

const ZERO = '0x0000000000000000000000000000000000000000';
const good = asReceipt([burnLog(ZERO, 5000n)]);
check('a Transfer to the zero address is a burn',
  findBurn(good, { contract: CONTRACT }).amount === 5000n);
check('and it records who burned it', findBurn(good, { contract: CONTRACT }).from === HOLDER);

function refusesBurn(label, receiptObj, detail = '') {
  let threw = false;
  try { findBurn(receiptObj, { contract: CONTRACT }); } catch { threw = true; }
  check(label, threw, detail);
}

refusesBurn('⛔⛔ a burn of a DIFFERENT contract is refused',
  asReceipt([burnLog(ZERO, 10n ** 24n, '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')]),
  'otherwise anyone deploys a token, burns a billion, and proves it perfectly');
refusesBurn('⛔ an ordinary transfer is not a burn',
  asReceipt([burnLog('0x2222222222222222222222222222222222222222', 5000n)]),
  'only the zero address destroys');
refusesBurn('⛔ a burn in a REVERTED transaction destroyed nothing',
  asReceipt([burnLog(ZERO, 5000n)], 0));
refusesBurn('⛔ a receipt with no Transfer at all', asReceipt([]));
refusesBurn('⛔ a zero-value burn', asReceipt([burnLog(ZERO, 0n)]));

/* ------------------------------------------------------------------ */
/* 5. The trust model is stated, not assumed.                          */
/* ------------------------------------------------------------------ */

const source = new HeaderSource('checkpoint', { 100: '0x' + 'ab'.repeat(32) });
const d = source.describe();
check('a header source says what it is', d.kind === 'checkpoint');
check('and separates what is proved from what is trusted',
  d.trustless.includes('receiptsRoot') && d.trusted.includes('canonical'));
check('a light client would trust nothing beyond Ethereum consensus',
  new HeaderSource('light-client').describe().trusted.includes('Ethereum consensus'));
check('an unknown kind of header source is refused', (() => {
  try { new HeaderSource('vibes'); return false; } catch { return true; }
})());
check('a header it does not carry has no root', source.receiptsRootFor(999) === null);

/* ------------------------------------------------------------------ */
/* 6. ⛔ Proof and permission are SEPARATE, and both are required.      */
/* ------------------------------------------------------------------ */

const ledger = new InboundLedger();
const record = {
  kind: 'asset', symbol: 'WSRO', decimals: 18,
  origin: { chainId: 1, contract: CONTRACT, decimals: 18 },
};
const asset = ledger.register(record, 10n ** 21n).id;

const proved = { ethTxHash: '0x' + 'aa'.repeat(32), amount: 5000n, recipient: HOLDER };
ledger.claim({ tokenId: asset, ...proved });
check('a proved burn can be honoured once', ledger.report(asset).minted === '5000');

let twice = false;
try { ledger.claim({ tokenId: asset, ...proved }); } catch { twice = true; }
check('⛔ and only once, however it was proved', twice,
  'the proof says it happened; the ledger says it may be paid exactly once');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
