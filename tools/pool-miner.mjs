#!/usr/bin/env node
/**
 * Molibra pool miner - mines MOLI on the public pool, no full node needed.
 *
 *   node tools/pool-miner.mjs --address 0xYOUR_WALLET [--worker rig1] [--threads 4]
 *                             [--pool https://molibra.org/pool]
 *
 * Asks the pool for a job (a 32-byte seal digest and a share target), grinds
 * keccak256(digest ‖ nonce) on every thread, and sends each nonce under the
 * share target back. Rewards are split by PPLNS and paid automatically to
 * --address once they reach the pool's minimum; see https://molibra.org/pool.
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { keccak256, bigToBytes, bytesToBig, concatBytes, fromHex } from '../src/crypto.js';

if (!isMainThread) {
  // ------------------------------------------------------------ grinder
  let job = null;
  let nonce = 0n;
  let stride = 1n;
  parentPort.on('message', (msg) => {
    if (msg.type === 'job') {
      job = { ...msg.job, digest: fromHex(msg.job.digest), target: BigInt(msg.job.shareTarget) };
      nonce = BigInt(msg.start);
      stride = BigInt(msg.stride);
    }
  });
  const grind = () => {
    if (job) {
      let hashes = 0;
      const deadline = Date.now() + 200;
      while (Date.now() < deadline) {
        for (let i = 0; i < 500; i++) {
          const h = bytesToBig(keccak256(concatBytes(job.digest, bigToBytes(nonce))));
          if (h < job.target) parentPort.postMessage({ type: 'share', jobId: job.jobId, nonce: nonce.toString() });
          nonce += stride;
          hashes++;
        }
      }
      parentPort.postMessage({ type: 'hashes', n: hashes });
    }
    setImmediate(grind);
  };
  grind();
} else {
  // ------------------------------------------------------------ coordinator
  const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  const POOL = (arg('pool', 'https://molibra.org/pool')).replace(/\/$/, '');
  const ADDRESS = arg('address');
  const WORKER = arg('worker', 'default');
  const THREADS = Math.max(1, Number(arg('threads', Math.max(1, cpus().length - 1))));
  if (!ADDRESS || !/^0x[0-9a-fA-F]{40}$/.test(ADDRESS)) {
    console.error('usage: node tools/pool-miner.mjs --address 0xYOUR_WALLET [--worker name] [--threads n]');
    process.exit(1);
  }

  const post = async (path, body) => {
    const r = await fetch(POOL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  };

  const workers = [];
  let job = null;
  let hashes = 0;
  let accepted = 0;
  let rejected = 0;
  let blocks = 0;
  const started = Date.now();

  const dispatch = (j) => {
    job = j;
    const base = BigInt(Math.floor(Math.random() * 2 ** 40));
    workers.forEach((w, i) => w.postMessage({ type: 'job', job: j, start: (base + BigInt(i)).toString(), stride: THREADS }));
  };

  const fetchJob = async () => {
    try {
      dispatch(await post('/api/job', { address: ADDRESS, worker: WORKER }));
    } catch (error) {
      console.error(`[miner] no job: ${error.message}; retrying in 10 s`);
      setTimeout(fetchJob, 10_000);
    }
  };

  for (let i = 0; i < THREADS; i++) {
    const w = new Worker(fileURLToPath(import.meta.url));
    w.on('message', async (msg) => {
      if (msg.type === 'hashes') hashes += msg.n;
      if (msg.type === 'share' && job && msg.jobId === job.jobId) {
        try {
          const r = await post('/api/share', { jobId: msg.jobId, nonce: msg.nonce, address: ADDRESS, worker: WORKER });
          if (r.ok) {
            accepted++;
            if (r.block) {
              blocks++;
              console.log(`[miner] ⛏ block found! ${r.block}`);
            }
          } else {
            rejected++;
            if (/stale|expired/.test(r.reason ?? '')) fetchJob();
          }
        } catch (error) {
          rejected++;
          console.error(`[miner] share not sent: ${error.message}`);
        }
      }
    });
    workers.push(w);
  }

  console.log(`[miner] ${THREADS} thread(s) → ${POOL}  paying ${ADDRESS}  worker "${WORKER}"`);
  await fetchJob();

  // New work as soon as the pool has a new template; a fresh job every minute regardless.
  let lastTemplate = null;
  setInterval(async () => {
    try {
      const r = await fetch(POOL + '/api/head');
      const head = await r.json();
      if (lastTemplate !== null && head.templateId !== lastTemplate) fetchJob();
      lastTemplate = head.templateId;
    } catch { /* pool briefly unreachable */ }
  }, 1_500);
  setInterval(fetchJob, 60_000);

  setInterval(() => {
    const secs = (Date.now() - started) / 1000;
    console.log(`[miner] ${(hashes / secs / 1000).toFixed(1)} kH/s  shares ${accepted} ok / ${rejected} rejected  blocks ${blocks}  height ${job?.height ?? '-'}  share diff ${job?.shareDifficulty ?? '-'}`);
  }, 30_000);
}
