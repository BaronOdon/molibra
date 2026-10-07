/**
 * Molibra FAST bridge - the third leg of the bridge bot, with every network
 * call injected (the same pattern as bridge-core.mjs).
 *
 * The slow bridge mints bMOLI against a burn proof after an anchor and a
 * 24-hour challenge window, and returns MOLI against a receipt proof. That is
 * trust-minimised and slow. This leg is the opposite trade: an INVENTORY
 * wallet holds MOLI on Molibra and bMOLI on Ethereum (one key, the same
 * address on both chains), and swaps one for the other in minutes:
 *
 *   MOLI -> bMOLI   a user sends MOLI to the inventory on Molibra; after
 *                   K Molibra confirmations the bot sends bMOLI (amount - fee)
 *                   to the same address on Ethereum.
 *   bMOLI -> MOLI   a user sends bMOLI to the inventory on Ethereum; after
 *                   N Ethereum confirmations the bot sends MOLI (amount - fee)
 *                   to the same address on Molibra.
 *
 * It is CUSTODIAL for the minutes in flight and needs no new contract. What a
 * user is owed is bounded by limits (per transfer, per rolling hour per
 * direction, per day) and by the inventory actually there; anything outside
 * them is NOT paid by the bot - it goes to pending-operator.json.
 *
 * ⛔ Never pay twice. Every payout carries the SOURCE tx hash in its calldata
 *    (Molibra: the tx data is the 32-byte source hash; Ethereum: appended after
 *    the ERC-20 transfer arguments, which the token ignores). Before a payout
 *    is signed, the chain is searched for one already carrying that hash, and a
 *    persisted payout record is re-verified by its own receipt. On a fresh
 *    state the cursors start at the current tips: a lost state file loses the
 *    in-flight items to the operator, never pays history twice.
 * ⛔ At most ONE payout per direction per tick, and never a second while one is
 *    unconfirmed (a dropped Molibra tx would leave a nonce gap).
 * ⛔ Auto-pause (persisted, the operator clears it) on: a source tx that moved
 *    or vanished after it was confirmed (a reorg deeper than K), two Molibra
 *    nodes disagreeing about a source block, a payout that reverted, or three
 *    ticks in a row that could not read the inventory. STOP-FAST in the data
 *    dir pauses only this leg (handled by the service).
 * ⛔ Rebalancing is the operator's, by the slow bridge: MOLI -> bMOLI by burn
 *    and claim, bMOLI -> MOLI by the vault and return. This leg never bridges.
 */
import { decodeTransaction, signTransaction, intrinsicGas } from '../src/tx.js';
import { toHex, normalizeAddress, privateToAddress } from '../src/crypto.js';
import { BMOLI_CONTRACT } from '../src/molireturn.js';
import { TRANSFER_TOPIC } from '../src/burnproof.js';
import { MAX_BLOCK_RANGE } from '../src/limits.js';
import { signEip1559, decodeEip1559 } from '../src/eth1559.js';

export const MOLIBRA_CHAIN_ID = 20226n;
const GWEI = 1_000_000_000n;
const WEI = 10n ** 18n;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const FAST_DEFAULTS = {
  dryRun: false,
  molibraConfirmations: 12n,       // Molibra reorgs to depth ~2 are seen; 12 is a wide margin
  ethConfirmations: 3n,
  feeBp: 50n,                      // 0.5%
  minFeeWei: 1n * WEI,             // at least 1 MOLI / 1 bMOLI
  maxPerTransferWei: 2_000n * WEI,
  maxPerHourWei: 10_000n * WEI,    // per direction, rolling
  maxPerDayWei: 30_000n * WEI,     // both directions together, rolling
  logChunk: 5_000n,
  maxLogChunksPerTick: 40,
  maxScanPagesPerTick: 200,
  tipWei: 50_000_000n,             // 0.05 gwei, explicit and low
  maxFeeCapWei: 20n * GWEI,
  erc20GasLimit: 90_000n,          // a plain ERC-20 transfer is ~35-52k; 90k with the appended hash and margin
  ethResendAfterMs: 20 * 60_000,
  molibraResendAfterMs: 15 * 60_000,
  readFailPauseAfter: 3,
  // ⛔ Every system cost is the user's (operator, 6 Oct 2026): the fee covers the
  //    payout's gas twice over, read live. MOLI per ETH comes from the bMOLI/ETH
  //    Uniswap v4 pool (StateView.getSlot0), as /molibra/cotacao reads it.
  gasMargin: 2n,
  // ⛔ A hot wallet holds only what the route needs (security review, 6 Oct 2026):
  //    above max + 10% the excess goes to the operator's cold wallet, one tx per
  //    tick, gas paid by the inventory, never leaving it below max.
  maxInventoryMoliWei: 15_000n * WEI,
  maxInventoryBmoliWei: 15_000n * WEI,
  sweepTriggerBp: 11_000n,                 // 110% of max
  coldWallet: '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a',
  stateView: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
  bmoliPoolId: '0x200f192a14c85d09943f76ae3def3ffe596d93594b6d8ab55b99cdf612b4c312',
};
const GET_SLOT0 = '0xc815641c';   // StateView.getSlot0(bytes32)

/** What a person must look at, with what to do about it. */
export const FAST_ATTENTION = {
  'over-limit': 'above the per-transfer limit: the bot does not pay it; the operator refunds or pays it by hand',
  'below-fee': 'smaller than the fee: nothing to pay; the operator decides whether to refund',
  'insufficient-inventory': 'the inventory cannot cover it now (or has no gas): refill the inventory by the slow bridge; it is paid on the next tick after that',
  'contract-sender': '⛔ the bMOLI came from a CONTRACT address: its key-holder is unknown, so MOLI is not sent to that address; the operator resolves it',
  'reorged': '⛔ the source tx moved or vanished after it was confirmed: nothing was paid; the fast leg is paused',
  'payout-reverted': '⛔ a payout reverted on chain: the fast leg is paused',
  'gas-too-high': 'Ethereum gas is above the cap; it retries',
  'waiting-gas': 'gas now costs more than the fee this transfer carries: it waits and retries (the operator never absorbs gas)',
};

const lower = (s) => String(s).toLowerCase();
const isHash = (h) => /^0x[0-9a-f]{64}$/.test(lower(h));
const topicAddr = (t) => '0x' + lower(t).slice(-40);
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr32 = (a) => lower(a).replace(/^0x/, '').padStart(64, '0');

/** ERC-20 transfer(recipient, amount) with the 32-byte source hash appended. */
export function erc20PayoutData(recipient, amount, srcHash) {
  if (!isHash(srcHash)) throw new Error('payout needs a 32-byte source hash');
  return '0xa9059cbb' + addr32(recipient) + word(amount) + lower(srcHash).slice(2);
}
/** The source hash a payout carries, or null. */
export function sourceOfErc20Payout(data) {
  const d = lower(data || '');
  if (!d.startsWith('0xa9059cbb') || d.length !== 2 + 8 + 64 * 3) return null;
  return '0x' + d.slice(-64);
}
/**
 * The fee on `amount` (wei), and what is paid out. The user pays every cost:
 * fee = max(feeBp of the amount, gasMargin x the payout's live gas cost in MOLI,
 * minFee). `gasMoliWei` is that gas cost (0 when unknown, tests of the floor).
 */
export function quote(amount, cfg = FAST_DEFAULTS, gasMoliWei = 0n) {
  const a = BigInt(amount);
  let fee = (a * BigInt(cfg.feeBp)) / 10_000n;
  const gasFee = BigInt(gasMoliWei) * BigInt(cfg.gasMargin ?? 2n);
  if (fee < gasFee) fee = gasFee;
  if (fee < BigInt(cfg.minFeeWei)) fee = BigInt(cfg.minFeeWei);
  return { amount: a, fee, out: a > fee ? a - fee : 0n };
}
/** bMOLI-wei per 1 ETH (1e18 wei) from a v4 sqrtPriceX96 (token1 bMOLI per token0 ETH). */
export function bmoliPerEthE18(sqrtPriceX96) {
  const sq = BigInt(sqrtPriceX96);
  return (sq * sq * WEI) >> 192n;
}

export class FastBridge {
  /**
   * @param {object} o
   * @param {object} o.io    { molibra: { get, rpc }, molibraNodes?: [{ name, get }],
   *                           eth: { rpc, logs, send } }
   * @param {string} o.key   the inventory's hex private key (null = read-only)
   * @param {object} o.state persisted state for this leg (mutated in place)
   */
  constructor({ io, key, state, save, log, now = () => Date.now(), config = {} }) {
    this.io = io;
    this.cfg = { ...FAST_DEFAULTS, ...config };
    this.state = state;
    this.saveState = save ?? (() => {});
    this.log = log ?? (() => {});
    this.now = now;
    // The signer takes 64 hex characters, without the 0x (keys.json may carry either).
    this.key = key ? String(key).replace(/^0x/, '') : null;
    this.inventory = this.key ? lower(normalizeAddress(privateToAddress(String(this.key).replace(/^0x/, ''))))
      : (config.inventory ? lower(config.inventory) : null);
    if (!this.inventory) throw new Error('the fast leg needs the inventory key (or an address, read-only)');
    state.version ??= 1;
    state.items ??= {};       // keyed by SOURCE tx hash
    state.readFailures ??= 0;
  }

  save() { this.saveState(this.state); }

  /** One pass. Returns a summary; never throws for one item's trouble. */
  async tick() {
    const live = !this.cfg.dryRun && Boolean(this.key);
    if (this.state.paused) {
      return { ...this.summary(), paused: this.state.paused, live, errors: [] };
    }
    const errors = [];
    const ctx = { live, ethSent: false, molibraSent: false };
    let tips;
    try {
      const status = await this.io.molibra.get('/molibra');
      tips = { molibra: BigInt(status.height), eth: BigInt(await this.io.eth.logs('eth_blockNumber', [])) };
      // A fresh state starts at the tips: history is never re-paid.
      this.state.molibraNext ??= (tips.molibra + 1n).toString();
      this.state.ethNext ??= (tips.eth + 1n).toString();
    } catch (e) {
      return this.readFailed(`tips: ${e.message}`, live);
    }
    this.state.readFailures = 0;
    // The live gas cost of one payout each way, in MOLI-wei; null when unreadable
    // (then nothing is paid this tick: a fee is never set without it).
    tips.gas = await this.gasCosts().catch((e) => {
      this.log('warn', 'fast-gas-unreadable', { error: e.message });
      return null;
    });
    for (const [name, leg] of [
      ['scan-molibra', () => this.scanMolibra(tips)],
      ['scan-eth', () => this.scanEth(tips)],
      ['payouts', () => this.payouts(tips, ctx)],
      ['sweep', () => this.sweep(ctx)],
    ]) {
      try { await leg(); } catch (e) {
        errors.push(`${name}: ${e.message}`);
        this.log('error', `fast-${name}-failed`, { error: e.message });
      }
      if (this.state.paused) break;
    }
    this.save();
    return { ...this.summary(), paused: this.state.paused ?? null, live, errors };
  }

  readFailed(why, live) {
    this.state.readFailures += 1;
    this.log('warn', 'fast-read-failed', { why, consecutive: this.state.readFailures });
    if (this.state.readFailures >= this.cfg.readFailPauseAfter) this.pause(`could not read the chains ${this.state.readFailures} ticks in a row (${why})`);
    this.save();
    return { ...this.summary(), paused: this.state.paused ?? null, live, errors: [why] };
  }

  /**
   * What one payout costs right now, in MOLI-wei: m2b = an Ethereum ERC-20
   * transfer (gas limit x (2 x base + tip)) converted at the bMOLI/ETH pool;
   * b2m = a Molibra transfer carrying 32 bytes of data, at the node's gas price.
   */
  async gasCosts() {
    const latest = await this.io.eth.rpc('eth_getBlockByNumber', ['latest', false]);
    const maxFee = BigInt(latest.baseFeePerGas ?? '0x0') * 2n + this.cfg.tipWei;
    const slot0 = await this.io.eth.rpc('eth_call', [{ to: this.cfg.stateView,
      data: GET_SLOT0 + lower(this.cfg.bmoliPoolId).replace(/^0x/, '') }, 'latest']);
    const sqrt = BigInt('0x' + String(slot0).replace(/^0x/, '').slice(0, 64));
    if (sqrt === 0n) throw new Error('the bMOLI/ETH pool reports no price');
    const m2b = (this.cfg.erc20GasLimit * maxFee * bmoliPerEthE18(sqrt)) / WEI;
    const mGasPrice = BigInt(await this.io.molibra.rpc('eth_gasPrice', []));
    const b2m = intrinsicGas({ data: '0x' + '11'.repeat(32) }) * mGasPrice;
    return { m2b, b2m };
  }

  pause(reason, extra = {}) {
    this.state.paused = { reason, at: new Date(this.now()).toISOString(), ...extra };
    this.log('error', 'fast-paused', this.state.paused);
  }

  /* --------------------------------------------------------------- scans */

  /** MOLI into the inventory, recorded only once K blocks deep. */
  async scanMolibra(tips) {
    const safe = tips.molibra - this.cfg.molibraConfirmations;
    let next = BigInt(this.state.molibraNext);
    for (let pages = 0; next <= safe && pages < this.cfg.maxScanPagesPerTick; pages++) {
      const to = next + BigInt(MAX_BLOCK_RANGE) - 1n > safe ? safe : next + BigInt(MAX_BLOCK_RANGE) - 1n;
      const page = await this.io.molibra.get(`/molibra/blocks?from=${next}&to=${to}`);
      for (const b of page.blocks ?? []) this.scanMolibraBlock(b, tips);
      if (!page.blocks?.length) break;
      next = BigInt(page.to) + 1n;
      this.state.molibraNext = next.toString();
      this.save();
    }
  }

  scanMolibraBlock(b, tips) {
    const header = b.header ?? b;
    const n = BigInt(header.number);
    for (const raw of b.transactions ?? []) {
      let tx;
      try { tx = decodeTransaction(typeof raw === 'string' ? raw : raw.raw, MOLIBRA_CHAIN_ID); } catch { continue; }
      if (lower(tx.to ?? '') !== this.inventory || lower(tx.from) === this.inventory) continue;
      if (BigInt(tx.value) === 0n || this.state.items[tx.hash]) continue;
      this.state.items[tx.hash] = {
        dir: 'm2b', from: lower(tx.from), amount: BigInt(tx.value).toString(),
        srcBlock: n.toString(), srcBlockHash: header.hash ?? null, status: 'confirmed',
        seenAt: new Date(this.now()).toISOString(), checkFromEth: tips.eth.toString(),
        feeWei: tips.gas ? quote(tx.value, this.cfg, tips.gas.m2b).fee.toString() : null,
      };
      this.log('info', 'fast-inbound', { dir: 'm2b', tx: tx.hash, from: tx.from, amount: BigInt(tx.value).toString() });
    }
  }

  /** bMOLI into the inventory, recorded only once N blocks deep. */
  async scanEth(tips) {
    const safe = tips.eth - this.cfg.ethConfirmations;
    let next = BigInt(this.state.ethNext);
    for (let i = 0; next <= safe && i < this.cfg.maxLogChunksPerTick; i++) {
      const to = next + this.cfg.logChunk - 1n > safe ? safe : next + this.cfg.logChunk - 1n;
      const logs = await this.io.eth.logs('eth_getLogs', [{
        address: BMOLI_CONTRACT, fromBlock: '0x' + next.toString(16), toBlock: '0x' + to.toString(16),
        topics: [TRANSFER_TOPIC, null, '0x' + addr32(this.inventory)],
      }]);
      for (const l of logs ?? []) {
        const from = topicAddr(l.topics[1]);
        if (from === this.inventory || l.removed) continue;
        const h = lower(l.transactionHash);
        if (this.state.items[h]) continue;
        this.state.items[h] = {
          dir: 'b2m', from, amount: BigInt(l.data).toString(), srcBlock: BigInt(l.blockNumber).toString(),
          srcBlockHash: lower(l.blockHash), logIndex: Number(BigInt(l.logIndex)), status: 'confirmed',
          seenAt: new Date(this.now()).toISOString(), checkFromMolibra: tips.molibra.toString(),
          feeWei: tips.gas ? quote(BigInt(l.data), this.cfg, tips.gas.b2m).fee.toString() : null,
        };
        this.log('info', 'fast-inbound', { dir: 'b2m', tx: h, from, amount: BigInt(l.data).toString() });
      }
      next = to + 1n;
      this.state.ethNext = next.toString();
      this.save();
    }
  }

  /* ------------------------------------------------------------- payouts */

  async payouts(tips, ctx) {
    const open = Object.entries(this.state.items)
      .filter(([, it]) => !['paid', 'over-limit', 'below-fee', 'contract-sender', 'reorged', 'payout-reverted'].includes(it.status))
      .sort(([, a], [, b]) => (a.seenAt < b.seenAt ? -1 : 1));
    for (const [hash, it] of open) {
      if (this.state.paused) return;
      try { await this.advance(hash, it, tips, ctx); } catch (e) {
        it.lastError = String(e.message).slice(0, 200);
        this.log('warn', 'fast-item-error', { tx: hash, error: it.lastError });
      }
    }
  }

  set(hash, it, status, extra = {}) {
    if (it.status !== status) this.log('info', 'fast-status', { tx: hash, dir: it.dir, from: it.status, to: status, ...extra });
    Object.assign(it, { status, ...extra });
  }

  /** Sum paid (or in flight) in a direction, or all, since `sinceMs`. */
  usedSince(sinceMs, dir = null) {
    return Object.values(this.state.items)
      .filter((x) => (x.status === 'paid' || x.status === 'sent') && x.paidAt && Date.parse(x.paidAt) >= sinceMs)
      .filter((x) => !dir || x.dir === dir)
      .reduce((s, x) => s + BigInt(x.amount), 0n);
  }

  async advance(hash, it, tips, ctx) {
    const isM2b = it.dir === 'm2b';
    const busy = isM2b ? ctx.ethSent : ctx.molibraSent;

    // 1. A payout already sent: its receipt decides.
    if (it.status === 'sent') {
      const r = await this.payoutReceipt(it);
      if (r && r.ok) { this.set(hash, it, 'paid'); return; }
      if (r && !r.ok) { this.set(hash, it, 'payout-reverted'); this.pause(`payout ${it.payoutTx} for ${hash} reverted`); return; }
      if (this.now() - Date.parse(it.sentAt) < (isM2b ? this.cfg.ethResendAfterMs : this.cfg.molibraResendAfterMs)) {
        if (ctx.live) await this.rebroadcast(it).catch(() => {});
        if (isM2b) ctx.ethSent = true; else ctx.molibraSent = true;
        return;
      }
      // Stale and not mined: fall through and build again (same nonce on Ethereum;
      // 'latest' nonce on Molibra supersedes) - after the duplicate search below.
    }

    // 2. The source is still where it was confirmed (a deeper reorg pauses everything).
    if (!(await this.sourceStillThere(hash, it))) {
      this.set(hash, it, 'reorged');
      this.pause(`source ${hash} moved or vanished after confirmation`, { tx: hash });
      return;
    }
    // ⛔ The check itself may have paused the leg (nodes disagreeing): stop here.
    if (this.state.paused) return;

    // 3. Already paid by an earlier run? (ground truth, not memory)
    const prior = await this.findPayoutOnChain(hash, it, tips);
    if (prior) { this.set(hash, it, 'paid', { payoutTx: prior, note: 'found on chain' }); return; }

    // 4. Rules: size, fee (the user pays every cost), limits.
    const amount = BigInt(it.amount);
    if (amount > this.cfg.maxPerTransferWei) { this.set(hash, it, 'over-limit'); return; }
    const gasNow = tips.gas ? BigInt(tips.gas[it.dir]) : null;
    if (gasNow === null) { this.set(hash, it, 'ready', { note: 'gas price unreadable this tick; retried' }); return; }
    // The fee is fixed when the transfer is recorded (what the page quoted at send
    // time); an item recorded while gas was unreadable gets it now.
    if (it.feeWei === null || it.feeWei === undefined) it.feeWei = quote(amount, this.cfg, gasNow).fee.toString();
    const fee = BigInt(it.feeWei);
    const q = { amount, fee, out: amount > fee ? amount - fee : 0n };
    if (q.out === 0n) { this.set(hash, it, 'below-fee'); return; }
    // ⛔ A gas spike past the fee this transfer carries: wait, never absorb it.
    if (gasNow > fee) {
      this.set(hash, it, 'waiting-gas', { gasNowWei: gasNow.toString(), feeWei: fee.toString() });
      return;
    }
    if (!isM2b && (await this.isContract(it.from))) { this.set(hash, it, 'contract-sender'); return; }
    const now = this.now();
    if (this.usedSince(now - HOUR, it.dir) + q.amount > this.cfg.maxPerHourWei
        || this.usedSince(now - DAY) + q.amount > this.cfg.maxPerDayWei) {
      this.set(hash, it, 'waiting-limit', { note: 'the rolling hourly/daily limit is full; it is paid when the window moves' });
      return;
    }
    if (busy) { this.set(hash, it, 'ready', { note: 'one payout per direction per tick' }); return; }

    // 5. Sign, read back, send (or stop at dry-run).
    if (isM2b) await this.payOnEthereum(hash, it, q, ctx);
    else await this.payOnMolibra(hash, it, q, ctx);
  }

  /** The source tx is canonical at the block it was confirmed in. */
  async sourceStillThere(hash, it) {
    if (it.dir === 'm2b') {
      const found = await this.io.molibra.get(`/molibra/tx/${hash}`);
      if (!found || found.error || !found.transaction) return false;
      if (BigInt(found.transaction.blockNumber) !== BigInt(it.srcBlock)) return false;
      if (it.srcBlockHash && found.transaction.blockHash && lower(found.transaction.blockHash) !== lower(it.srcBlockHash)) return false;
      // Two nodes must agree about the block that holds it.
      const nodes = this.io.molibraNodes ?? [];
      if (nodes.length > 1 && it.srcBlockHash) {
        const seen = new Set();
        for (const n of nodes) {
          const b = await n.get(`/molibra/block/${it.srcBlock}`).catch(() => null);
          const h = b && (b.header?.hash ?? b.hash);
          if (h) seen.add(lower(h));
        }
        if (seen.size > 1) {
          this.pause(`Molibra nodes disagree about block ${it.srcBlock}`, { hashes: [...seen] });
          return true;  // the pause, not a reorg verdict
        }
      }
      return true;
    }
    const r = await this.io.eth.rpc('eth_getTransactionReceipt', [hash]);
    if (!r || BigInt(r.status) !== 1n) return false;
    if (lower(r.blockHash) !== lower(it.srcBlockHash)) return false;
    return (r.logs ?? []).some((l) => lower(l.address) === lower(BMOLI_CONTRACT)
      && lower(l.topics?.[0] ?? '') === lower(TRANSFER_TOPIC)
      && topicAddr(l.topics[2]) === this.inventory && topicAddr(l.topics[1]) === it.from
      && BigInt(l.data) === BigInt(it.amount));
  }

  async isContract(address) {
    const code = await this.io.eth.rpc('eth_getCode', [address, 'latest']);
    return Boolean(code && code !== '0x' && code !== '0x0');
  }

  /** A payout carrying this source hash, already on chain - or null. */
  async findPayoutOnChain(hash, it, tips) {
    if (it.dir === 'm2b') {
      const from = BigInt(it.checkFromEth ?? tips.eth);
      for (let f = from; f <= tips.eth; f += this.cfg.logChunk) {
        const t = f + this.cfg.logChunk - 1n > tips.eth ? tips.eth : f + this.cfg.logChunk - 1n;
        const logs = await this.io.eth.logs('eth_getLogs', [{
          address: BMOLI_CONTRACT, fromBlock: '0x' + f.toString(16), toBlock: '0x' + t.toString(16),
          topics: [TRANSFER_TOPIC, '0x' + addr32(this.inventory), '0x' + addr32(it.from)],
        }]);
        for (const l of logs ?? []) {
          const tx = await this.io.eth.rpc('eth_getTransactionByHash', [l.transactionHash]);
          if (tx && sourceOfErc20Payout(tx.input) === lower(hash)) return lower(l.transactionHash);
        }
      }
      return null;
    }
    const from = BigInt(it.checkFromMolibra ?? tips.molibra);
    for (let f = from; f <= tips.molibra; f += BigInt(MAX_BLOCK_RANGE)) {
      const page = await this.io.molibra.get(`/molibra/blocks?from=${f}&to=${tips.molibra}`);
      for (const b of page.blocks ?? []) {
        for (const raw of b.transactions ?? []) {
          let tx;
          try { tx = decodeTransaction(typeof raw === 'string' ? raw : raw.raw, MOLIBRA_CHAIN_ID); } catch { continue; }
          if (lower(tx.from) === this.inventory && lower(tx.data) === lower(hash)) return tx.hash;
        }
      }
      if (!page.blocks?.length) break;
    }
    return null;
  }

  async payoutReceipt(it) {
    if (it.dir === 'm2b') {
      const r = await this.io.eth.rpc('eth_getTransactionReceipt', [it.payoutTx]).catch(() => null);
      return r ? { ok: BigInt(r.status) === 1n } : null;
    }
    const found = await this.io.molibra.get(`/molibra/tx/${it.payoutTx}`).catch(() => null);
    if (!found || found.error || !found.receipt) return null;
    return { ok: BigInt(found.receipt.status) === 1n };
  }

  async rebroadcast(it) {
    if (it.dir === 'm2b') return this.io.eth.send('eth_sendRawTransaction', [it.payoutRaw]);
    return this.io.molibra.rpc('eth_sendRawTransaction', [it.payoutRaw]);
  }

  async payOnEthereum(hash, it, q, ctx) {
    const eth = this.io.eth;
    const from = this.inventory;
    const have = BigInt(await eth.rpc('eth_call', [{ to: BMOLI_CONTRACT, data: '0x70a08231' + addr32(from) }, 'latest']));
    const data = erc20PayoutData(it.from, q.out, hash);
    const latest = await eth.rpc('eth_getBlockByNumber', ['latest', false]);
    const base = BigInt(latest.baseFeePerGas ?? '0x0');
    let tip = this.cfg.tipWei;
    let maxFee = base * 2n + tip;
    const replacing = it.status === 'sent' && it.nonce !== undefined;
    if (replacing) {
      const bump = (v) => (v * 9n) / 8n + 1n;
      tip = tip > bump(BigInt(it.tip)) ? tip : bump(BigInt(it.tip));
      maxFee = maxFee > bump(BigInt(it.maxFee)) ? maxFee : bump(BigInt(it.maxFee));
    }
    if (maxFee > this.cfg.maxFeeCapWei) { this.set(hash, it, 'gas-too-high', { maxFee: maxFee.toString() }); return; }
    const gas = this.cfg.erc20GasLimit;
    const ethBal = BigInt(await eth.rpc('eth_getBalance', [from, 'latest']));
    if (have < q.out || ethBal < gas * maxFee) {
      this.set(hash, it, 'insufficient-inventory', { needWei: q.out.toString(), haveWei: have.toString(),
        needGasWei: (gas * maxFee).toString(), haveGasWei: ethBal.toString() });
      return;
    }
    // ⛔ The exact call, simulated: a revert is an answer, read before signing.
    await eth.rpc('eth_call', [{ from, to: BMOLI_CONTRACT, data }, 'latest']);
    const nonce = replacing ? BigInt(it.nonce) : BigInt(await eth.rpc('eth_getTransactionCount', [from, 'pending']));
    const raw = signEip1559({ chainId: 1n, nonce, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee,
      gasLimit: gas, to: BMOLI_CONTRACT, value: 0n, data }, this.key);
    const back = decodeEip1559(raw);
    if (back.from !== from || lower(back.to) !== lower(BMOLI_CONTRACT) || back.data !== lower(data)
        || back.value !== 0n || back.chainId !== 1n) {
      throw new Error('the signed payout does not read back as intended - refusing');
    }
    const fees = { tip: tip.toString(), maxFee: maxFee.toString(), nonce: nonce.toString(),
      fee: q.fee.toString(), out: q.out.toString() };
    if (!ctx.live) {
      this.set(hash, it, 'ready', { note: 'DRY-RUN: simulated, signed and read back, NOT sent', ...fees });
      return;
    }
    const sent = await eth.send('eth_sendRawTransaction', [raw]);
    ctx.ethSent = true;
    this.set(hash, it, 'sent', { payoutTx: lower(sent), payoutRaw: raw, sentAt: new Date(this.now()).toISOString(),
      paidAt: new Date(this.now()).toISOString(), ...fees });
    this.recordPayout(hash, it);
  }

  /** The excess over max (with the 10% trigger), or 0n. Pure. */
  static excess(balance, max, triggerBp, cost = 0n) {
    if (balance * 10_000n <= max * triggerBp) return 0n;
    const amt = balance - max - cost;
    return amt > 0n ? amt : 0n;
  }

  /**
   * Sweep the inventory above max to the cold wallet. Skipped on a chain where
   * this tick sent a payout or a payout is still unconfirmed (no nonce races).
   */
  async sweep(ctx) {
    const busy = (dir) => Object.values(this.state.items ?? {}).some((x) => x.dir === dir && x.status === 'sent');
    const cold = lower(this.cfg.coldWallet);
    // Molibra: native MOLI.
    if (!ctx.molibraSent && !busy('b2m')) {
      const m = this.io.molibra;
      const bal = BigInt(await m.rpc('eth_getBalance', [this.inventory, 'latest']));
      const gasPrice = BigInt(await m.rpc('eth_gasPrice', []));
      const gasLimit = intrinsicGas({ data: '0x' });
      const amt = FastBridge.excess(bal, this.cfg.maxInventoryMoliWei, this.cfg.sweepTriggerBp, gasLimit * gasPrice);
      if (amt > 0n) {
        if (!ctx.live) this.log('info', 'fast-sweep-dry-run', { chain: 'molibra', amountWei: amt.toString(), to: cold });
        else {
          const nonce = BigInt(await m.rpc('eth_getTransactionCount', [this.inventory, 'latest']));
          const raw = toHex(signTransaction({ nonce, gasPrice, gasLimit, to: cold, value: amt, data: '0x' }, this.key, MOLIBRA_CHAIN_ID));
          const back = decodeTransaction(raw, MOLIBRA_CHAIN_ID);
          if (back.from !== this.inventory || lower(back.to) !== cold || back.value !== amt) throw new Error('sweep tx does not read back as intended - refusing');
          const tx = await m.rpc('eth_sendRawTransaction', [raw]);
          ctx.molibraSent = true;
          this.log('info', 'fast-sweep', { chain: 'molibra', amountWei: amt.toString(), to: cold, tx });
        }
      }
    }
    // Ethereum: bMOLI (ERC-20), gas in ETH from the inventory.
    if (!ctx.ethSent && !busy('m2b')) {
      const eth = this.io.eth;
      const bal = BigInt(await eth.rpc('eth_call', [{ to: BMOLI_CONTRACT, data: '0x70a08231' + addr32(this.inventory) }, 'latest']));
      const amt = FastBridge.excess(bal, this.cfg.maxInventoryBmoliWei, this.cfg.sweepTriggerBp);
      if (amt > 0n) {
        const data = '0xa9059cbb' + addr32(cold) + amt.toString(16).padStart(64, '0');
        if (!ctx.live) this.log('info', 'fast-sweep-dry-run', { chain: 'ethereum', amountWei: amt.toString(), to: cold });
        else {
          const latest = await eth.rpc('eth_getBlockByNumber', ['latest', false]);
          const tip = this.cfg.tipWei; const maxFee = BigInt(latest.baseFeePerGas ?? '0x0') * 2n + tip;
          if (maxFee > this.cfg.maxFeeCapWei) { this.log('warn', 'fast-sweep-gas-too-high', { maxFee: maxFee.toString() }); return; }
          await eth.rpc('eth_call', [{ from: this.inventory, to: BMOLI_CONTRACT, data }, 'latest']);
          const nonce = BigInt(await eth.rpc('eth_getTransactionCount', [this.inventory, 'pending']));
          const raw = signEip1559({ chainId: 1n, nonce, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee,
            gasLimit: this.cfg.erc20GasLimit, to: BMOLI_CONTRACT, value: 0n, data }, this.key);
          const back = decodeEip1559(raw);
          if (back.from !== this.inventory || lower(back.to) !== lower(BMOLI_CONTRACT) || back.data !== lower(data)) throw new Error('sweep tx does not read back as intended - refusing');
          const tx = await eth.send('eth_sendRawTransaction', [raw]);
          ctx.ethSent = true;
          this.log('info', 'fast-sweep', { chain: 'ethereum', amountWei: amt.toString(), to: cold, tx });
        }
      }
    }
  }

  async payOnMolibra(hash, it, q, ctx) {
    const m = this.io.molibra;
    const from = this.inventory;
    const data = lower(hash);
    const gasPrice = BigInt(await m.rpc('eth_gasPrice', []));
    const gasLimit = intrinsicGas({ data });
    const balance = BigInt(await m.rpc('eth_getBalance', [from, 'latest']));
    if (balance < q.out + gasLimit * gasPrice) {
      this.set(hash, it, 'insufficient-inventory', { needWei: (q.out + gasLimit * gasPrice).toString(), haveWei: balance.toString() });
      return;
    }
    // 'latest', not 'pending': never chained, so the confirmed nonce is next and supersedes a stuck one.
    const nonce = BigInt(await m.rpc('eth_getTransactionCount', [from, 'latest']));
    const raw = toHex(signTransaction({ nonce, gasPrice, gasLimit, to: it.from, value: q.out, data },
      this.key, MOLIBRA_CHAIN_ID));
    const back = decodeTransaction(raw, MOLIBRA_CHAIN_ID);
    if (back.from !== from || lower(back.to) !== lower(it.from) || back.data !== data || back.value !== q.out) {
      throw new Error('the signed Molibra payout does not read back as intended - refusing');
    }
    const fees = { nonce: nonce.toString(), fee: q.fee.toString(), out: q.out.toString() };
    if (!ctx.live) {
      this.set(hash, it, 'ready', { note: 'DRY-RUN: signed and read back, NOT sent', ...fees });
      return;
    }
    const sent = await m.rpc('eth_sendRawTransaction', [raw]);
    ctx.molibraSent = true;
    this.set(hash, it, 'sent', { payoutTx: lower(sent), payoutRaw: raw, sentAt: new Date(this.now()).toISOString(),
      paidAt: new Date(this.now()).toISOString(), ...fees });
    this.recordPayout(hash, it);
  }

  /** The service appends this to an append-only ledger (a second guard beside the chain search). */
  recordPayout(hash, it) {
    this.onPayout?.({ src: hash, dir: it.dir, to: it.from, out: it.out, payoutTx: it.payoutTx, at: it.sentAt });
  }

  /* -------------------------------------------------------------- output */

  summary() {
    const count = Object.values(this.state.items).reduce((acc, x) => ({ ...acc, [x.status]: (acc[x.status] ?? 0) + 1 }), {});
    return { fast: { inventory: this.inventory, items: count } };
  }

  pendingItems() {
    const items = [];
    if (this.state.paused) {
      items.push({ leg: 'fast', status: 'paused', why: '⛔ the fast leg is PAUSED: investigate, then delete "paused" from fast-state.json (or the whole entry) to resume',
        detail: this.state.paused });
    }
    for (const [tx, it] of Object.entries(this.state.items)) {
      if (FAST_ATTENTION[it.status]) {
        items.push({ leg: 'fast', dir: it.dir, sourceTx: tx, from: it.from, amountWei: it.amount, status: it.status,
          why: FAST_ATTENTION[it.status], detail: it.note ?? it.lastError ?? null });
      }
    }
    return items;
  }
}
