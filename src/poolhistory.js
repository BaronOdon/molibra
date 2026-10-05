/**
 * The trade history of a MolibraPool, read out of the node's own receipts.
 *
 * The node has no eth_getLogs, and a browser scanning /molibra/blocks from the
 * pool's creation would walk hundreds of 512-block pages to find a handful of
 * transactions. Every canonical receipt is already in memory (chain.receipts),
 * so the node answers the one question a price chart asks - "what did this
 * pool do, and what were its reserves after each step" - in one pass, cached
 * until the head moves.
 *
 * ⛔ Read-only. It decodes the pool's own Minted / Burned / Swapped events and
 * replays the reserves the way MolibraPool.sol moves them (reserves live in
 * storage, so a plain token transfer into the pool never moves the price).
 * The replayed reserves after the last event must equal reserves() on the
 * live contract; the page checks that and says so if they differ.
 */

import { keccak256, toHex } from './crypto.js';

const kec = (s) => toHex(keccak256(new TextEncoder().encode(s)));

/** MolibraPool.sol's events, by their keccak topic. */
export const POOL_EVENTS = {
  Minted: kec('Minted(address,uint256,uint256,uint256)'),
  Burned: kec('Burned(address,uint256,uint256,uint256)'),
  Swapped: kec('Swapped(address,bool,uint256,uint256)'),
};

/** At most this many events are returned (the most recent); `total` says how many there were. */
export const MAX_POOL_EVENTS = 2000;

const words = (data) => {
  const h = String(data || '0x').replace(/^0x/, '');
  const out = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(BigInt('0x' + h.slice(i, i + 64)));
  return out;
};
const topicAddr = (t) => '0x' + String(t).slice(-40).toLowerCase();

/**
 * Decode and replay. `receipts` is any iterable of node receipts
 * ({blockNumber, transactionIndex, transactionHash, status, logs}), `timeOf(n)`
 * the timestamp of block n (seconds), `pool` a lowercase 0x address.
 */
export function poolHistory(receipts, timeOf, pool) {
  const want = String(pool).toLowerCase();
  const found = [];
  for (const r of receipts) {
    if (!r || !r.logs || !r.logs.length) continue;
    if (r.status !== undefined && BigInt(r.status) !== 1n) continue;
    r.logs.forEach((l, logIndex) => {
      if (String(l.address).toLowerCase() !== want || !l.topics || !l.topics.length) return;
      const t0 = String(l.topics[0]).toLowerCase();
      const w = words(l.data);
      const base = {
        block: Number(r.blockNumber), txIndex: Number(r.transactionIndex ?? 0), logIndex,
        tx: r.transactionHash, by: l.topics[1] ? topicAddr(l.topics[1]) : null,
      };
      if (t0 === POOL_EVENTS.Swapped && w.length >= 3) {
        found.push({ ...base, kind: 'swap', moliIn: w[0] !== 0n, amountIn: w[1], amountOut: w[2] });
      } else if (t0 === POOL_EVENTS.Minted && w.length >= 3) {
        found.push({ ...base, kind: 'mint', moli: w[0], tokens: w[1], shares: w[2] });
      } else if (t0 === POOL_EVENTS.Burned && w.length >= 3) {
        found.push({ ...base, kind: 'burn', moli: w[0], tokens: w[1], shares: w[2] });
      }
    });
  }
  found.sort((a, b) => a.block - b.block || a.txIndex - b.txIndex || a.logIndex - b.logIndex);

  let rM = 0n; let rT = 0n;
  const events = found.map((e) => {
    if (e.kind === 'mint') { rM += e.moli; rT += e.tokens; }
    else if (e.kind === 'burn') { rM -= e.moli; rT -= e.tokens; }
    else if (e.moliIn) { rM += e.amountIn; rT -= e.amountOut; }
    else { rT += e.amountIn; rM -= e.amountOut; }
    const out = { block: e.block, time: Number(timeOf(e.block) ?? 0), tx: e.tx, kind: e.kind, by: e.by,
      reserveMoli: rM.toString(), reserveToken: rT.toString() };
    if (e.kind === 'swap') Object.assign(out, { moliIn: e.moliIn, amountIn: e.amountIn.toString(), amountOut: e.amountOut.toString() });
    else Object.assign(out, { moli: e.moli.toString(), tokens: e.tokens.toString() });
    return out;
  });
  return {
    pool: want,
    total: events.length,
    swaps: events.filter((e) => e.kind === 'swap').length,
    events: events.slice(-MAX_POOL_EVENTS),
  };
}

/** One cached answer per pool, recomputed only when the head changes. */
export function poolHistoryCache() {
  const cache = new Map();
  return (chain, pool) => {
    const key = String(pool).toLowerCase();
    const head = chain.head ? chain.head.hash : null;
    const hit = cache.get(key);
    if (hit && hit.head === head) return hit.value;
    const timeOf = (n) => { const b = chain.blockByNumber(n); return b ? Number(b.header.timestamp) : 0; };
    const value = { ...poolHistory(chain.receipts.values(), timeOf, key), height: Number(chain.height), head };
    if (cache.size > 32) cache.clear();
    cache.set(key, { head, value });
    return value;
  };
}
