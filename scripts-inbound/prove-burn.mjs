/**
 * Molibra - build a REAL inbound proof from a REAL Ethereum burn.
 *
 * Given the Ethereum transaction hash of a WSRO burn, this produces the two
 * payloads Molibra needs to mint against it:
 *
 *     HEADER_COMMIT   the block's receiptsRoot, attested by the registrar
 *     BRIDGE_CLAIM    the Merkle-Patricia proof of the burn receipt
 *
 * ## ⛔⛔ It verifies before it emits
 *
 * The receipts trie is rebuilt from every receipt in the block and its root is
 * checked against the `receiptsRoot` in the real Ethereum header. If those
 * differ, the receipt encoding is wrong and the proof would be refused on
 * chain - so it stops here rather than producing a payload that fails under
 * the operator's cursor. Then `proveBurn` is run locally against the produced
 * proof, so what is emitted has already been verified by the exact code
 * consensus will run.
 *
 * ⚠ A node never builds an Ethereum trie. It only ever checks a proof against
 * a root somebody published. This builder is claimant-side tooling.
 *
 *   node scripts-inbound/prove-burn.mjs <ethTxHash> [recipientOnMolibra]
 */

import { RLP } from '@ethereumjs/rlp';

import { keccak256, toHex, fromHex, normalizeAddress } from '../src/crypto.js';
import { proveBurn, toNibbles, decodeHexPrefix, TRANSFER_TOPIC } from '../src/burnproof.js';
import { foreignTokenId } from '../src/foreign.js';
import {
  bridgeAuthority, encodeHeaderCommit, encodeBridgeClaim, encodeBridgeRegister,
} from '../src/bridgemint.js';

const ETH_RPC = process.env.ETH_RPC ?? 'https://ethereum-rpc.publicnode.com';
const WSRO = '0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8';
const ETH_CHAIN = 1n;

const TX = process.argv[2];
const RECIPIENT = process.argv[3] ?? null;
if (!/^0x[0-9a-fA-F]{64}$/.test(TX ?? '')) {
  console.error('usage: node scripts-inbound/prove-burn.mjs <ethTxHash> [recipientOnMolibra]');
  process.exit(2);
}

const rpc = async (method, params = []) => {
  const r = await fetch(ETH_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};

/* ------------------------------------------------------- receipt encoding */

/**
 * Encode a receipt exactly as Ethereum does, or the trie root will not match.
 *
 * ⛔ Three details, each of which silently breaks the root if wrong:
 *   - a TYPED receipt is `type || rlp([...])`, NOT rlp of anything;
 *   - `status` is 0x01 or the EMPTY string, never 0x00;
 *   - every quantity is minimally encoded - no leading zero bytes.
 */
function encodeReceipt(r) {
  const type = Number(r.type ?? '0x0');
  const status = r.status === '0x1' ? new Uint8Array([1]) : new Uint8Array(0);
  const body = RLP.encode([
    status,
    minimal(r.cumulativeGasUsed),
    fromHex(r.logsBloom),
    r.logs.map((l) => [fromHex(l.address), l.topics.map((t) => fromHex(t)), fromHex(l.data)]),
  ]);
  if (type === 0) return body;
  const out = new Uint8Array(body.length + 1);
  out[0] = type;
  out.set(body, 1);
  return out;
}

/** A 0x quantity as minimally-encoded bytes: 0 is the empty string. */
function minimal(q) {
  let h = String(q).replace(/^0x/, '').replace(/^0+/, '');
  if (h === '') return new Uint8Array(0);
  if (h.length % 2) h = '0' + h;
  return fromHex('0x' + h);
}

/* ------------------------------------------------------------ trie build */

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
  if (raw.length < 32) return node;      // ⛔ short nodes are INLINE, not hashed
  const h = keccak256(raw);
  store.set(toHex(h), raw);
  return h;
}
function build(entries) {
  if (entries.length === 1) {
    const [path, value] = entries[0];
    return [hexPrefix(path, true), value];
  }
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
    if (!buckets.has(p[0])) buckets.set(p[0], []);
    buckets.get(p[0]).push([p.slice(1), v]);
  }
  for (const [k, sub] of buckets) branch[k] = ref(build(sub));
  return branch;
}
function trieRoot(pairs) {
  const entries = pairs.map(([k, v]) => [toNibbles(k), v]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const root = build(entries);
  const raw = RLP.encode(root);
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

/* ------------------------------------------------------------------ run */

console.log('Molibra inbound - proving an Ethereum burn\n');

const receipt = await rpc('eth_getTransactionReceipt', [TX]);
if (!receipt) throw new Error('no receipt: is the transaction mined?');
if (receipt.status !== '0x1') throw new Error('that transaction FAILED — a reverted burn destroyed nothing');
const blockNumber = BigInt(receipt.blockNumber);
const txIndex = Number(BigInt(receipt.transactionIndex));

const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
const receipts = await rpc('eth_getBlockReceipts', [receipt.blockNumber]);
console.log(`block        ${blockNumber}  (${receipts.length} receipts, ours at index ${txIndex})`);

// ⛔⛔ Rebuild the trie and check it against the REAL header before anything else.
store.clear();
const computed = trieRoot(receipts.map((r, i) => [RLP.encode(i), encodeReceipt(r)]));
const declared = String(block.receiptsRoot).toLowerCase();
console.log(`receiptsRoot rebuilt  ${computed}`);
console.log(`             header   ${declared}`);
if (computed !== declared) {
  console.error('\n⛔⛔ REBUILT ROOT DOES NOT MATCH THE BLOCK. The receipt encoding is wrong;');
  console.error('    a proof against this would be refused on chain. Stopping.');
  process.exit(1);
}
console.log('             ⭐ MATCH — the encoding agrees with Ethereum\n');

const key = RLP.encode(txIndex);
const proof = proofFor(computed, key);

// Run the consensus verifier over what we are about to emit.
const proved = proveBurn({
  receiptsRoot: computed,
  txIndex,
  proof,
  contract: WSRO,
  ethTxHash: TX,
  recipient: RECIPIENT ?? undefined,
});
console.log('burn proved by the same code consensus runs:');
console.log('  burnedBy   ', proved.burnedBy);
console.log('  amount     ', proved.amount.toString(), '=', (Number(proved.amount) / 1e18).toLocaleString(), 'WSRO');
console.log('  recipient  ', proved.recipient, RECIPIENT ? '(named)' : '(defaults to the burner)');
console.log('  proof      ', proof.length, 'node(s)\n');

const tokenId = foreignTokenId(ETH_CHAIN, WSRO);

console.log('=== 1. BRIDGE_REGISTER — once per asset, by the header authority ===');
console.log(encodeBridgeRegister({
  originChainId: ETH_CHAIN,
  contract: WSRO,
  assetContract: '0x' + '11'.repeat(20),   // ⛔ replace with the deployed BridgedAsset
  cap: 1_000_000n * 10n ** 18n,
  symbol: 'WSRO',
}));
console.log('   ⛔ assetContract above is a PLACEHOLDER — deploy BridgedAsset first, with');
console.log('      constructor bridge_ =', bridgeAuthority(tokenId), '(keyless)\n');

console.log('=== 2. HEADER_COMMIT — the trusted half, on the record ===');
console.log(encodeHeaderCommit({
  originChainId: ETH_CHAIN, blockNumber, receiptsRoot: computed,
}));
console.log();

console.log('=== 3. BRIDGE_CLAIM — the trustless half ===');
const claim = encodeBridgeClaim({
  tokenId, blockNumber, txIndex, recipient: proved.recipient, ethTxHash: TX, proof,
});
console.log(claim);
console.log(`\n   (${(claim.length - 2) / 2} bytes)`);

console.log('\nsummary');
console.log('  Molibra token id :', tokenId);
console.log('  mint authority   :', bridgeAuthority(tokenId));
console.log('  will mint        :', (Number(proved.amount) / 1e18).toLocaleString(), 'WSRO to', proved.recipient);
