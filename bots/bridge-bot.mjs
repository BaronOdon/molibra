#!/usr/bin/env node
/**
 * Molibra bridge bot - the service. The logic is bots/bridge-core.mjs; this
 * file is the I/O, the lock, the log, the heartbeat and the loop.
 *
 *   node bots/bridge-bot.mjs --dry-run --once          read everything, send nothing, one pass
 *   node bots/bridge-bot.mjs --dry-run                 the same, looping
 *   node bots/bridge-bot.mjs                           live (returns stay dry-run below the flag day)
 *   node bots/bridge-bot.mjs --data-dir D:\bots --interval 300
 *
 * Everything it keeps lives OUTSIDE the repository, in --data-dir (default
 * C:\Users\Administrator\molibra-bots):
 *
 *   keys.json             the two bot keys (also in CREDENTIALS.md) - NEVER commit
 *   config.json           optional overrides (nodes, RPC lists, intervals, caps)
 *   state.json            checkpointed progress (state.dry-run.json for --dry-run)
 *   pending-operator.json what needs a person, with the operator's way through
 *   heartbeat.json        rewritten every loop and every minute while sleeping
 *   bridge-bot.log        JSON lines, rotated at 5 MB, five kept
 *   STOP                  create this file and the bot exits at the next loop
 *
 * ⛔ Single instance per data dir and mode: a lock holding the PID. A lock
 *    whose PID is dead is stale and is taken over, so a crash never wedges it.
 * ⛔ --dry-run replaces both send paths with stubs that throw. Nothing signed in
 *    a dry run can leave this process, whatever the core decides.
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync, appendFileSync,
  unlinkSync, openSync, closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { BridgeBot, DEFAULTS, addressOf } from './bridge-core.mjs';
import { FastBridge, FAST_DEFAULTS } from './fastbridge-core.mjs';

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) =>
  a.startsWith('--') ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : []));

export const CONFIG_DEFAULTS = {
  nodes: ['http://193.123.191.142:8545', 'http://141.147.99.86:8545'],
  publicNode: 'https://molibra.org',
  // ⛔ Three roles, and the primary and the cross-check must be DIFFERENT
  //    providers: the cross-check exists to catch one provider lying or lagging.
  ethPrimary: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  ethCross: ['https://gateway.tenderly.co/public/mainnet', 'https://rpc.mevblocker.io'],
  ethLogs: ['https://gateway.tenderly.co/public/mainnet', 'https://rpc.mevblocker.io'],
  intervalSec: 300,
  maxBackoffSec: 3600,
  logMaxBytes: 5 * 1024 * 1024,
  logKeep: 5,
};

/* -------------------------------------------------------------------- I/O */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A JSON-RPC caller over a list of endpoints. A revert is an ANSWER and is
 * thrown at once with its data; a null, a transport error, a 429 or a 5xx moves
 * to the next endpoint, with exponential backoff between full rounds.
 */
export function rpcCaller(urls, { rounds = 3, timeoutMs = 25_000, fetchImpl = fetch } = {}) {
  const list = [urls].flat().filter(Boolean);
  return async (method, params = []) => {
    let last;
    for (let round = 0; round < rounds; round++) {
      for (const url of list) {
        try {
          const r = await fetchImpl(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (r.status === 429 || r.status >= 500) { last = new Error(`${method}: HTTP ${r.status} from ${url}`); continue; }
          const j = await r.json();
          if (j.error) {
            const err = new Error(`${method}: ${j.error.message}`);
            err.data = j.error.data?.data ?? j.error.data ?? null;
            err.code = j.error.code;
            if (err.code === 3 || /revert/i.test(j.error.message) || method === 'eth_sendRawTransaction') throw err;
            last = err;
            continue;
          }
          if (j.result !== null && j.result !== undefined) return j.result;
          last = new Error(`${method}: null from ${url}`);
        } catch (e) {
          if (e.data !== undefined || e.code === 3) throw e;
          if (method === 'eth_sendRawTransaction' && e.code !== undefined) throw e;
          last = e;
        }
      }
      if (round < rounds - 1) await sleep(1000 * 2 ** round);
    }
    throw last;
  };
}

/** GET a node audit route, honouring 429 retry-after, falling back across nodes. */
export function molibraIo(nodes, { fetchImpl = fetch } = {}) {
  const get = async (path) => {
    let last;
    for (let attempt = 0; attempt < 6; attempt++) {
      for (const base of nodes) {
        try {
          const r = await fetchImpl(base + path, { signal: AbortSignal.timeout(30_000) });
          if (r.status === 429) {
            const after = Number(r.headers.get('retry-after')) || 2;
            last = new Error(`${path}: 429 from ${base}`);
            await sleep(Math.min(30, after) * 1000);
            continue;
          }
          if (r.status === 404) return r.json();  // an answer ("not found"), not an outage
          if (!r.ok) { last = new Error(`${path}: HTTP ${r.status} from ${base}`); continue; }
          return await r.json();
        } catch (e) { last = e; }
      }
      await sleep(1000 * 2 ** attempt);
    }
    throw last;
  };
  const rpc = async (method, params) => {
    let last;
    for (const base of nodes) {
      try {
        const r = await fetchImpl(base + '/', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(30_000),
        });
        const j = await r.json();
        if (j.error) {
          const err = new Error(`${method}: ${j.error.message}`);
          if (method === 'eth_sendRawTransaction') throw err;  // the node's verdict
          last = err;
          continue;
        }
        return j.result;
      } catch (e) {
        if (method === 'eth_sendRawTransaction' && !/fetch failed|timeout|ECONN/i.test(e.message)) throw e;
        last = e;
      }
    }
    throw last;
  };
  return { get, rpc };
}

/* ------------------------------------------------------------ the service */

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/** Write via a temp file and a rename, so a crash mid-write never leaves half a file. */
function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const replacer = (_, v) => (typeof v === 'bigint' ? v.toString() : v);

function makeLogger(file, { maxBytes, keep, echo = true }) {
  return (level, event, fields = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...fields }, replacer);
    try {
      if (existsSync(file) && statSync(file).size > maxBytes) {
        for (let i = keep - 1; i >= 1; i--) {
          if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        }
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, line + '\n');
    } catch { /* a full disk must not kill the loop; the heartbeat still shows it */ }
    if (echo) console.log(line);
  };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Take the lock or return false. A lock whose PID is gone is stale. */
export function acquireLock(path) {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
      closeSync(fd);
      return true;
    } catch {
      const held = loadJson(path, null);
      if (held?.pid && held.pid !== process.pid && alive(held.pid)) return false;
      try { unlinkSync(path); } catch { /* raced */ }
    }
  }
  return false;
}

async function main() {
  const dataDir = args['data-dir'] ?? 'C:\\Users\\Administrator\\molibra-bots';
  const dryRun = Boolean(args['dry-run']);
  const once = Boolean(args.once);
  mkdirSync(dataDir, { recursive: true });
  const fileCfg = loadJson(args.config ?? join(dataDir, 'config.json'), {});
  const cfg = { ...CONFIG_DEFAULTS, ...fileCfg };
  if (args.interval) cfg.intervalSec = Number(args.interval);
  const mode = dryRun ? 'dry-run' : 'live';
  const log = makeLogger(join(dataDir, dryRun ? 'bridge-bot.dry-run.log' : 'bridge-bot.log'),
    // Echo to the console only when someone is watching it: under the scheduled
    // task stdout is a file nobody rotates, and the log above already has it all.
    { maxBytes: cfg.logMaxBytes, keep: cfg.logKeep, echo: Boolean(process.stdout.isTTY) || once });

  const lock = join(dataDir, `bridge-bot.${mode}.lock`);
  if (!acquireLock(lock)) {
    console.error(`[bridge-bot] ${lock} is held by a live process - another ${mode} instance runs. Exiting.`);
    process.exit(0);
  }
  const release = () => { try { if (loadJson(lock, {})?.pid === process.pid) unlinkSync(lock); } catch { /* gone */ } };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { release(); process.exit(0); });

  // --- keys, matched by derivation and never printed -------------------------
  let keys = null;
  if (!args['no-keys']) {
    const k = loadJson(args.keys ?? join(dataDir, 'keys.json'), null);
    if (!k) throw new Error(`no keys file in ${dataDir} (or pass --no-keys with --dry-run)`);
    for (const [name, entry] of [['headerBot', k.headerBot], ['ethRelayer', k.ethRelayer]]) {
      if (addressOf(entry.key) !== String(entry.address).toLowerCase()) {
        throw new Error(`${name}: the key does not derive the address recorded beside it`);
      }
    }
    keys = { headerBot: k.headerBot.key, ethRelayer: k.ethRelayer.key };
    // The fast leg's inventory key is optional: no entry, no fast leg.
    if (k.fastInventory) {
      if (addressOf(k.fastInventory.key) !== String(k.fastInventory.address).toLowerCase()) {
        throw new Error('fastInventory: the key does not derive the address recorded beside it');
      }
      keys.fastInventory = k.fastInventory.key;
    }
  } else if (!dryRun) {
    throw new Error('--no-keys is for --dry-run only');
  }

  // --- I/O ---------------------------------------------------------------------
  const molibra = molibraIo(cfg.nodes);
  const io = {
    molibra,
    eth: {
      rpc: rpcCaller(cfg.ethPrimary),
      cross: [{ name: cfg.ethCross.map((u) => new URL(u).host).join('|'), rpc: rpcCaller(cfg.ethCross) }],
      logs: rpcCaller(cfg.ethLogs),
      send: rpcCaller(cfg.ethPrimary, { rounds: 1 }),
    },
    // ⭐ Express anchor: run the anchor publisher's scheduled task now.
    triggerAnchor: () => new Promise((resolveRun, rejectRun) => {
      execFile('schtasks', ['/run', '/tn', cfg.anchorTask ?? '\\Molibra anchor publisher'], { windowsHide: true },
        (err, stdout, stderr) => (err ? rejectRun(new Error(`schtasks: ${stderr || err.message}`)) : resolveRun(stdout)));
    }),
  };
  if (dryRun) {
    // ⛔ Belt and braces: nothing leaves, whatever the core decides.
    const refuse = async () => { throw new Error('dry-run: refusing to send'); };
    io.eth.send = refuse;
    io.triggerAnchor = null;   // the core logs what it would have fired
    const realRpc = molibra.rpc;
    io.molibra = { ...molibra, rpc: (m, p) => (m === 'eth_sendRawTransaction' ? refuse() : realRpc(m, p)) };
  }
  // Every RPC must be on the chain it claims, before anything is trusted.
  for (const [name, call] of [['ethPrimary', io.eth.rpc], ['ethCross', io.eth.cross[0].rpc], ['ethLogs', io.eth.logs]]) {
    const id = BigInt(await call('eth_chainId', []));
    if (id !== 1n) throw new Error(`${name} is on chain ${id}, not Ethereum mainnet`);
  }
  const mid = BigInt(await io.molibra.rpc('eth_chainId', []));
  if (mid !== 20226n) throw new Error(`the Molibra node is on chain ${mid}`);

  const stateFile = join(dataDir, dryRun ? 'state.dry-run.json' : 'state.json');
  const state = loadJson(stateFile, {});
  const save = (s) => writeAtomic(stateFile, JSON.stringify(s, replacer, 1));
  const bot = new BridgeBot({ io, keys, state, save, log,
    config: { ...DEFAULTS, ...(fileCfg.core ?? {}), dryRun } });
  // --- the fast leg (inventory), only with its key --------------------------
  let fast = null;
  if (keys?.fastInventory && cfg.fastEnabled !== false) {
    const fastStateFile = join(dataDir, dryRun ? 'fast-state.dry-run.json' : 'fast-state.json');
    const fastState = loadJson(fastStateFile, {});
    const ledger = join(dataDir, dryRun ? 'fast-payouts.dry-run.jsonl' : 'fast-payouts.jsonl');
    // Every Molibra node, separately, so a source block can be cross-checked.
    const molibraNodes = cfg.nodes.map((u) => ({ name: u, get: molibraIo([u]).get }));
    fast = new FastBridge({ io: { ...io, molibraNodes }, key: keys.fastInventory, state: fastState,
      save: (s) => writeAtomic(fastStateFile, JSON.stringify(s, replacer, 1)), log,
      config: { ...FAST_DEFAULTS, ...(fileCfg.fast ?? {}), dryRun } });
    fast.onPayout = (p) => { try { appendFileSync(ledger, JSON.stringify(p, replacer) + '\n'); } catch { /* logged by state */ } };
  }

  log('info', 'start', { pid: process.pid, mode, dataDir, relayer: bot.relayer, headerBot: bot.botAddress,
    fastInventory: fast?.inventory ?? null, nodes: cfg.nodes, intervalSec: cfg.intervalSec });

  const heartbeatFile = join(dataDir, dryRun ? 'heartbeat.dry-run.json' : 'heartbeat.json');
  const beat = { pid: process.pid, host: hostname(), mode, startedAt: new Date().toISOString(),
    tick: 0, consecutiveFailures: 0 };
  const heartbeat = (extra) => {
    Object.assign(beat, extra, { at: new Date().toISOString() });
    try { writeAtomic(heartbeatFile, JSON.stringify(beat, replacer, 1)); } catch { /* logged by absence */ }
  };

  for (;;) {
    if (existsSync(join(dataDir, 'STOP'))) {
      log('warn', 'stop-file', { note: 'STOP exists in the data dir; exiting cleanly' });
      heartbeat({ phase: 'stopped' });
      return;
    }
    beat.tick += 1;
    heartbeat({ phase: 'tick' });
    try {
      const s = await bot.tick();
      // ⛔ STOP-FAST pauses only the fast leg; the slow legs keep running.
      let f = null;
      if (fast && existsSync(join(dataDir, 'STOP-FAST'))) {
        log('warn', 'stop-fast-file', { note: 'STOP-FAST exists: the fast leg is skipped' });
      } else if (fast) {
        try { f = await fast.tick(); } catch (e) { log('error', 'fast-tick-failed', { error: e.message }); }
        if (f?.errors?.length) s.errors.push(...f.errors.map((x) => `fast ${x}`));
      }
      const pending = [...bot.pendingItems(cfg.publicNode), ...(fast ? fast.pendingItems() : [])];
      if (f) s.fast = f.fast;
      writeAtomic(join(dataDir, dryRun ? 'pending-operator.dry-run.json' : 'pending-operator.json'),
        JSON.stringify({ updatedAt: new Date().toISOString(), mode, items: pending }, replacer, 1));
      beat.consecutiveFailures = s.errors.length ? beat.consecutiveFailures + 1 : 0;
      heartbeat({ phase: 'idle', lastTickAt: new Date().toISOString(),
        ...(s.errors.length ? {} : { lastOkAt: new Date().toISOString() }),
        molibraHeight: s.height, claimsLive: s.claimsLive, returnsLive: s.returnsLive,
        summary: { burns: s.burns, burnsWei: s.burnsWei, returns: s.returns, returnsWei: s.returnsWei, fast: s.fast ?? null },
        pending: pending.length, errors: s.errors });
      log('info', 'tick', { tick: beat.tick, ...s, pending: pending.length });
    } catch (e) {
      beat.consecutiveFailures += 1;
      heartbeat({ phase: 'error', lastError: e.message });
      log('error', 'tick-failed', { error: e.message });
    }
    if (once) return;
    const backoff = beat.consecutiveFailures
      ? Math.min(cfg.intervalSec * 2 ** Math.min(beat.consecutiveFailures, 6), cfg.maxBackoffSec)
      : cfg.intervalSec;
    heartbeat({ phase: 'sleeping', nextTickInSec: backoff });
    for (let waited = 0; waited < backoff; waited += 60) {
      await sleep(Math.min(60, backoff - waited) * 1000);
      heartbeat({ phase: 'sleeping' });
      if (existsSync(join(dataDir, 'STOP'))) break;
    }
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().then(() => process.exit(0)).catch((e) => {
    const parts = [e.message];
    for (let c = e.cause; c; c = c.cause) parts.push(c.code ?? c.message);
    console.error(`[bridge-bot] FATAL ${parts.filter(Boolean).join(' <- ')}`);
    process.exit(1);  // non-zero, so the scheduled task's restart-on-failure fires
  });
}
