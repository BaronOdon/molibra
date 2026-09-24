/**
 * Molibra - building an Ethereum receipt proof. CLAIMANT-SIDE ONLY.
 *
 * ⚠ Consensus never builds an Ethereum trie; it only checks a proof against a
 * root somebody committed (src/burnproof.js). This is the other end: given a
 * mined Ethereum transaction, fetch every receipt in its block, rebuild the
 * receipts trie, and REFUSE unless the rebuilt root equals the real header's.
 * A proof emitted without that check is a proof that fails under the
 * operator's cursor, after the ETH or the MOLI is already committed.
 *
 * Moved here from scripts-inbound/prove-burn.mjs on 24 Sep 2026 so the WSRO
 * script, the MOLI return script and the node's /molibra/return route share
 * one encoder rather than three copies that can drift.
 */

import { RLP } from '@ethereumjs/rlp';
import { keccak256, toHex, fromHex } from './crypto.js';
import { toNibbles, decodeHexPrefix } from './burnproof.js';

/**
 * Encode a receipt exactly as Ethereum does, or the trie root will not match.
 *
 * ⛔ Three details, each of which silently breaks the root if wrong:
 *   - a TYPED receipt is `type || rlp([...])`, NOT rlp of anything;
 *   - `status` is 0x01 or the EMPTY string, never 0x00;
 *   - every quantity is minimally encoded - no leading zero bytes.
 */
export function encodeReceipt(r) {
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

const hexPrefix = (path, isLeaf) => {
  const odd = path.length % 2 === 1;
  const flag = (isLeaf ? 2 : 0) + (odd ? 1 : 0);
  const nibbles = odd ? [flag, ...path] : [flag, 0, ...path];
  const out = new Uint8Array(nibbles.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (nibbles[2 * i] << 4) | nibbles[2 * i + 1];
  return out;
};

/** Build a trie over `[keyBytes, valueBytes]` pairs; returns its root and a prover. */
export function buildTrie(pairs) {
  const store = new Map();
  const ref = (node) => {
    const raw = RLP.encode(node);
    if (raw.length < 32) return node;      // ⛔ short nodes are INLINE, not hashed
    const h = keccak256(raw);
    store.set(toHex(h), raw);
    return h;
  };
  const build = (entries) => {
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
  };
  const entries = pairs.map(([k, v]) => [toNibbles(k), v]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const raw = RLP.encode(build(entries));
  const root = toHex(keccak256(raw));
  store.set(root, raw);

  const proofFor = (key) => {
    const path = toNibbles(key);
    const nodes = [];
    let expected = root;
    let i = 0;
    for (;;) {
      const node = store.get(expected);
      if (!node) return nodes;
      nodes.push(node);
      const d = RLP.decode(node);
      if (d.length === 17) {
        if (i === path.length) return nodes;
        const next = d[path[i]]; i++;
        if (!next || next.length === 0) return nodes;
        expected = toHex(next);
      } else {
        const { isLeaf, path: seg } = decodeHexPrefix(d[0]);
        i += seg.length;
        if (isLeaf) return nodes;
        expected = toHex(d[1]);
      }
    }
  };
  return { root, proofFor };
}

/**
 * An Ethereum JSON-RPC caller that survives public endpoints.
 *
 * ⛔ Public RPCs are load-balanced across backends, and some answer `null`
 * for a receipt that exists (seen 24 Sep 2026 on publicnode: curl got the
 * receipt, the next fetch got null). A null here is retried on the next
 * endpoint, never taken as "not mined".
 */
export function ethRpc(urls = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth']) {
  const list = [urls].flat().filter(Boolean);
  return async (method, params = []) => {
    let last;
    for (let attempt = 0; attempt < list.length * 2; attempt++) {
      const url = list[attempt % list.length];
      try {
        const r = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(20_000),
        });
        const j = await r.json();
        if (j.error) throw new Error(`${method}: ${j.error.message}`);
        if (j.result !== null && j.result !== undefined) return j.result;
        last = new Error(`${method}: null from ${url}`);
      } catch (e) { last = e; }
    }
    throw last;
  };
}

/**
 * Everything needed to prove one mined Ethereum transaction's receipt.
 * Throws unless the rebuilt receiptsRoot equals the real header's.
 *
 * @param {(method: string, params: any[]) => Promise<any>} rpc  an Ethereum JSON-RPC caller
 */
export async function receiptProof(rpc, ethTxHash) {
  const receipt = await rpc('eth_getTransactionReceipt', [ethTxHash]);
  if (!receipt) throw new Error('no receipt: is the transaction mined?');
  if (receipt.status !== '0x1') throw new Error('that transaction FAILED on Ethereum: it moved nothing');
  const blockNumber = BigInt(receipt.blockNumber);
  const txIndex = BigInt(receipt.transactionIndex);
  const [block, receipts] = await Promise.all([
    rpc('eth_getBlockByNumber', [receipt.blockNumber, false]),
    rpc('eth_getBlockReceipts', [receipt.blockNumber]),
  ]);
  const trie = buildTrie(receipts.map((r, i) => [RLP.encode(i), encodeReceipt(r)]));
  const declared = String(block.receiptsRoot).toLowerCase();
  if (trie.root !== declared) {
    throw new Error(`rebuilt receiptsRoot ${trie.root} does not match the block's ${declared}: `
      + 'the receipt encoding is wrong, and a proof against it would be refused on chain');
  }
  return {
    blockNumber, txIndex, receiptsRoot: declared, blockHash: block.hash,
    proof: trie.proofFor(RLP.encode(Number(txIndex))),
  };
}
