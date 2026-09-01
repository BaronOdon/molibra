/**
 * Molibra - run the anchor watcher against the live chains.
 *
 *   node scripts-watch/watch.mjs                 # one pass, exit code says the worst finding
 *   node scripts-watch/watch.mjs --loop 300      # keep looking, every 300s
 *
 * ⛔ It holds no key and sends nothing. Exit codes are the interface, so cron
 * or systemd can alert on them without parsing text:
 *
 *     0  everything agrees
 *     2  the chain is stale, or an anchor names a height we do not have
 *     3  ⛔⛔ an anchored hash does NOT match this chain
 *
 * Environment: MOLIBRA_NODE, ETH_RPC, ANCHOR_ADDRESS override the defaults.
 */

import { review } from '../src/watch.js';

/** Getters on MolibraAnchor. Verified against keccak by test/watch.mjs. */
const SEL = {
  anchorCount: '0x34f96c8c',   // anchorCount()
  heights:     '0xad9e0fdd',   // heights(uint256)
  anchors:     '0x368b733e',   // anchors(uint256)
};

const NODE = process.env.MOLIBRA_NODE ?? 'http://193.123.191.142:8545';
const ETH_RPC = process.env.ETH_RPC ?? 'https://ethereum-rpc.publicnode.com';
const ANCHOR = (process.env.ANCHOR_ADDRESS ?? '0x2beba454d810eac41c6778e351f81d37a07ae03b').toLowerCase();

const loopArg = process.argv.indexOf('--loop');
const loopSeconds = loopArg === -1 ? null : Number(process.argv[loopArg + 1] ?? 300);

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const call = (data) => rpc(ETH_RPC, 'eth_call', [{ to: ANCHOR, data }, 'latest']);

/**
 * Every anchor, read out of CONTRACT STATE rather than scanned from logs.
 *
 * ⛔ The first version filtered `eth_getLogs` from block 0 and was refused:
 * "Archive requests require a personal token." A watcher that only works
 * against a paid archive node is a watcher that stops working the day the key
 * lapses - silently, because an RPC error and "no anchors" look similar in a
 * log file. `heights` is a public array and `anchors` a public mapping, so the
 * whole set is readable from the latest state by any RPC, free, forever.
 */
async function readAnchors() {
  const n = BigInt(await call(SEL.anchorCount));
  const out = [];
  for (let i = 0n; i < n; i++) {
    const height = BigInt(await call(SEL.heights + word(i)));
    const raw = (await call(SEL.anchors + word(height))).replace(/^0x/, '');
    // Anchor { bytes32 blockHash; uint256 cumulativeWork; uint256 ethBlock; address publisher }
    out.push({
      height,
      blockHash: '0x' + raw.slice(0, 64),
      cumulativeWork: BigInt('0x' + raw.slice(64, 128)),
      ethBlock: BigInt('0x' + raw.slice(128, 192)),
      publisher: '0x' + raw.slice(192 + 24, 256),
    });
  }
  return out;
}

/**
 * ⛔ Asks the node for the block at a height and returns its hash, or null.
 *
 * Uses the audit route rather than eth_getBlockByNumber so a node that is
 * replaying - and therefore not yet serving RPC - fails loudly here instead of
 * quietly answering for a height it has not reached.
 */
async function chainHashFetcher() {
  const cache = new Map();
  return async (height) => {
    if (cache.has(height)) return cache.get(height);
    try {
      const r = await fetch(`${NODE}/molibra/block/${height}?decoded=1`);
      if (!r.ok) { cache.set(height, null); return null; }
      const j = await r.json();
      const h = j?.hash ?? null;
      cache.set(height, h);
      return h;
    } catch { cache.set(height, null); return null; }
  };
}

let previousHeight = null;
let previousAt = null;

async function pass() {
  const head = await (await fetch(`${NODE}/molibra`)).json();
  const height = BigInt(head.height);
  const now = Date.now() / 1000;

  const anchors = await readAnchors();
  const fetchHash = await chainHashFetcher();

  // Resolve every height the anchors name, before the pure review runs.
  const resolved = new Map();
  for (const a of anchors) resolved.set(a.height, await fetchHash(a.height));

  const result = review({
    anchors,
    chainHashAt: (h) => (resolved.has(h) ? resolved.get(h) : null),
    liveness: {
      height, previousHeight,
      secondsSince: previousAt === null ? 0 : now - previousAt,
    },
  });

  previousHeight = height;
  previousAt = now;

  const stamp = new Date().toISOString();
  if (result.findings.length === 0) {
    console.log(`${stamp}  ok — ${result.checked} anchor(s) agree, chain at ${height}`);
  } else {
    console.log(`${stamp}  ${result.worst.toUpperCase()} — ${result.findings.length} finding(s), `
      + `${result.checked} anchor(s) checked, chain at ${height}`);
    for (const f of result.findings) console.log('  ' + f.message);
  }
  return result.worst === 'mismatch' ? 3 : result.worst === 'ok' ? 0 : 2;
}

if (loopSeconds === null) {
  process.exit(await pass());
} else {
  console.log(`watching every ${loopSeconds}s — node ${NODE}, anchor ${ANCHOR}`);
  for (;;) {
    try { await pass(); } catch (e) { console.log(`${new Date().toISOString()}  ERROR ${e.message}`); }
    await new Promise((r) => setTimeout(r, loopSeconds * 1000));
  }
}
