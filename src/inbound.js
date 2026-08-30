/**
 * Molibra - the inbound ledger: what may be minted here against what was
 * destroyed there.
 *
 * ## The invariant, stated before anything else
 *
 *     minted here  ==  sum(proved burns there)  -  sum(returns)
 *     minted here  <=  bridgeCap
 *
 * Not "approximately", and not "assuming the relayer is honest". Every unit of
 * a foreign asset that exists on Molibra corresponds to a specific, named,
 * single-use burn transaction on the origin chain. The ledger is the proof of
 * that correspondence, and it is checked on every mutation rather than
 * reconciled afterwards - because a bridge that discovers a discrepancy later
 * has already paid it out.
 *
 * ## Why burn-and-mint rather than lock-and-mint
 *
 * A lock design needs a vault: an address holding everybody's deposits, which
 * is the single richest target in the system and the thing every large bridge
 * theft has taken. A burn design has no vault. Units are **destroyed** on the
 * origin chain and **recreated** here; there is nothing to steal, and nothing
 * whose custody makes anybody a custodian.
 *
 * This is available for WSRO specifically because `burn` on that contract is
 * unrestricted - any holder burns their own units - and it stays available
 * after `renounceOwnership()`, which was verified against the live contract
 * before this file was written.
 *
 * ⭐ **With minting renounced on Ethereum, the sum across BOTH chains is
 * conserved and permanently bounded by the original 21,000,000.** The only way
 * to create a unit here is to destroy one there. That is a stronger statement
 * than "fixed supply on Ethereum", and it is the one worth publishing.
 *
 * ## ⛔ The cap, and why it is small on purpose
 *
 * A new bridge should be able to lose only what somebody chose to risk. The cap
 * is the maximum this bridge will ever mint, and it is deliberately far below
 * the total supply: if every assumption in this file turns out to be wrong, the
 * loss is bounded by a number set in advance rather than by the size of the
 * treasury. Raising it is a deliberate act, recorded as one.
 */

import { keccak256, toHex, concatBytes, fromHex, normalizeAddress } from './crypto.js';
import { foreignTokenId, mayEnterFromABridge } from './foreign.js';

/**
 * A claim is identified by the origin transaction, and by nothing else.
 *
 * ⛔ This is the replay defence, and it is the single most important line in
 * the file. Every bridge theft of this shape has the same story: a proof that
 * could be presented twice. Keying on the origin transaction hash - not on the
 * recipient, not on the amount, not on a nonce the claimant supplies - means a
 * burn can be claimed exactly once, by construction, no matter who submits it
 * or how many times.
 */
export function claimKey(originChainId, ethTxHash) {
  return toHex(keccak256(concatBytes(
    new TextEncoder().encode('molibra:inbound:v1'),
    new TextEncoder().encode(BigInt(originChainId).toString()),
    fromHex(String(ethTxHash).toLowerCase()),
  )));
}

export class InboundLedger {
  constructor() {
    /** tokenId -> { cap, minted, burnedIn, returned, claims:Set } */
    this.assets = new Map();
    /** every claim key ever honoured, across all assets */
    this.claimed = new Set();
  }

  /**
   * Register a foreign asset this bridge will carry, with its ceiling.
   *
   * The record goes through `mayEnterFromABridge` first, so the electoral
   * keystone applies here too: an expression token, or anything declaring a
   * social/purchase/electoral purpose, is refused before it can have a cap at
   * all. GIZ can never reach this function, whatever it is called.
   */
  register(record, cap) {
    const verdict = mayEnterFromABridge(record);
    if (!verdict.ok) throw new Error(`refused at the door: ${verdict.reason}`);
    const ceiling = BigInt(cap);
    if (ceiling <= 0n) throw new Error('a bridge cap must be positive: zero would carry nothing');
    const id = record.id ?? foreignTokenId(record.origin.chainId, record.origin.contract);
    if (this.assets.has(id)) throw new Error('asset already registered');
    this.assets.set(id, {
      id,
      symbol: record.symbol,
      origin: record.origin,
      cap: ceiling,
      minted: 0n,
      burnedIn: 0n,
      returned: 0n,
    });
    return this.assets.get(id);
  }

  get(id) {
    const a = this.assets.get(id);
    if (!a) throw new Error(`unknown bridged asset ${id}`);
    return a;
  }

  /**
   * ⛔⛔ Lowering the cap is immediate. Raising it is not.
   *
   * The asymmetry is the whole design. Making a bridge *safer* should never
   * wait; making it carry more should always wait, and should be visible while
   * it waits. A cap that can be raised in one call is not a cap - it is a
   * formality that a compromised key removes in a single transaction, and the
   * bound it appeared to give was never real.
   *
   * ⛔ A raise may not be applied below what is already minted, and may not be
   * applied at all until its delay has elapsed. A rule an administrator can
   * step over in one action is not a rule.
   */
  lowerCap(id, cap) {
    const a = this.get(id);
    const next = BigInt(cap);
    if (next >= a.cap) throw new Error('lowerCap only lowers; use proposeCap to raise');
    if (next < a.minted) {
      throw new Error(`cannot set a cap of ${next} below the ${a.minted} already minted`);
    }
    const previous = a.cap;
    a.cap = next;
    a.pendingCap = null;      // a raise in flight is abandoned by a decision to shrink
    return { from: previous.toString(), to: next.toString(), immediate: true };
  }

  /**
   * Announce a larger cap. It does not take effect now.
   *
   * Two bounds, and they do different jobs:
   *
   *   - **the growth factor** limits how much bigger any single step may be, so
   *     the bridge grows in stages that each get tested by use rather than
   *     jumping straight to the whole reserve;
   *   - **the delay** makes every increase visible before it is live, so that
     *   anyone watching - not only the operator - can react to one they think
   *     is wrong. That is what turns a private intention into a public
   *     commitment.
   *
   * ⭐ This is the mechanism behind "gradually, safely": exposure rises only in
   * announced steps, each bounded, each survivable. An exploit at 144,000 is a
   * lesson; the same exploit at 21,000,000 is the end of the project.
   */
  proposeCap(id, cap, now, { maxGrowthFactor = 2n, delaySeconds = 604800 } = {}) {
    const a = this.get(id);
    const next = BigInt(cap);
    const at = BigInt(now);
    if (next <= a.cap) throw new Error('proposeCap only raises; use lowerCap to shrink');
    if (next > a.cap * BigInt(maxGrowthFactor)) {
      throw new Error(
        `refused: ${next} is more than ${maxGrowthFactor}x the current cap of ${a.cap}. `
        + 'The bridge grows in bounded steps, each one tested by use before the next.');
    }
    a.pendingCap = { cap: next, effectiveAt: at + BigInt(delaySeconds), proposedAt: at };
    return {
      from: a.cap.toString(),
      to: next.toString(),
      effectiveAt: a.pendingCap.effectiveAt.toString(),
      note: 'announced, not live: anyone watching can react before it takes effect',
    };
  }

  /** Apply an announced raise, once its delay has elapsed and not before. */
  applyCap(id, now) {
    const a = this.get(id);
    if (!a.pendingCap) throw new Error('no cap increase is pending');
    if (BigInt(now) < a.pendingCap.effectiveAt) {
      throw new Error(
        `refused: this increase becomes effective at ${a.pendingCap.effectiveAt}, not ${now}. `
        + 'The delay is what makes the increase public before it is live.');
    }
    const previous = a.cap;
    a.cap = a.pendingCap.cap;
    a.pendingCap = null;
    return { from: previous.toString(), to: a.cap.toString() };
  }

  /**
   * Honour one proved burn: mint `amount` here because `amount` was destroyed
   * there.
   *
   * ⚠ This function does NOT verify the Ethereum proof. Verifying Ethereum
   * consensus is a separate, larger problem, and mixing it in here would hide
   * the accounting rules inside cryptography nobody reads. The caller supplies
   * a burn it has already proved; this decides whether honouring it is
   * *permissible*. Both checks are necessary and neither substitutes.
   */
  claim({ tokenId, ethTxHash, amount, recipient }) {
    const a = this.get(tokenId);
    const value = BigInt(amount);
    if (value <= 0n) throw new Error('a claim must be positive');
    normalizeAddress(recipient); // throws on a malformed recipient, before any mutation

    const key = claimKey(a.origin.chainId, ethTxHash);
    if (this.claimed.has(key)) {
      throw new Error(`burn ${ethTxHash} has already been claimed: a burn is claimable once`);
    }
    if (a.minted + value > a.cap) {
      throw new Error(
        `refused: minting ${value} would take ${a.symbol} to ${a.minted + value}, `
        + `over this bridge's cap of ${a.cap}. The cap is the most this bridge will ever `
        + 'mint, and raising it is a deliberate act.');
    }

    this.claimed.add(key);
    a.minted += value;
    a.burnedIn += value;
    this.assertInvariant(a);
    return { tokenId: a.id, minted: a.minted.toString(), key, recipient };
  }

  /**
   * The other direction: units are destroyed here so they may be released
   * there. Lowers `minted`, which frees room under the cap - deliberately, so
   * a bridge with a small cap can still carry unlimited volume over time
   * without ever having more than the cap outstanding at once.
   */
  release({ tokenId, amount }) {
    const a = this.get(tokenId);
    const value = BigInt(amount);
    if (value <= 0n) throw new Error('a release must be positive');
    if (value > a.minted) {
      throw new Error(
        `cannot release ${value}: only ${a.minted} exists here. Releasing more than was `
        + 'minted would create units on the origin chain that were never burned.');
    }
    a.minted -= value;
    a.returned += value;
    this.assertInvariant(a);
    return { tokenId: a.id, minted: a.minted.toString() };
  }

  /** Checked after every mutation, not on a schedule. */
  assertInvariant(a) {
    if (a.minted !== a.burnedIn - a.returned) {
      throw new Error(`ledger invariant broken for ${a.symbol}: minted ${a.minted} != `
        + `burnedIn ${a.burnedIn} - returned ${a.returned}`);
    }
    if (a.minted > a.cap) {
      throw new Error(`ledger invariant broken for ${a.symbol}: minted ${a.minted} > cap ${a.cap}`);
    }
    if (a.minted < 0n) throw new Error(`ledger invariant broken: negative supply`);
  }

  /**
   * ⭐ Conservation across both chains.
   *
   * With minting renounced on the origin contract, the total that can exist
   * anywhere is fixed forever at the original supply. This states it as an
   * arithmetic check rather than a promise: what remains there, plus what
   * exists here, must never exceed what was originally issued.
   */
  conservation(tokenId, originalSupply, remainingOnOrigin) {
    const a = this.get(tokenId);
    const original = BigInt(originalSupply);
    const remaining = BigInt(remainingOnOrigin);
    const total = remaining + a.minted;
    return {
      symbol: a.symbol,
      originalSupply: original.toString(),
      remainingOnOrigin: remaining.toString(),
      mintedHere: a.minted.toString(),
      total: total.toString(),
      ok: total <= original,
      note: total <= original
        ? 'conserved: the only way to create a unit here is to destroy one there'
        : 'BROKEN: more exists across both chains than was ever issued',
    };
  }

  /**
   * What an explorer or a reader should be shown.
   *
   * ⭐ Written to be checked BY STRANGERS, not only by the operator. A bound
   * nobody outside can verify is a claim; a bound anyone can recompute from
   * public data is a control. Every field here is derivable from the two chains
   * independently, so a reader who trusts nothing can confirm or refute it -
   * which is what makes an exploit visible to someone other than the party who
   * would least like to admit it.
   */
  report(tokenId) {
    const a = this.get(tokenId);
    return {
      symbol: a.symbol,
      origin: a.origin,
      cap: a.cap.toString(),
      minted: a.minted.toString(),
      headroom: (a.cap - a.minted).toString(),
      burnedIn: a.burnedIn.toString(),
      returned: a.returned.toString(),
      claimsHonoured: this.claimed.size,
      pendingCap: a.pendingCap
        ? {
          cap: a.pendingCap.cap.toString(),
          effectiveAt: a.pendingCap.effectiveAt.toString(),
          note: 'announced and not yet live — react now if this is wrong',
        }
        : null,
      note: `at most ${a.cap} ${a.symbol} can ever exist on Molibra through this bridge; `
        + `${a.minted} does now, each against a named burn on chain ${a.origin.chainId}`,
      howToVerify: 'sum the burns on the origin chain, sum what exists here, and check the '
        + 'total against the original supply. Every input is public on both chains.',
    };
  }
}
