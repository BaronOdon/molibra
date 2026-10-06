/**
 * Molibra bridge bot - the logic, with every network call injected.
 *
 * Two legs, each a small state machine whose every step re-reads ground truth
 * from the chains before acting, so a restart, a crash or a duplicate run
 * re-derives where it is instead of trusting its own memory:
 *
 *  1. AUTO-CLAIM bMOLI. Every MOLI burn on Molibra (found by scanning blocks,
 *     the node has no eth_getLogs) is claimed on Ethereum by the RELAYER key
 *     once its block is anchored and the challenge window has passed. The mint
 *     goes to the burner by contract design; the relayer pays gas, nothing else.
 *     ⛔ Before every send: claimed(tx) on Ethereum, status(height), and an
 *     eth_call of the EXACT calldata, with the revert read by name.
 *
 *  2. AUTO-RETURN. Every bMOLI Transfer into the return vault (eth_getLogs) is,
 *     after CONFIRMATIONS blocks, proved (src/returnproof.js: trie rebuilt and
 *     the block's root cross-checked on independent RPCs), and from the
 *     header-bot flag day the HEADER BOT commits the root and relays the
 *     MOLI_RETURN. A return the rolling cap would refuse is NOT sent: it is
 *     written to pending-operator.json for the operator, whose commit of the
 *     same root lifts the cap.
 *
 * ⛔ Below BOT_HEADER_ACTIVATION, or against a node that does not publish the
 *    bot rules, the return leg is dry-run whatever the flags say.
 * ⛔ At most ONE transaction per leg per tick, and never a second while one is
 *    unconfirmed: a refused Molibra tx is dropped, not mined, so a chained
 *    second tx would sit behind a nonce gap.
 */
import { decodeTransaction, signTransaction, intrinsicGas } from '../src/tx.js';
import { keccak256, toHex, fromHex, normalizeAddress, privateToAddress } from '../src/crypto.js';
import { decodeMoliBurn, MOLI_BURN_ACTIVATION } from '../src/moliburn.js';
import {
  decodeMoliReturn, returnKey, MOLI_RETURN_ADDRESS, BMOLI_CONTRACT, ETH_HEADER_AUTHORITY,
  ETH_HEADER_BOT, BRIDGE_V2_ACTIVATION, BOT_HEADER_ACTIVATION, BOT_RETURN_CAP,
} from '../src/molireturn.js';
import { TRANSFER_TOPIC } from '../src/burnproof.js';
import { MAX_REORG_DEPTH, MAX_BLOCK_RANGE } from '../src/limits.js';
import {
  claimFromProof, claimedCall, statusCall, decodeStatus, revertName,
} from '../src/bmoliclaim.js';
import { buildReturn, RpcDisagreement } from '../src/returnproof.js';
import { signEip1559, decodeEip1559 } from '../src/eth1559.js';

export const MOLIBRA_CHAIN_ID = 20226n;

/**
 * ⭐ EXPRESS ANCHOR (operator, 6 Oct 2026). A burner who also pays a fee in MOLI
 * to EXPRESS_FEE_ADDRESS, from the SAME address, within EXPRESS_WINDOW_BLOCKS
 * after the burn, gets the anchor publisher run at once instead of waiting for
 * its daily schedule. The 7,200-block challenge window in BridgedMoli is
 * immutable, so express means ~24 h end to end instead of up to ~48 h.
 *
 * ⛔ The floor is conservative and fixed here; the page quotes the live price.
 * ⛔ anchor-publisher.mjs anchors a burn's block only once it is at least
 *    MAX_REORG_DEPTH + 1 deep (MIN_DEPTH there), so the trigger waits for that
 *    depth - fired earlier, the run would anchor below the burn and miss it.
 */
export const EXPRESS_FEE_ADDRESS = '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a';
export const EXPRESS_FLOOR_WEI = 10n * 10n ** 18n;
export const EXPRESS_WINDOW_BLOCKS = 100n;
export const EXPRESS_MIN_INTERVAL_MS = 10 * 60 * 1000;
export const ANCHOR_MIN_DEPTH = BigInt(MAX_REORG_DEPTH) + 1n;

/** The fee transfer that buys an express anchor for `burn`, or null. Pure. */
export function expressFeeFor(burn, fees, minWei = EXPRESS_FLOOR_WEI, windowBlocks = EXPRESS_WINDOW_BLOCKS) {
  const from = String(burn.from).toLowerCase();
  const h = BigInt(burn.height);
  for (const [hash, f] of Object.entries(fees ?? {})) {
    const fh = BigInt(f.height);
    if (String(f.from).toLowerCase() === from && BigInt(f.value) >= BigInt(minWei)
        && fh >= h && fh <= h + BigInt(windowBlocks)) return { hash, ...f };
  }
  return null;
}
const GWEI = 1_000_000_000n;

export const DEFAULTS = {
  // ⛔ Every system cost is paid by the user who triggers it (operator, 6 Oct
  //    2026). A burn is claimed and a return relayed automatically ONLY when its
  //    sender paid the fee to EXPRESS_FEE_ADDRESS within the window; unpaid ones
  //    go to pending-operator.json as 'unpaid-fee'. The page quotes the live fee.
  requireFees: true,
  claimFeeFloorWei: 5n * 10n ** 18n,      // MOLI, covers the relayer's Ethereum claim gas
  expressFeeFloorWei: 10n * 10n ** 18n,   // MOLI, on top of the claim fee, for an express anchor
  returnFeeFloorWei: 1n * 10n ** 18n,     // bMOLI, covers the header commit + return on Molibra
  feeWindowBlocks: 100n,                  // Molibra blocks after the burn
  ethFeeWindowBlocks: 100n,               // Ethereum blocks after the vault transfer
  dryRun: false,
  confirmations: 12n,
  // bMOLI (0xa302…) had no Transfer before this; checked 2 Oct 2026 by
  // eth_getLogs over [25,950,000, 26,060,000], and the first return is 26,050,548.
  ethStartBlock: 25_950_000n,
  logChunk: 5_000n,
  maxLogChunksPerTick: 60,
  maxScanPagesPerTick: 400,
  tipWei: 50_000_000n,             // 0.05 gwei: EXPLICIT and low, never a wallet's 2 gwei
  maxFeeCapWei: 20n * GWEI,        // above this the claim waits rather than overpays
  minClaimGas: 150_000n,
  ethResendAfterMs: 30 * 60_000,
  molibraResendAfterMs: 20 * 60_000,
  challengeBlocks: 7_200n,
};

/** Statuses that need a person, and what to tell them. */
const ATTENTION = {
  'awaiting-anchor': 'the burn\'s block is not anchored on Ethereum yet (is the anchor publisher funded and running?)',
  'unpaid-fee': 'no fee was paid for it within the window: not processed automatically, the operator decides',
  'relayer-unfunded': 'the Ethereum relayer has too little ETH for this claim',
  'gas-too-high': 'Ethereum gas is above the bot\'s cap; it will retry',
  'preflight-revert': 'the claim pre-flight reverts with an unexpected error',
  'rpc-disagreement': 'two Ethereum RPCs disagree about this block: nothing was submitted',
  'root-conflict': '⛔ the root committed on Molibra differs from what the RPCs say: investigate',
  'needs-operator': 'a single return above the bot cap, or a root from someone else: the operator commits the root (uncapped)',
  'waiting-cap': 'the rolling bot cap is full: it goes through when the window moves, or at once if the operator commits this root',
  'exceeds-outstanding': 'more than is outstanding across the bridge: consensus would refuse it',
  'bot-unfunded': 'the header bot has too little MOLI for fees',
};

const lower = (s) => String(s).toLowerCase();
const big = (v, d = 0n) => (v === undefined || v === null ? d : BigInt(v));

export class BridgeBot {
  /**
   * @param {object} o
   * @param {object} o.io      { molibra: { get(path), rpc(method, params) },
   *                             eth: { rpc, cross: [{name, rpc}], logs: rpc, send: rpc } }
   * @param {object} o.keys    { headerBot: hexKey, ethRelayer: hexKey }
   * @param {object} o.state   persisted state (mutated in place)
   * @param {Function} o.save  (state) => void, called after every mutation
   * @param {Function} o.log   (level, event, fields) => void
   * @param {Function} [o.now]
   */
  constructor({ io, keys, state, save, log, now = () => Date.now(), config = {} }) {
    this.io = io;
    this.cfg = { ...DEFAULTS, ...config };
    this.state = state;
    this.saveState = save ?? (() => {});
    this.log = log ?? (() => {});
    this.now = now;
    this.keys = keys;
    this.botAddress = keys?.headerBot ? lower(addressOf(keys.headerBot)) : null;
    this.relayer = keys?.ethRelayer ? lower(addressOf(keys.ethRelayer)) : null;
    // ⛔ The header key must BE the bot consensus knows, or every commit it
    //    signs is refused - and a wrong key in the file is better caught here.
    //    (`expectHeaderBot` exists for tests, whose mock node impersonates the
    //    bot; consensus refuses any other committer whatever this says.)
    const expected = lower(this.cfg.expectHeaderBot ?? ETH_HEADER_BOT);
    if (this.botAddress && this.botAddress !== expected) {
      throw new Error(`the header-bot key derives ${this.botAddress}, not ETH_HEADER_BOT ${expected}`);
    }
    if (this.relayer === lower(ETH_HEADER_AUTHORITY) || this.botAddress === lower(ETH_HEADER_AUTHORITY)) {
      throw new Error('⛔ a bot key derives the OPERATOR wallet: that key never lives on a server');
    }
    state.version ??= 1;
    state.molibraScan ??= { next: MOLI_BURN_ACTIVATION.toString() };
    state.ethScan ??= { next: this.cfg.ethStartBlock.toString() };
    state.burns ??= {};
    state.returns ??= {};
    state.spentReturnKeys ??= {};
    state.expressFees ??= {};
    state.ethFees ??= {};
  }

  save() { this.saveState(this.state); }

  /** One pass over both legs. Each leg's failure is logged, not fatal to the other. */
  async tick() {
    const status = await this.io.molibra.get('/molibra');
    const height = BigInt(status.height);
    const botRulesLive = height + 1n >= BOT_HEADER_ACTIVATION
      && Number(status.activations?.botHeaders?.height) === Number(BOT_HEADER_ACTIVATION)
      && lower(status.outbound?.botCap?.bot ?? '') === ETH_HEADER_BOT;
    const ctx = {
      height, status, recentKeys: new Set(), errors: [],
      claimsLive: !this.cfg.dryRun && Boolean(this.relayer),
      returnsLive: !this.cfg.dryRun && botRulesLive && Boolean(this.botAddress),
      botRulesLive, claimSent: false, molibraSent: false,
    };
    if (!ctx.returnsLive && !this.cfg.dryRun) {
      this.log('info', 'returns-dry-run', {
        reason: botRulesLive ? 'no header-bot key' : `height ${height} is below the bot flag day `
          + `${BOT_HEADER_ACTIVATION}, or the node does not publish the bot rules yet`,
      });
    }
    for (const [name, leg] of [['scan', () => this.scanMolibra(ctx)],
      ['claims', () => this.claims(ctx)], ['express', () => this.express(ctx)], ['returns', () => this.returns(ctx)]]) {
      try { await leg(); } catch (e) {
        ctx.errors.push(`${name}: ${e.message}`);
        this.log('error', `${name}-failed`, { error: e.message });
      }
    }
    this.save();
    return { ...this.summary(), height: height.toString(), claimsLive: ctx.claimsLive,
      returnsLive: ctx.returnsLive, errors: ctx.errors };
  }

  /* ----------------------------------------------------------- Molibra scan */

  /**
   * Burns (from MOLI_BURN_ACTIVATION) and spent return keys (from the
   * bridge-v2 flag day), by decoding every transaction in every block that used
   * gas. The persisted cursor stops MAX_REORG_DEPTH below the tip so nothing it
   * records can be reorged away; the last stretch is re-read every tick for
   * returns only, and that is never persisted.
   */
  async scanMolibra(ctx) {
    const safeTip = ctx.height - BigInt(MAX_REORG_DEPTH);
    let next = BigInt(this.state.molibraScan.next);
    let pages = 0;
    while (next <= safeTip && pages < this.cfg.maxScanPagesPerTick) {
      const to = next + BigInt(MAX_BLOCK_RANGE) - 1n > safeTip ? safeTip : next + BigInt(MAX_BLOCK_RANGE) - 1n;
      const page = await this.io.molibra.get(`/molibra/blocks?from=${next}&to=${to}`);
      for (const b of page.blocks ?? []) this.scanBlock(b, ctx, true);
      pages++;
      if (!page.blocks?.length) break;
      next = BigInt(page.to) + 1n;
      this.state.molibraScan.next = next.toString();
      this.save();
    }
    // The unsafe stretch, for returns only.
    let from = next > safeTip ? next : safeTip + 1n;
    while (from <= ctx.height) {
      const page = await this.io.molibra.get(`/molibra/blocks?from=${from}&to=${ctx.height}`);
      for (const b of page.blocks ?? []) this.scanBlock(b, ctx, false);
      if (!page.blocks?.length) break;
      from = BigInt(page.to) + 1n;
    }
    // ⛔ What the scan found must never exceed what the node says was burned.
    const found = Object.values(this.state.burns).reduce((s, b) => s + BigInt(b.amount), 0n);
    const burned = big(ctx.status.outbound?.burned);
    if (found > burned) {
      throw new Error(`the scan found ${found} wei of burns but the node reports ${burned}: refusing to act on it`);
    }
    this.log('info', 'scan', { scannedTo: (next - 1n).toString(), burnsFound: Object.keys(this.state.burns).length,
      foundWei: found.toString(), nodeBurnedWei: burned.toString(),
      unscannedTail: (burned - found).toString() });
  }

  scanBlock(b, ctx, persist) {
    const header = b.header ?? b;
    const n = BigInt(header.number);
    if (BigInt(header.gasUsed ?? 0) === 0n) return;
    for (const raw of b.transactions ?? []) {
      let tx;
      try { tx = decodeTransaction(typeof raw === 'string' ? raw : raw.raw, MOLIBRA_CHAIN_ID); } catch { continue; }
      let burn = null;
      let ret = null;
      try { burn = n >= MOLI_BURN_ACTIVATION ? decodeMoliBurn(tx.data) : null; } catch { /* not a burn */ }
      try { ret = n >= BRIDGE_V2_ACTIVATION ? decodeMoliReturn(tx.data) : null; } catch { /* not a return */ }
      if (burn && persist && !this.state.burns[tx.hash]) {
        this.state.burns[tx.hash] = {
          height: n.toString(), from: tx.from, recipient: lower(burn.recipient),
          amount: burn.amount.toString(), status: 'new', firstSeen: new Date(this.now()).toISOString(),
        };
        this.log('info', 'burn-found', { tx: tx.hash, height: n.toString(), amount: burn.amount.toString() });
      }
      // An express-anchor fee: a plain MOLI transfer to the fee address.
      if (persist && !burn && !ret && tx.to && lower(tx.to) === EXPRESS_FEE_ADDRESS
          && BigInt(tx.value ?? 0) > 0n && !this.state.expressFees[tx.hash]) {
        this.state.expressFees[tx.hash] = { from: lower(tx.from), height: n.toString(), value: BigInt(tx.value).toString() };
        this.log('info', 'express-fee-found', { tx: tx.hash, from: lower(tx.from), height: n.toString() });
      }
      if (ret) {
        const key = returnKey(ret.blockNumber, ret.txIndex);
        if (persist) this.state.spentReturnKeys[key] = { molibraTx: tx.hash, height: n.toString() };
        else ctx.recentKeys.add(key);
      }
    }
  }

  /* ----------------------------------------------------- 1b. express anchor */

  /**
   * Run the anchor publisher now for a paid burn that is not anchored yet.
   * At most one trigger per EXPRESS_MIN_INTERVAL_MS, never twice for one burn
   * (recorded in state, so a restart does not re-fire), never in dry-run.
   */
  async express(ctx) {
    for (const [hash, b] of Object.entries(this.state.burns)) {
      if (b.expressFiredAt || b.status === 'claimed') continue;
      if (b.status !== 'awaiting-anchor' && b.status !== 'new') continue;
      const fee = expressFeeFor(b, this.state.expressFees,
        this.cfg.claimFeeFloorWei + this.cfg.expressFeeFloorWei, this.cfg.feeWindowBlocks);
      if (!fee) continue;
      if (ctx.height < BigInt(b.height) + ANCHOR_MIN_DEPTH) {
        if (b.express !== 'waiting-depth') {
          this.log('info', 'express-waiting-depth', { tx: hash, readyAt: (BigInt(b.height) + ANCHOR_MIN_DEPTH).toString() });
        }
        b.express = 'waiting-depth';
        continue;
      }
      const last = this.state.lastExpressTriggerAt ? Date.parse(this.state.lastExpressTriggerAt) : 0;
      if (this.now() - last < EXPRESS_MIN_INTERVAL_MS) { b.express = 'rate-limited'; continue; }
      if (this.cfg.dryRun || !this.io.triggerAnchor) {
        this.log('info', 'express-dry-run', { tx: hash, fee: fee.hash, note: 'would run the anchor publisher now' });
        b.express = 'dry-run';
        continue;
      }
      await this.io.triggerAnchor();
      const at = new Date(this.now()).toISOString();
      this.state.lastExpressTriggerAt = at;
      Object.assign(b, { expressFiredAt: at, express: 'fired', expressFee: fee.hash });
      this.log('info', 'express-anchor-fired', { tx: hash, fee: fee.hash, height: b.height });
      return;   // one per tick: the publisher anchors the oldest unanchored burn first
    }
  }

  /* ------------------------------------------------------------ 1. claims */

  async claims(ctx) {
    const open = Object.entries(this.state.burns)
      .filter(([, b]) => b.status !== 'claimed')
      .sort(([, a], [, b]) => (BigInt(a.height) < BigInt(b.height) ? -1 : 1));
    for (const [hash, b] of open) {
      if (!this.claimPaid(hash, b, ctx)) { b.updatedAt = new Date(this.now()).toISOString(); continue; }
      try { await this.advanceClaim(hash, b, ctx); } catch (e) {
        b.lastError = e.message;
        this.log('warn', 'claim-error', { tx: hash, error: e.message });
      }
      b.updatedAt = new Date(this.now()).toISOString();
      this.save();
    }
  }

  /** True when the burner paid the claim fee; otherwise marks awaiting-fee / unpaid-fee. */
  claimPaid(hash, b, ctx) {
    if (b.feePaid || !this.cfg.requireFees) return true;
    const fee = expressFeeFor(b, this.state.expressFees, this.cfg.claimFeeFloorWei, this.cfg.feeWindowBlocks);
    if (fee) { b.feePaid = fee.hash; this.log('info', 'claim-fee-paid', { tx: hash, fee: fee.hash }); return true; }
    const status = ctx.height > BigInt(b.height) + this.cfg.feeWindowBlocks ? 'unpaid-fee' : 'awaiting-fee';
    if (b.status !== status) this.log('info', 'claim-status', { tx: hash, from: b.status, to: status });
    b.status = status;
    return false;
  }

  async advanceClaim(hash, b, ctx) {
    const eth = this.io.eth;
    const set = (status, extra = {}) => {
      if (b.status !== status) this.log('info', 'claim-status', { tx: hash, from: b.status, to: status, ...extra });
      Object.assign(b, { status, ...extra });
    };

    // Ground truth first: claimed by anybody, the bot included, is done.
    const claimed = await eth.rpc('eth_call', [{ to: BMOLI_CONTRACT, data: claimedCall(hash) }, 'latest']);
    if (BigInt(claimed || '0x0') !== 0n) { set('claimed', { note: b.ethTx ? 'claimed by the relayer' : 'already claimed' }); return; }

    let replacing = null;
    if (b.status === 'sent') {
      const r = await eth.rpc('eth_getTransactionReceipt', [b.ethTx]).catch(() => null);
      if (r && BigInt(r.status) === 1n) { set('claimed'); return; }
      if (r) { set('new', { note: `claim ${b.ethTx} reverted on chain`, ethTx: null }); return; }
      if (this.now() - Date.parse(b.sentAt) < this.cfg.ethResendAfterMs) {
        if (ctx.claimsLive) await eth.send('eth_sendRawTransaction', [b.raw]).catch(() => {}); // idempotent
        ctx.claimSent = true;  // one in flight: no second claim this tick
        return;
      }
      replacing = { nonce: BigInt(b.nonce), tip: BigInt(b.tip), maxFee: BigInt(b.maxFee) };
    }

    const st = decodeStatus(await eth.rpc('eth_call', [{ to: BMOLI_CONTRACT, data: statusCall(b.height) }, 'latest']));
    if (!st.anchored) { set('awaiting-anchor'); return; }
    if (!st.usable) {
      set('challenge-window', { usableAtEthBlock: (st.anchoredAt + this.cfg.challengeBlocks).toString() });
      return;
    }

    const proof = await this.io.molibra.get(`/molibra/proof/${hash}`);
    if (proof.error) throw new Error(`proof: ${proof.error}`);
    if (proof.canonicalOnThisNode === false) throw new Error('the burn is not canonical on this node');
    if (BigInt(proof.blockNumber) !== BigInt(b.height)) throw new Error('the proof is for another height');
    if (toHex(keccak256(fromHex(proof.raw))) !== lower(hash)) throw new Error('the proof\'s raw tx does not hash to the burn');
    const data = claimFromProof(proof);

    const from = this.relayer ?? lower(ETH_HEADER_AUTHORITY);
    try {
      await eth.rpc('eth_call', [{ from, to: BMOLI_CONTRACT, data }, 'latest']);
    } catch (e) {
      const name = revertName(e.data ?? e.message);
      if (name === 'AlreadyClaimed()') { set('claimed', { note: 'pre-flight: AlreadyClaimed' }); return; }
      set('preflight-revert', { revert: name ?? String(e.message).slice(0, 160) });
      return;
    }
    if (!this.relayer) { set('ready', { note: 'pre-flight clean; no relayer key loaded' }); return; }
    if (ctx.claimSent) { set('ready', { note: 'pre-flight clean; one claim per tick' }); return; }

    const latest = await eth.rpc('eth_getBlockByNumber', ['latest', false]);
    const base = BigInt(latest.baseFeePerGas ?? '0x0');
    let tip = this.cfg.tipWei;
    let maxFee = base * 2n + tip;
    if (replacing) {             // ⛔ same nonce, every fee up >= 12.5%, or nodes refuse it
      tip = tip > replacing.tip * 9n / 8n + 1n ? tip : replacing.tip * 9n / 8n + 1n;
      maxFee = maxFee > replacing.maxFee * 9n / 8n + 1n ? maxFee : replacing.maxFee * 9n / 8n + 1n;
    }
    if (maxFee > this.cfg.maxFeeCapWei) { set('gas-too-high', { maxFee: maxFee.toString() }); return; }
    let gas;
    try {
      gas = BigInt(await eth.rpc('eth_estimateGas', [{ from, to: BMOLI_CONTRACT, data }])) * 5n / 4n;
    } catch { gas = 0n; }
    if (gas < this.cfg.minClaimGas) gas = this.cfg.minClaimGas;
    const balance = BigInt(await eth.rpc('eth_getBalance', [from, 'latest']));
    if (balance < gas * maxFee) {
      set('relayer-unfunded', { needWei: (gas * maxFee).toString(), haveWei: balance.toString() });
      return;
    }
    const nonce = replacing ? replacing.nonce
      : BigInt(await eth.rpc('eth_getTransactionCount', [from, 'pending']));
    const raw = signEip1559({ chainId: 1n, nonce, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee,
      gasLimit: gas, to: BMOLI_CONTRACT, value: 0n, data }, this.keys.ethRelayer);
    // ⛔ Read back what was signed. A wrong `to` on mainnet is unrecoverable.
    const back = decodeEip1559(raw);
    if (back.from !== from || back.to !== BMOLI_CONTRACT || back.data !== lower(data)
        || back.value !== 0n || back.chainId !== 1n) {
      throw new Error('the signed claim does not read back as intended - refusing');
    }
    const fees = { tip: tip.toString(), maxFee: maxFee.toString(), gas: gas.toString(), nonce: nonce.toString() };
    if (!ctx.claimsLive) {
      set('ready', { note: 'DRY-RUN: pre-flight clean, signed and read back, NOT sent', ...fees });
      this.log('info', 'dry-run-claim', { tx: hash, wouldSend: back.hash, ...fees });
      return;
    }
    const sent = await eth.send('eth_sendRawTransaction', [raw]);
    ctx.claimSent = true;
    set('sent', { ethTx: sent, raw, sentAt: new Date(this.now()).toISOString(), ...fees });
  }

  /* ----------------------------------------------------------- 2. returns */

  async returns(ctx) {
    const latestEth = await this.scanEth();
    const open = Object.entries(this.state.returns)
      .filter(([h, r]) => r.status !== 'returned' && this.returnPaid(h, r, BigInt(latestEth ?? 0)));
    if (!open.length) return;
    const bridge = await this.io.molibra.get('/molibra/bridge');
    ctx.headers = new Map((bridge.headers ?? [])
      .filter((h) => String(h.chainId) === '1')
      .map((h) => [String(h.blockNumber), h]));
    for (const [hash, r] of open) {
      try { await this.advanceReturn(hash, r, ctx); } catch (e) {
        r.lastError = e.message;
        this.log('warn', 'return-error', { ethTx: hash, error: e.message });
      }
      r.updatedAt = new Date(this.now()).toISOString();
      this.save();
    }
  }

  async scanEth() {
    const latest = BigInt(await this.io.eth.logs('eth_blockNumber', []));
    const safe = latest - this.cfg.confirmations;
    let next = BigInt(this.state.ethScan.next);
    const vaultTopic = '0x' + MOLI_RETURN_ADDRESS.slice(2).padStart(64, '0');
    for (let i = 0; next <= safe && i < this.cfg.maxLogChunksPerTick; i++) {
      const to = next + this.cfg.logChunk - 1n > safe ? safe : next + this.cfg.logChunk - 1n;
      const logs = await this.io.eth.logs('eth_getLogs', [{
        address: BMOLI_CONTRACT, topics: [TRANSFER_TOPIC, null, vaultTopic],
        fromBlock: '0x' + next.toString(16), toBlock: '0x' + to.toString(16),
      }]);
      for (const l of logs ?? []) {
        if (l.removed) continue;
        if (lower(l.address) !== BMOLI_CONTRACT || lower(l.topics?.[2] ?? '') !== vaultTopic) continue;
        const h = lower(l.transactionHash);
        if (!this.state.returns[h]) {
          this.state.returns[h] = { blockNumber: BigInt(l.blockNumber).toString(), status: 'new',
            from: '0x' + String(l.topics?.[1] ?? '').slice(-40).toLowerCase(),
            firstSeen: new Date(this.now()).toISOString() };
          this.log('info', 'return-found', { ethTx: h, block: BigInt(l.blockNumber).toString() });
        }
      }
      // bMOLI fees: Transfer(any -> fee address) in the same range.
      const feeTopic = '0x' + EXPRESS_FEE_ADDRESS.slice(2).padStart(64, '0');
      const feeLogs = await this.io.eth.logs('eth_getLogs', [{
        address: BMOLI_CONTRACT, topics: [TRANSFER_TOPIC, null, feeTopic],
        fromBlock: '0x' + next.toString(16), toBlock: '0x' + to.toString(16),
      }]);
      for (const l of feeLogs ?? []) {
        if (l.removed || lower(l.address) !== BMOLI_CONTRACT) continue;
        const h = lower(l.transactionHash);
        this.state.ethFees[h] ??= { from: '0x' + String(l.topics?.[1] ?? '').slice(-40).toLowerCase(),
          height: BigInt(l.blockNumber).toString(), value: BigInt(l.data ?? '0x0').toString() };
      }
      next = to + 1n;
      this.state.ethScan.next = next.toString();
      this.save();
    }
    return latest;
  }

  /** True when the vault sender paid the return fee in bMOLI; otherwise awaiting-fee / unpaid-fee. */
  returnPaid(hash, r, latestEth) {
    if (r.feePaid || !this.cfg.requireFees) return true;
    if (!r.from) return true;   // recorded before fees existed: grandfathered
    const fee = expressFeeFor({ from: r.from, height: r.blockNumber }, this.state.ethFees,
      this.cfg.returnFeeFloorWei, this.cfg.ethFeeWindowBlocks);
    if (fee) { r.feePaid = fee.hash; this.log('info', 'return-fee-paid', { ethTx: hash, fee: fee.hash }); return true; }
    const status = latestEth > BigInt(r.blockNumber) + this.cfg.ethFeeWindowBlocks ? 'unpaid-fee' : 'awaiting-fee';
    if (r.status !== status) this.log('info', 'return-status', { ethTx: hash, from: r.status, to: status });
    r.status = status;
    return false;
  }

  async advanceReturn(hash, r, ctx) {
    const set = (status, extra = {}) => {
      if (r.status !== status) this.log('info', 'return-status', { ethTx: hash, from: r.status, to: status, ...extra });
      Object.assign(r, { status, ...extra });
    };

    if (!r.key) {
      let built;
      try {
        built = await buildReturn({ rpc: this.io.eth.rpc, cross: this.io.eth.cross, ethTxHash: hash });
      } catch (e) {
        if (e instanceof RpcDisagreement) {
          r.attempts = (r.attempts ?? 0) + 1;
          set('rpc-disagreement', { note: e.message });
          return;
        }
        throw e;
      }
      if (!built.crossChecked.length) throw new Error('no independent RPC confirmed the block: refusing');
      Object.assign(r, {
        blockNumber: built.blockNumber.toString(), txIndex: built.txIndex.toString(),
        receiptsRoot: built.receiptsRoot, key: built.key, total: built.total.toString(),
        senders: Object.fromEntries([...built.bySender].map(([a, v]) => [a, v.toString()])),
        crossChecked: built.crossChecked, commitData: built.commitData, returnData: built.returnData,
      });
      set('proved');
    }

    // Already returned, by the bot or anybody: done.
    const spent = this.state.spentReturnKeys[r.key];
    if (spent || ctx.recentKeys.has(r.key)) { set('returned', { molibraTx: spent?.molibraTx ?? r.returnTx ?? null }); return; }

    // A transaction of ours still in flight: confirm it before anything else.
    if (r.status === 'header-sent' || r.status === 'return-sent') {
      const which = r.status === 'header-sent' ? 'headerTx' : 'returnTx';
      const found = await this.io.molibra.get(`/molibra/tx/${r[which]}`).catch(() => ({ error: 'not found' }));
      const mined = !found.error && Boolean(found.receipt);
      if (mined) {
        this.log('info', 'molibra-mined', { ethTx: hash, [which]: r[which] });
        if (which === 'returnTx') { set('returned', { molibraTx: r.returnTx }); return; }
        // Our root is on chain now; the header list read at the top of this
        // tick predates it, and acting on that would commit it a second time.
        ctx.headers.set(String(r.blockNumber), { receiptsRoot: r.receiptsRoot, committedBy: ETH_HEADER_BOT });
        set('proved');
      } else if (which === 'headerTx' && ctx.headers.has(String(r.blockNumber))) {
        set('proved', { note: 'the block was committed by someone else first' });
      } else if (this.now() - Date.parse(r.sentAt) < this.cfg.molibraResendAfterMs) {
        // Same bytes again: a no-op if a mempool still holds it, re-admitted
        // if a node restarted and lost it.
        if (ctx.returnsLive) await this.io.molibra.rpc('eth_sendRawTransaction', [r[`${which}Raw`]]).catch(() => {});
        ctx.molibraSent = true;  // one in flight blocks every other send this tick
        return;
      } else {
        // ⛔ Not mined in time: consensus is refusing it (the cap filled, a
        //    root arrived first). A refused tx is never evicted from a Molibra
        //    mempool, so it is SUPERSEDED: the next send re-uses the account's
        //    confirmed nonce, and whichever of the two is valid gets mined.
        set('proved', { note: `${which} ${r[which]} not mined in time; re-evaluating` });
      }
    }

    const total = BigInt(r.total);
    if (total > big(ctx.status.outbound?.outstanding)) { set('exceeds-outstanding'); return; }

    const h = ctx.headers.get(String(r.blockNumber));
    if (h && lower(h.receiptsRoot) !== lower(r.receiptsRoot)) {
      set('root-conflict', { committedRoot: h.receiptsRoot, committedBy: h.committedBy });
      return;
    }
    const by = h ? lower(h.committedBy) : null;
    const tier = !h ? 'none' : by === lower(ETH_HEADER_AUTHORITY) ? 'operator' : by === ETH_HEADER_BOT ? 'bot' : 'other';
    if (tier === 'other') { set('needs-operator', { note: `root committed by ${by}` }); return; }

    if (tier !== 'operator') {
      if (total > BOT_RETURN_CAP) { set('needs-operator', { note: 'one return above the bot cap' }); return; }
      const used = big(ctx.status.outbound?.botCap?.usedInWindow);
      if (used + total > BOT_RETURN_CAP) {
        set('waiting-cap', { usedInWindow: used.toString() });
        return;
      }
    }

    const step = tier === 'none' ? 'HEADER_COMMIT' : 'MOLI_RETURN';
    if (!ctx.returnsLive) {
      set('ready', { note: `DRY-RUN: next step ${step} (${tier === 'none' ? 'then MOLI_RETURN' : `root by ${tier}`})` });
      return;
    }
    if (ctx.molibraSent) return;
    const data = tier === 'none' ? r.commitData : r.returnData;
    const sent = await this.sendMolibra(data);
    if (!sent) { set('bot-unfunded'); return; }
    ctx.molibraSent = true;
    if (tier === 'none') set('header-sent', { headerTx: sent.hash, headerTxRaw: sent.raw, sentAt: new Date(this.now()).toISOString() });
    else set('return-sent', { returnTx: sent.hash, returnTxRaw: sent.raw, sentAt: new Date(this.now()).toISOString() });
  }

  /** Sign and submit one Molibra tx from the header bot; null when it cannot pay. */
  async sendMolibra(data) {
    const m = this.io.molibra;
    const from = this.botAddress;
    const gasPrice = BigInt(await m.rpc('eth_gasPrice', []));
    const gasLimit = intrinsicGas({ data });
    const balance = BigInt(await m.rpc('eth_getBalance', [from, 'latest']));
    if (balance < gasLimit * gasPrice) return null;
    // ⛔ 'latest', not 'pending': the bot never chains, so the confirmed nonce
    //    is the next one - and it SUPERSEDES any earlier tx stuck at it.
    const nonce = BigInt(await m.rpc('eth_getTransactionCount', [from, 'latest']));
    const raw = toHex(signTransaction({ nonce, gasPrice, gasLimit, to: from, value: 0n, data },
      this.keys.headerBot, MOLIBRA_CHAIN_ID));
    const back = decodeTransaction(raw, MOLIBRA_CHAIN_ID);
    if (back.from !== from || back.data !== lower(data) || back.value !== 0n) {
      throw new Error('the signed Molibra tx does not read back as intended - refusing');
    }
    const hash = await m.rpc('eth_sendRawTransaction', [raw]);
    return { hash, raw };
  }

  /* --------------------------------------------------------------- output */

  summary() {
    const count = (o) => Object.values(o).reduce((acc, x) => ({ ...acc, [x.status]: (acc[x.status] ?? 0) + 1 }), {});
    const sum = (o, f) => Object.values(o).reduce((s, x) => s + BigInt(x[f] ?? 0), 0n).toString();
    return {
      burns: count(this.state.burns), burnsWei: sum(this.state.burns, 'amount'),
      returns: count(this.state.returns), returnsWei: sum(this.state.returns, 'total'),
    };
  }

  /** What a person (or an agent) must look at, with what to do about it. */
  pendingItems(nodeUrl = 'https://molibra.org') {
    const items = [];
    for (const [tx, b] of Object.entries(this.state.burns)) {
      if (ATTENTION[b.status]) {
        items.push({ leg: 'claim', molibraTx: tx, height: b.height, amountWei: b.amount, recipient: b.recipient,
          status: b.status, why: ATTENTION[b.status], detail: b.revert ?? b.note ?? b.lastError ?? null });
      }
    }
    for (const [tx, r] of Object.entries(this.state.returns)) {
      if (ATTENTION[r.status]) {
        items.push({ leg: 'return', ethTx: tx, ethBlock: r.blockNumber, amountWei: r.total ?? null,
          senders: r.senders ?? null, status: r.status, why: ATTENTION[r.status],
          detail: r.note ?? r.lastError ?? null,
          // The operator's way through, uncapped: commit this root, then return.
          operatorCommit: r.commitData ?? null,
          page: r.commitData ? `${nodeUrl}/molibra/return?commit=${r.commitData}&ret=${r.returnData}` : null });
      }
    }
    return items;
  }
}

/** The 0x address a hex private key controls. */
export function addressOf(key) {
  return normalizeAddress(privateToAddress(String(key).replace(/^0x/, '')));
}
