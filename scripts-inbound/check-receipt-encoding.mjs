/**
 * Does our receipt encoding agree with Ethereum? Rebuild the receipts trie for
 * real mainnet blocks and compare the root against the real header.
 *
 * ⛔ This is the single check the whole inbound path rests on. If the encoding
 * is wrong by one byte the root differs, and every claim is refused on chain
 * with a proof error nobody can explain.
 */
import { RLP } from '@ethereumjs/rlp';
import { keccak256, toHex, fromHex } from '../src/crypto.js';
import { toNibbles } from '../src/burnproof.js';

const ETH_RPC = process.env.ETH_RPC ?? 'https://ethereum-rpc.publicnode.com';
const rpc = async (m, p = []) => {
  const r = await fetch(ETH_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${m}: ${j.error.message}`);
  return j.result;
};

function minimal(q) {
  let h = String(q).replace(/^0x/, '').replace(/^0+/, '');
  if (h === '') return new Uint8Array(0);
  if (h.length % 2) h = '0' + h;
  return fromHex('0x' + h);
}
function encodeReceipt(r) {
  const type = Number(r.type ?? '0x0');
  const body = RLP.encode([
    r.status === '0x1' ? new Uint8Array([1]) : new Uint8Array(0),
    minimal(r.cumulativeGasUsed),
    fromHex(r.logsBloom),
    r.logs.map((l) => [fromHex(l.address), l.topics.map((t) => fromHex(t)), fromHex(l.data)]),
  ]);
  if (type === 0) return body;
  const out = new Uint8Array(body.length + 1);
  out[0] = type; out.set(body, 1);
  return out;
}

const hexPrefix = (path, isLeaf) => {
  const odd = path.length % 2 === 1;
  const flag = (isLeaf ? 2 : 0) + (odd ? 1 : 0);
  const nib = odd ? [flag, ...path] : [flag, 0, ...path];
  const out = new Uint8Array(nib.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (nib[2 * i] << 4) | nib[2 * i + 1];
  return out;
};
const ref = (node) => {
  const raw = RLP.encode(node);
  return raw.length < 32 ? node : keccak256(raw);
};
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
const trieRoot = (pairs) => {
  const e = pairs.map(([k, v]) => [toNibbles(k), v]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return toHex(keccak256(RLP.encode(build(e))));
};

const latest = parseInt(await rpc('eth_blockNumber'), 16);
const blocks = process.argv.slice(2).map(Number);
const targets = blocks.length ? blocks : [latest - 3, latest - 40, latest - 400, 25878103, 21000000];

let ok = 0; let bad = 0;
for (const n of targets) {
  try {
    const tag = '0x' + n.toString(16);
    const [block, receipts] = await Promise.all([
      rpc('eth_getBlockByNumber', [tag, false]),
      rpc('eth_getBlockReceipts', [tag]),
    ]);
    if (!receipts?.length) { console.log(`  block ${n}: no receipts, skipped`); continue; }
    const computed = trieRoot(receipts.map((r, i) => [RLP.encode(i), encodeReceipt(r)]));
    const declared = String(block.receiptsRoot).toLowerCase();
    const types = [...new Set(receipts.map((r) => Number(r.type ?? 0)))].sort().join(',');
    if (computed === declared) { ok++; console.log(`  PASS  block ${n}  ${receipts.length} receipts, types {${types}}`); }
    else { bad++; console.log(`  FAIL  block ${n}\n        rebuilt  ${computed}\n        header   ${declared}`); }
  } catch (e) { console.log(`  block ${n}: ${e.message}`); }
}
console.log(`\n${ok} block(s) reproduced Ethereum's receiptsRoot, ${bad} failed`);
process.exit(bad ? 1 : 0);
