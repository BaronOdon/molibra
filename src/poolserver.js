/**
 * Molibra - the public mining pool server.
 *
 *   node src/poolserver.js --node http://127.0.0.1:8545 --address 0xPOOL \
 *        --key-file /etc/molibra-pool/key --datadir /var/lib/molibra-pool \
 *        [--submit-to http://141.147.99.86:8545] [--port 8600] [--host 127.0.0.1]
 *
 * Runs beside a node (it needs the node's loopback-only /molibra/block-template)
 * and is reached through Caddy at https://molibra.org/pool. The accounting rules
 * are in src/pool.js; this file is the plumbing around them:
 *
 *   - work:     a template per new head (or every 30 s, to pick up transactions)
 *   - miners:   POST /pool/api/job, POST /pool/api/share, GET /pool/api/head
 *   - blocks:   a share that beats the block target is sealed and pushed to
 *               the local node and every --submit-to node
 *   - maturity: a found block is credited only once it is MATURITY blocks deep
 *               on the canonical chain (the chain reorganises up to 128 deep);
 *               one that fell off the chain is marked orphaned and pays nothing
 *   - payouts:  balances at or above the minimum are paid automatically from
 *               the pool wallet; the balance is debited and saved BEFORE the
 *               transaction is broadcast, and restored if the broadcast fails
 *   - public:   /pool (page), /pool/api/stats, /pool/api/miner/0x…,
 *               /pool/api/blocks, /pool/api/payments
 *
 * The pool's key signs payouts locally; only signed transactions leave.
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PoolCore } from './pool.js';
import { blockRewardAt } from './block.js';
import { signTransaction, decodeTransaction } from './tx.js';
import { privateToAddress, toChecksumAddress, toHex, normalizeAddress } from './crypto.js';
import { MAX_REORG_DEPTH } from './limits.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEI = 10n ** 18n;

export const POOL_DEFAULTS = {
  feeBps: 100,                         // 1%
  maturity: MAX_REORG_DEPTH + 2,       // a block deeper than any accepted reorg
  minPayout: WEI / 10n,                // 0.1 MOLI
  payoutEveryMs: 10 * 60_000,
  confirmEveryMs: 60_000,
  headPollMs: 1_000,
  templateMaxAgeMs: 30_000,
  saveEveryMs: 30_000,
  gasLimit: 21_000n,
};

export class PoolServer {
  constructor({
    nodeUrl, address, privateKey = null, dataDir, submitTo = [], genesis,
    chainId = 20226n, options = {}, fetchImpl = fetch, log = console,
  }) {
    this.nodeUrl = nodeUrl.replace(/\/$/, '');
    this.address = toChecksumAddress(normalizeAddress(address));
    this.key = privateKey ? privateKey.replace(/^0x/, '') : null;
    if (this.key && toChecksumAddress(privateToAddress(this.key)).toLowerCase() !== this.address.toLowerCase()) {
      throw new Error('the key file does not derive the pool address');
    }
    this.dataDir = dataDir;
    this.submitTo = submitTo.map((u) => u.replace(/\/$/, ''));
    this.genesis = genesis;
    this.chainId = BigInt(chainId);
    this.opt = { ...POOL_DEFAULTS, ...options };
    this.fetch = fetchImpl;
    this.log = log;

    this.core = new PoolCore({ poolAddress: this.address, feeBps: this.opt.feeBps, ...(options.core ?? {}) });
    this.state = { blocks: [], balances: {}, paid: {}, payments: [], feesEarned: '0' };
    this.headHash = null;
    this.templateAt = 0;
    this.chainHeight = 0n;
    this.timers = [];
    this.busy = { payout: false, confirm: false };
    this.load();
  }

  // ------------------------------------------------------------ persistence

  get stateFile() {
    return join(this.dataDir, 'pool-state.json');
  }

  load() {
    mkdirSync(this.dataDir, { recursive: true });
    if (!existsSync(this.stateFile)) return;
    const saved = JSON.parse(readFileSync(this.stateFile, 'utf8'));
    this.state = { ...this.state, ...saved.state };
    this.core.restore(saved.core);
  }

  /** Atomic: a crash mid-write leaves the previous file, never half of one. */
  save() {
    const tmp = this.stateFile + '.tmp';
    writeFileSync(tmp, JSON.stringify({ state: this.state, core: this.core.snapshot(), savedAt: Date.now() }));
    renameSync(tmp, this.stateFile);
  }

  // ------------------------------------------------------------ node client

  async rpc(method, params = [], url = this.nodeUrl) {
    const r = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result;
  }

  async getJson(path, url = this.nodeUrl) {
    const r = await this.fetch(url + path);
    const j = await r.json();
    if (!r.ok) throw new Error(`${path}: ${j.error ?? r.status}`);
    return j;
  }

  async postJson(path, body, url = this.nodeUrl) {
    const r = await this.fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(`${path}: ${j.error ?? r.status}`);
    return j;
  }

  /** New template when the head moved, or when the old one is getting stale. */
  async refreshWork(force = false) {
    const head = await this.getJson('/molibra/head');
    this.chainHeight = BigInt(head.header.number);
    const moved = head.hash !== this.headHash;
    if (!force && !moved && Date.now() - this.templateAt < this.opt.templateMaxAgeMs) return false;
    const template = await this.getJson(`/molibra/block-template?coinbase=${this.address}`);
    this.core.setTemplate(template);
    this.headHash = head.hash;
    this.templateAt = Date.now();
    return true;
  }

  // ---------------------------------------------------------------- miners

  job(address, worker) {
    return this.core.newJob(address, worker);
  }

  async share(body) {
    const result = this.core.submitShare(body);
    if (result.ok) result.difficulty = result.difficulty.toString();
    if (!result.ok || !result.block) return result;
    const block = result.block;
    const height = BigInt(block.header.number);
    // Local node first: it is the one the pool builds on.
    let accepted = false;
    try {
      await this.postJson('/molibra/submit-block', { block });
      accepted = true;
    } catch (error) {
      this.log.error(`[pool] local node refused block ${block.hash}: ${error.message}`);
    }
    for (const peer of this.submitTo) {
      this.postJson('/molibra/submit-block', { block }, peer).catch(() => { /* peer down: it will sync */ });
    }
    if (accepted) {
      const reward = blockRewardAt(height, this.genesis);
      const { credits, fee } = this.core.splitReward(reward, BigInt(block.header.difficulty));
      this.state.blocks.unshift({
        hash: block.hash,
        height: height.toString(),
        foundAt: Date.now(),
        finder: body.address,
        reward: reward.toString(),
        fee: fee.toString(),
        credits: Object.fromEntries([...credits].map(([a, v]) => [a, v.toString()])),
        status: 'pending',
      });
      this.state.blocks = this.state.blocks.slice(0, 500);
      this.save();
      this.log.log(`[pool] block ${height} ${block.hash.slice(0, 12)} found by ${body.address}`);
      this.refreshWork(true).catch(() => {});
    }
    return { ok: true, difficulty: result.difficulty, block: accepted ? block.hash : null };
  }

  // -------------------------------------------------------------- maturity

  async confirmBlocks() {
    if (this.busy.confirm) return;
    this.busy.confirm = true;
    try {
      const tip = BigInt(await this.rpc('eth_blockNumber'));
      let changed = false;
      for (const b of this.state.blocks) {
        if (b.status !== 'pending') continue;
        const h = BigInt(b.height);
        const onChain = await this.rpc('eth_getBlockByNumber', ['0x' + h.toString(16), false]);
        const ours = onChain && onChain.hash?.toLowerCase() === b.hash.toLowerCase();
        if (!ours && tip - h >= 10n) {
          b.status = 'orphaned';
          changed = true;
        } else if (ours && tip - h >= BigInt(this.opt.maturity)) {
          for (const [addr, wei] of Object.entries(b.credits)) {
            this.state.balances[addr] = (BigInt(this.state.balances[addr] ?? 0) + BigInt(wei)).toString();
          }
          this.state.feesEarned = (BigInt(this.state.feesEarned) + BigInt(b.fee)).toString();
          b.status = 'confirmed';
          changed = true;
        }
      }
      if (changed) this.save();
    } finally {
      this.busy.confirm = false;
    }
  }

  // --------------------------------------------------------------- payouts

  async payout() {
    if (this.busy.payout || !this.key) return [];
    this.busy.payout = true;
    const sent = [];
    try {
      await this.checkPayments();
      const due = Object.entries(this.state.balances)
        .map(([a, v]) => [a, BigInt(v)])
        .filter(([, v]) => v >= this.opt.minPayout);
      if (!due.length) return sent;

      const gasPrice = BigInt(await this.rpc('eth_gasPrice'));
      let nonce = BigInt(await this.rpc('eth_getTransactionCount', [this.address, 'pending']));
      let wallet = BigInt(await this.rpc('eth_getBalance', [this.address, 'latest']));
      const gasCost = gasPrice * this.opt.gasLimit;

      for (const [to, amount] of due) {
        // Never promise what the wallet does not hold.
        if (wallet < amount + gasCost) {
          this.log.error(`[pool] wallet holds ${wallet} wei, cannot pay ${amount} to ${to}; stopping this round`);
          break;
        }
        const tx = { nonce, gasPrice, gasLimit: this.opt.gasLimit, to, value: amount, data: '0x' };
        const raw = signTransaction(tx, this.key, this.chainId);
        const back = decodeTransaction(raw, Number(this.chainId));
        if ((back.to ?? '').toLowerCase() !== to.toLowerCase() || BigInt(back.value) !== amount
          || (back.from ?? '').toLowerCase() !== this.address.toLowerCase()) {
          throw new Error('signed payout does not decode back to its intent; refusing');
        }
        // Debit and record BEFORE broadcasting: a crash after the send must not pay twice.
        const payment = { to, amount: amount.toString(), nonce: nonce.toString(), raw: toHex(raw), at: Date.now(), status: 'sending', hash: null };
        this.state.balances[to] = (BigInt(this.state.balances[to]) - amount).toString();
        this.state.payments.unshift(payment);
        this.save();
        try {
          payment.hash = await this.rpc('eth_sendRawTransaction', [payment.raw]);
          payment.status = 'sent';
          this.state.paid[to] = (BigInt(this.state.paid[to] ?? 0) + amount).toString();
          nonce += 1n;
          wallet -= amount + gasCost;
          sent.push(payment);
        } catch (error) {
          // Not accepted by the node: give the balance back and try next round.
          this.state.balances[to] = (BigInt(this.state.balances[to]) + amount).toString();
          payment.status = 'failed';
          payment.error = error.message;
          this.log.error(`[pool] payout to ${to} failed: ${error.message}`);
        }
        this.save();
      }
      this.state.payments = this.state.payments.slice(0, 1000);
      this.save();
      return sent;
    } finally {
      this.busy.payout = false;
    }
  }

  /** Mark mined payouts; re-broadcast any that vanished from the mempool. */
  async checkPayments() {
    let changed = false;
    for (const p of this.state.payments) {
      if (p.status !== 'sent' || !p.hash) continue;
      const receipt = await this.rpc('eth_getTransactionReceipt', [p.hash]).catch(() => null);
      if (receipt) {
        p.status = 'confirmed';
        p.block = receipt.blockNumber;
        changed = true;
      } else if (Date.now() - p.at > 30 * 60_000) {
        await this.rpc('eth_sendRawTransaction', [p.raw]).catch(() => {});
      }
    }
    if (changed) this.save();
  }

  // ---------------------------------------------------------------- public

  stats() {
    const { miners, workers } = this.core.activeMiners();
    const confirmed = this.state.blocks.filter((b) => b.status === 'confirmed').length;
    return {
      pool: 'Molibra public pool',
      address: this.address,
      feePercent: Number(this.opt.feeBps) / 100,
      scheme: 'PPLNS',
      pplnsWindow: `${this.core.pplnsFactor}x block difficulty`,
      minPayoutMoli: Number(this.opt.minPayout) / 1e18,
      maturityBlocks: this.opt.maturity,
      hashrate: Math.round(this.core.hashrate(600)),
      miners,
      workers,
      blocksFound: this.state.blocks.length,
      blocksConfirmed: confirmed,
      lastBlock: this.state.blocks[0] ? { height: this.state.blocks[0].height, hash: this.state.blocks[0].hash, foundAt: this.state.blocks[0].foundAt, status: this.state.blocks[0].status } : null,
      network: {
        height: this.chainHeight.toString(),
        difficulty: this.core.blockDifficulty?.toString() ?? null,
        targetBlockSeconds: this.genesis.targetBlockSeconds ?? 15,
      },
      payoutsAutomatic: Boolean(this.key),
    };
  }

  miner(address) {
    const addr = normalizeAddress(address);
    const pending = this.state.blocks
      .filter((b) => b.status === 'pending')
      .reduce((s, b) => s + BigInt(b.credits[addr] ?? 0), 0n);
    const workers = [...this.core.workers]
      .filter(([k]) => k.startsWith(addr + '/'))
      .map(([k, w]) => ({ name: k.split('/')[1], difficulty: w.difficulty.toString(), shares: w.shares, lastSeen: w.lastSeen }));
    return {
      address: toChecksumAddress(addr),
      hashrate: Math.round(this.core.hashrate(600, addr)),
      immature: pending.toString(),
      balance: this.state.balances[addr] ?? '0',
      paid: this.state.paid[addr] ?? '0',
      workers,
      payments: this.state.payments.filter((p) => p.to.toLowerCase() === addr).slice(0, 50)
        .map(({ raw, ...rest }) => rest),
    };
  }

  // ---------------------------------------------------------------- loops

  start() {
    const every = (ms, fn) => {
      const t = setInterval(() => fn().catch((e) => this.log.error(`[pool] ${e.message}`)), ms);
      this.timers.push(t);
    };
    every(this.opt.headPollMs, () => this.refreshWork());
    every(this.opt.confirmEveryMs, () => this.confirmBlocks());
    every(this.opt.payoutEveryMs, () => this.payout());
    every(this.opt.saveEveryMs, async () => this.save());
    return this.refreshWork(true);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.save();
  }
}

// ------------------------------------------------------------------ HTTP

/** Small per-IP token bucket; shares are cheap to check but not free. */
function makeLimiter(perMinute) {
  const buckets = new Map();
  return (ip) => {
    const now = Date.now();
    const b = buckets.get(ip) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    if (buckets.size > 50_000) buckets.clear();
    buckets.set(ip, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

export function createPoolHttp(pool, { pagePath = join(HERE, 'web', 'mining-pool.html') } = {}) {
  const allow = makeLimiter(600);
  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    if (res.headersSent) return;
    // Serialise first: a BigInt that slips into a reply must fail before the headers go out.
    const text = typeof body === 'string' ? body : JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(text);
  };

  return createServer(async (req, res) => {
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST' });
      return res.end();
    }
    if (!allow(ip)) return send(res, 429, { error: 'too many requests' });
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'GET') {
        if (path === '/pool') return send(res, 200, readFileSync(pagePath, 'utf8'), 'text/html; charset=utf-8');
        if (path === '/pool/api/stats') return send(res, 200, pool.stats());
        if (path === '/pool/api/head') {
          return send(res, 200, { height: pool.core.height?.toString() ?? null, templateId: pool.core.templateId });
        }
        if (path === '/pool/api/blocks') return send(res, 200, pool.state.blocks.slice(0, 100));
        if (path === '/pool/api/payments') {
          return send(res, 200, pool.state.payments.slice(0, 100).map(({ raw, ...rest }) => rest));
        }
        const m = /^\/pool\/api\/miner\/(0x[0-9a-fA-F]{40})$/.exec(path);
        if (m) return send(res, 200, pool.miner(m[1]));
        return send(res, 404, { error: 'not found' });
      }
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) return send(res, 413, { error: 'body too large' });
        }
        const payload = JSON.parse(body || '{}');
        if (path === '/pool/api/job') return send(res, 200, pool.job(payload.address, payload.worker));
        if (path === '/pool/api/share') return send(res, 200, await pool.share(payload));
        return send(res, 404, { error: 'not found' });
      }
      return send(res, 405, { error: 'method not allowed' });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  });
}

// ------------------------------------------------------------------- CLI

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const genesis = JSON.parse(readFileSync(arg('genesis', join(HERE, '..', 'genesis.json')), 'utf8'));
  const keyFile = arg('key-file');
  const pool = new PoolServer({
    nodeUrl: arg('node', 'http://127.0.0.1:8545'),
    address: arg('address'),
    privateKey: keyFile ? readFileSync(keyFile, 'utf8').trim() : null,
    dataDir: arg('datadir', './data-pool'),
    submitTo: (arg('submit-to', '') || '').split(',').filter(Boolean),
    genesis,
    chainId: BigInt(genesis.chainId ?? 20226),
  });
  const port = Number(arg('port', 8600));
  const host = arg('host', '127.0.0.1');
  await pool.start();
  createPoolHttp(pool).listen(port, host, () => {
    console.log(`[pool] ${pool.address} on http://${host}:${port}/pool, node ${pool.nodeUrl}, payouts ${pool.key ? 'automatic' : 'OFF (no key)'}`);
  });
  const shutdown = () => { pool.stop(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
