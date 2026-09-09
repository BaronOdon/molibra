/**
 * Read Ethereum anchors, write them to a file the node reads.
 *
 *   node anchor-poller.mjs --datadir /var/lib/molibra [--rpc URL] [--once]
 *
 * ## ⛔⛔ Why this is a separate process
 *
 * The node mines. Mining blocks the event loop for longer than undici's
 * internal connect timeout (10s, and NOT reachable through the fetch API), so
 * every in-process poll died with `fetch failed <- ETIMEDOUT` while curl on the
 * same host answered in 60ms. Raising AbortSignal.timeout could not help: that
 * signal never fired, undici's own timer did.
 *
 * A node that mines cannot reliably make outbound HTTP. So it does not: this
 * process does the network, writes `anchors.json`, and the node reads a file.
 * That also matches how src/anchor.js was designed - a network-free rule with
 * the reading kept somewhere else.
 *
 * ## ⛔ It only ever appends what it has actually read
 *
 * A failed poll leaves the file untouched. The node's floor then holds where it
 * was rather than moving on a guess, which is the same discipline the in-process
 * version had and the reason a failure here is safe.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, toHex } from './src/crypto.js';

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) =>
  a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') === false ? all[i + 1] : true]] : []));

const RPC = args.rpc ?? 'https://ethereum-rpc.publicnode.com';
const CONTRACT = (args.contract ?? '0x2beba454d810eac41c6778e351f81d37a07ae03b').toLowerCase();
const DATADIR = args.datadir ?? './data';
const OUT = join(DATADIR, 'anchors.json');
const EVERY = Number(args.every ?? 300) * 1000;

const sel = (sig) => toHex(keccak256(new TextEncoder().encode(sig))).slice(0, 10);
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const SEL = {
  anchorCount: sel('anchorCount()'),
  heights: sel('heights(uint256)'),
  anchors: sel('anchors(uint256)'),
};

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
  return j.result;
}
const call = (data) => rpc('eth_call', [{ to: CONTRACT, data }, 'latest']);
const callUint = async (data) => {
  const v = await call(data);
  return v && v !== '0x' ? BigInt(v) : 0n;
};

async function poll() {
  const ethHead = BigInt(await rpc('eth_blockNumber', []));
  const count = await callUint(SEL.anchorCount);
  const anchors = [];
  for (let i = 0n; i < count; i++) {
    const height = await callUint(SEL.heights + word(i));
    const w = String(await call(SEL.anchors + word(height))).replace(/^0x/, '').match(/.{64}/g) ?? [];
    if (w.length < 4) continue;
    anchors.push({
      height: height.toString(),
      blockHash: '0x' + w[0],
      cumulativeWork: BigInt('0x' + w[1]).toString(),
      ethBlock: BigInt('0x' + w[2]).toString(),
      publisher: '0x' + w[3].slice(24),
    });
  }

  // ⛔ Written via a temp file and renamed. The node reads this on a timer; a
  //    half-written JSON would be read as corrupt exactly once and then cached
  //    as "no anchors", which silently removes the floor.
  const body = JSON.stringify({
    ethHead: ethHead.toString(), contract: CONTRACT,
    readAt: new Date().toISOString(), anchors,
  }, null, 2);
  writeFileSync(OUT + '.tmp', body, 'utf8');
  renameSync(OUT + '.tmp', OUT);
  return { ethHead, count: anchors.length };
}

async function tick() {
  try {
    const { ethHead, count } = await poll();
    console.log(`[anchor-poller] eth ${ethHead}, ${count} anchor(s) -> ${OUT}`);
  } catch (error) {
    // Unwrap undici's "fetch failed", which hides the reason in error.cause.
    const parts = [error.message];
    for (let c = error.cause; c; c = c.cause) parts.push(c.code ?? c.message);
    console.warn(`[anchor-poller] ${parts.filter(Boolean).join(' <- ')} - file left untouched`);
  }
}

await tick();
if (!args.once) setInterval(tick, EVERY);
