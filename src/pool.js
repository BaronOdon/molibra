/**
 * Molibra - the public mining pool's accounting core.
 *
 * Pure bookkeeping with no network in it, so every rule can be tested by
 * calling it: jobs, share checks, variable share difficulty and the PPLNS
 * split. The HTTP server, the node client, persistence and payouts live in
 * src/poolserver.js and only ever call this.
 *
 * ## How a pool job differs from solo mining
 *
 * Solo mining grinds keccak(sealDigest(header) ‖ nonce) below the block target.
 * The pool hands each miner the SAME header with its own 16-byte extraData
 * ("MOLIPOOL" + 8 random bytes), so every miner grinds a different digest and
 * two miners can never find the same solution. A miner proves work by sending
 * nonces below an easier SHARE target; a share that also beats the block
 * target is a block, sealed here and handed back to the node.
 *
 * ## PPLNS
 *
 * Pay Per Last N Shares, with N measured in work, not in share count: a found
 * block is split over the most recent shares whose difficulties sum to
 * `pplnsFactor` × the block's difficulty. The pool never promises more than a
 * block paid, so it can never owe more than it earned.
 */

import { randomBytes } from 'node:crypto';
import { sealDigest, targetFor, blockHash, deserializeHeader } from './block.js';
import { keccak256, toHex, bigToBytes, bytesToBig, concatBytes, normalizeAddress } from './crypto.js';

export const POOL_TAG = toHex(new TextEncoder().encode('MOLIPOOL'));
const MAX_NONCE = (1n << 64n) - 1n;

export class PoolCore {
  constructor({
    poolAddress,
    feeBps = 100,                // 1%
    minShareDifficulty = 1024n,
    startShareDifficulty = 16384n,
    targetShareSeconds = 15,
    pplnsFactor = 2n,
    jobTtlMs = 10 * 60_000,
    maxJobs = 50_000,            // ⛔ memory bounds: a public endpoint must not grow without limit
    maxWorkers = 20_000,
    maxWorkersPerAddress = 64,
    now = () => Date.now(),
  }) {
    this.poolAddress = normalizeAddress(poolAddress);
    this.feeBps = BigInt(feeBps);
    this.minShareDifficulty = BigInt(minShareDifficulty);
    this.startShareDifficulty = BigInt(startShareDifficulty);
    this.targetShareSeconds = targetShareSeconds;
    this.pplnsFactor = BigInt(pplnsFactor);
    this.jobTtlMs = jobTtlMs;
    this.maxJobs = maxJobs;
    this.maxWorkers = maxWorkers;
    this.maxWorkersPerAddress = maxWorkersPerAddress;
    this.now = now;

    this.template = null;        // { header, transactions, id }
    this.templateId = 0;
    this.jobs = new Map();       // jobId -> job
    this.seen = new Set();       // `${jobId}:${nonce}` already credited
    this.shares = [];            // PPLNS log, oldest first: { address, worker, difficulty, at }
    this.workers = new Map();    // `${address}/${worker}` -> { difficulty, lastShareAt, shares, lastSeen }
    this.recent = [];            // hashrate log, oldest first: { address, difficulty, at }; the last hour only
    this.startedAt = now();
  }

  /** Take a fresh template from the node (the shape /molibra/block-template returns). */
  setTemplate(serialized) {
    const header = deserializeHeader(serialized.header);
    if (header.miner.toLowerCase() !== this.poolAddress.toLowerCase()) {
      throw new Error(`template pays ${header.miner}, not the pool ${this.poolAddress}`);
    }
    this.templateId += 1;
    this.template = { header, transactions: serialized.transactions, id: this.templateId };
    this.prune();
    return this.templateId;
  }

  get height() {
    return this.template ? this.template.header.number : null;
  }

  get blockDifficulty() {
    return this.template ? this.template.header.difficulty : null;
  }

  workerKey(address, worker) {
    return `${normalizeAddress(address).toLowerCase()}/${cleanWorker(worker)}`;
  }

  /** A share difficulty never above the block's: past that every share is a block attempt anyway. */
  clampDifficulty(d) {
    let v = d < this.minShareDifficulty ? this.minShareDifficulty : d;
    const cap = this.blockDifficulty;
    if (cap && v > cap) v = cap;
    return v;
  }

  /** Hand a miner work. Each call gets its own extraData, hence its own digest. */
  newJob(address, worker = 'default') {
    if (!this.template) throw new Error('the pool has no work yet; the node has not answered');
    const addr = normalizeAddress(address);
    const key = this.workerKey(addr, worker);
    let w = this.workers.get(key);
    if (!w) {
      if (this.workers.size >= this.maxWorkers) throw new Error('the pool is at its worker limit; try again later');
      const prefix = addr.toLowerCase() + '/';
      let mine = 0;
      for (const k of this.workers.keys()) if (k.startsWith(prefix)) mine++;
      if (mine >= this.maxWorkersPerAddress) throw new Error(`at most ${this.maxWorkersPerAddress} workers per address`);
      w = { difficulty: this.clampDifficulty(this.startShareDifficulty), lastShareAt: null, shares: 0, lastSeen: this.now() };
      this.workers.set(key, w);
    }
    w.lastSeen = this.now();
    w.difficulty = this.clampDifficulty(w.difficulty);

    const extraData = POOL_TAG + randomBytes(8).toString('hex');
    const header = { ...this.template.header, extraData, nonce: 0n };
    const digest = sealDigest(header);
    const jobId = randomBytes(8).toString('hex');
    if (this.jobs.size >= this.maxJobs) {
      // Evict the oldest (Map keeps insertion order); an honest miner refetches every minute anyway.
      const oldest = this.jobs.keys().next().value;
      this.jobs.delete(oldest);
    }
    this.jobs.set(jobId, {
      address: addr,
      worker: cleanWorker(worker),
      header,
      digest,
      transactions: this.template.transactions,
      templateId: this.template.id,
      parentHash: header.parentHash,
      shareDifficulty: w.difficulty,
      created: this.now(),
    });
    return {
      jobId,
      digest: toHex(digest),
      shareTarget: '0x' + targetFor(w.difficulty).toString(16).padStart(64, '0'),
      shareDifficulty: w.difficulty.toString(),
      blockDifficulty: header.difficulty.toString(),
      height: header.number.toString(),
      templateId: this.template.id,
    };
  }

  /**
   * Check a share. Returns { ok, reason } or, on success,
   * { ok: true, difficulty, block } where `block` is the sealed block
   * (serialized, ready for /molibra/submit-block) when the share beat the
   * block target.
   */
  submitShare({ jobId, nonce, address }) {
    const job = this.jobs.get(String(jobId ?? ''));
    if (!job) return { ok: false, reason: 'unknown or expired job' };
    if (!address || normalizeAddress(address).toLowerCase() !== job.address.toLowerCase()) {
      return { ok: false, reason: 'job belongs to another address' };
    }
    let n;
    try {
      n = BigInt(nonce);
    } catch {
      return { ok: false, reason: 'nonce is not a number' };
    }
    if (n < 0n || n > MAX_NONCE) return { ok: false, reason: 'nonce out of range (64 bits)' };
    if (!this.template || job.parentHash !== this.template.header.parentHash) {
      return { ok: false, reason: 'stale: the chain moved on, fetch a new job' };
    }
    const seenKey = `${jobId}:${n}`;
    if (this.seen.has(seenKey)) return { ok: false, reason: 'duplicate share' };

    const value = bytesToBig(keccak256(concatBytes(job.digest, bigToBytes(n))));
    if (value >= targetFor(job.shareDifficulty)) return { ok: false, reason: 'share above target (low difficulty)' };

    this.seen.add(seenKey);
    const at = this.now();
    this.shares.push({ address: job.address, worker: job.worker, difficulty: job.shareDifficulty, at });
    this.recent.push({ address: job.address, difficulty: job.shareDifficulty, at });
    if (this.recent.length > 1000 && this.recent[0].at < at - 3600_000) {
      this.recent = this.recent.filter((s) => s.at >= at - 3600_000);
    }
    this.retune(job, at);
    this.trimShares();

    const result = { ok: true, difficulty: job.shareDifficulty };
    if (value < targetFor(job.header.difficulty)) {
      const header = { ...job.header, nonce: n };
      result.block = {
        header: serializeHeader(header),
        hash: blockHash(header),
        transactions: job.transactions,
      };
    }
    return result;
  }

  /** Variable share difficulty: steer each worker toward one share per targetShareSeconds. */
  retune(job, at) {
    const w = this.workers.get(this.workerKey(job.address, job.worker));
    if (!w) return;
    w.shares += 1;
    if (w.lastShareAt !== null) {
      const seconds = Math.max((at - w.lastShareAt) / 1000, 0.001);
      const ratio = this.targetShareSeconds / seconds;
      // At most double or halve per share, so one lucky or unlucky share does not swing it.
      const bounded = Math.min(2, Math.max(0.5, ratio));
      const next = BigInt(Math.max(1, Math.round(Number(w.difficulty) * bounded)));
      w.difficulty = this.clampDifficulty(next);
    }
    w.lastShareAt = at;
  }

  /** Keep only as many shares as the widest PPLNS window could need. */
  trimShares() {
    const cap = this.blockDifficulty;
    if (!cap) return;
    const keep = cap * this.pplnsFactor * 2n;
    let sum = 0n;
    let i = this.shares.length - 1;
    for (; i >= 0; i--) {
      sum += BigInt(this.shares[i].difficulty);
      if (sum >= keep) break;
    }
    if (i > 0) this.shares.splice(0, i);
  }

  /**
   * Split `reward` (wei) for a block of difficulty `blockDifficulty` over the
   * last N shares. Returns { credits: Map(address -> wei), fee }. Rounding
   * dust goes to the fee, so the credits never add up to more than the reward.
   */
  splitReward(reward, blockDifficulty) {
    const total = BigInt(reward);
    const fee = (total * this.feeBps) / 10_000n;
    const distributable = total - fee;
    const window = BigInt(blockDifficulty) * this.pplnsFactor;

    const weights = new Map();
    let sum = 0n;
    for (let i = this.shares.length - 1; i >= 0 && sum < window; i--) {
      const s = this.shares[i];
      let d = BigInt(s.difficulty);
      if (sum + d > window) d = window - sum; // the oldest share counts only for the part inside the window
      weights.set(s.address, (weights.get(s.address) ?? 0n) + d);
      sum += d;
    }
    const credits = new Map();
    if (sum === 0n) return { credits, fee: total };
    let paid = 0n;
    for (const [addr, wgt] of weights) {
      const amount = (distributable * wgt) / sum;
      if (amount > 0n) credits.set(addr, amount);
      paid += amount;
    }
    return { credits, fee: total - paid };
  }

  /**
   * Hashes per second over the last `seconds`: a share at difficulty d is worth
   * d hashes on average. Read from its own log, not the PPLNS one (which is
   * trimmed by work, not time), and over no more time than the pool has run.
   */
  hashrate(seconds = 600, address = null) {
    const now = this.now();
    const span = Math.min(seconds, Math.max(1, (now - this.startedAt) / 1000));
    const since = now - span * 1000;
    let work = 0n;
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const s = this.recent[i];
      if (s.at < since) break;
      if (address && s.address.toLowerCase() !== address.toLowerCase()) continue;
      work += BigInt(s.difficulty);
    }
    return Number(work) / span;
  }

  activeMiners(seconds = 600) {
    const since = this.now() - seconds * 1000;
    const miners = new Set();
    let workers = 0;
    for (const [key, w] of this.workers) {
      if (w.lastSeen >= since) {
        workers += 1;
        miners.add(key.split('/')[0]);
      }
    }
    return { miners: miners.size, workers };
  }

  /** Drop expired jobs and the duplicate-check entries that belonged to them. */
  prune() {
    const cutoff = this.now() - this.jobTtlMs;
    for (const [id, job] of this.jobs) {
      if (job.created < cutoff) this.jobs.delete(id);
    }
    if (this.seen.size > 200_000) this.seen.clear();
    for (const [key, w] of this.workers) {
      if (w.lastSeen < this.now() - 24 * 3600_000) this.workers.delete(key);
    }
  }

  /** What persists across a restart: the PPLNS log and each worker's tuned difficulty. */
  snapshot() {
    return {
      shares: this.shares.map((s) => ({ ...s, difficulty: s.difficulty.toString() })),
      workers: [...this.workers].map(([k, w]) => [k, { ...w, difficulty: w.difficulty.toString() }]),
    };
  }

  restore(snap) {
    if (!snap) return;
    this.shares = (snap.shares ?? []).map((s) => ({ ...s, difficulty: BigInt(s.difficulty) }));
    this.workers = new Map((snap.workers ?? []).map(([k, w]) => [k, { ...w, difficulty: BigInt(w.difficulty) }]));
  }
}

function cleanWorker(worker) {
  return String(worker ?? 'default').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32) || 'default';
}

function serializeHeader(h) {
  return {
    number: h.number.toString(),
    parentHash: h.parentHash,
    timestamp: h.timestamp.toString(),
    miner: h.miner,
    stateRoot: h.stateRoot,
    txRoot: h.txRoot,
    difficulty: h.difficulty.toString(),
    gasLimit: h.gasLimit.toString(),
    gasUsed: h.gasUsed.toString(),
    extraData: h.extraData,
    nonce: h.nonce.toString(),
  };
}

