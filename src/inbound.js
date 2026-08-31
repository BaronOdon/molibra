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
import { bridgeAuthority } from './bridgemint.js';

/** Headers are keyed by the chain they came from, never by height alone. */
const headerKey = (chainId, blockNumber) => `${BigInt(chainId)}:${BigInt(blockNumber)}`;

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
    /**
     * `chainId:blockNumber` -> receiptsRoot, committed by an asset's
     * registrar. This is the TRUSTED half of the bridge, and it lives in
     * consensus state precisely so that it is public: a fabricated root is
     * permanently on the record, attributed, and refutable by anybody with an
     * Ethereum node. A root held privately by a relayer would be exactly as
     * load-bearing and nobody could check it.
     */
    this.headers = new Map();
  }

  /**
   * Register a foreign asset this bridge will carry, with its ceiling.
   *
   * The record goes through `mayEnterFromABridge` first, so the electoral
   * keystone applies here too: an expression token, or anything declaring a
   * social/purchase/electoral purpose, is refused before it can have a cap at
   * all. GIZ can never reach this function, whatever it is called.
   */
  register(record, cap, { assetContract = null, registrar = null } = {}) {
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
      // The ERC-20 that carries the units, and the keyless address it must
      // trust. Both are null for a ledger used on its own, which is a
      // perfectly good way to reason about the accounting without a chain.
      assetContract: assetContract ? normalizeAddress(assetContract) : null,
      authority: bridgeAuthority(id),
      // Who registered it, and therefore whose committed headers this asset
      // rests on. Shown in every report: it is the one thing a reader has to
      // decide whether to trust.
      registrar: registrar ? normalizeAddress(registrar) : null,
    });
    return this.assets.get(id);
  }

  /**
   * Record a `receiptsRoot` for a block on an origin chain.
   *
   * Only an address that registered an asset on that chain may commit, and a
   * height already committed cannot be re-committed with a different root.
   *
   * The second rule is the one that matters. A root that could be replaced is
   * not a commitment; it is a draft, and a claim proved against a draft proves
   * nothing that cannot be un-proved later. Equivocation here would also be
   * invisible - the old root would simply be gone - so it is refused at the
   * point where the evidence still exists.
   */
  commitHeader({ originChainId, blockNumber, receiptsRoot, by }) {
    const chain = BigInt(originChainId);
    const root = String(receiptsRoot).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(root)) throw new Error('a receipts root is 32 bytes');
    const committer = normalizeAddress(by);
    const mayCommit = [...this.assets.values()].some(
      (a) => BigInt(a.origin.chainId) === chain && a.registrar === committer);
    if (!mayCommit) {
      throw new Error(
        `${committer} has registered no asset on chain ${chain}, so its view of that `
        + 'chain is not one this ledger carries');
    }
    const key = headerKey(chain, blockNumber);
    const existing = this.headers.get(key);
    if (existing && existing.receiptsRoot !== root) {
      throw new Error(
        `chain ${chain} block ${blockNumber} is already committed as ${existing.receiptsRoot}. `
        + 'A commitment that can be replaced is a draft, and a claim proved against a draft '
        + 'can be un-proved later.');
    }
    if (!existing) this.headers.set(key, { receiptsRoot: root, by: committer });
    return { chainId: chain.toString(), blockNumber: BigInt(blockNumber).toString(), receiptsRoot: root, by: committer };
  }

  /** null when no root has been committed for that block - never a guess. */
  receiptsRootFor(originChainId, blockNumber) {
    return this.headers.get(headerKey(originChainId, blockNumber))?.receiptsRoot ?? null;
  }

  /**
   * Is this one of the keyless addresses a bridged asset's contract trusts?
   *
   * `applyTransaction` asks before accepting any transaction, so the rule
   * "nothing is ever sent from a bridge authority" is written down rather than
   * left to the fact that nobody can produce the signature.
   */
  isAuthority(address) {
    const who = normalizeAddress(address);
    for (const a of this.assets.values()) if (a.authority === who) return true;
    return false;
  }

  /** The asset whose units this contract carries, or null. */
  assetAt(contract) {
    const where = normalizeAddress(contract);
    for (const a of this.assets.values()) if (a.assetContract === where) return a;
    return null;
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
  assertClaimable({ tokenId, ethTxHash, amount, recipient }) {
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
    return { asset: a, key, value };
  }

  claim({ tokenId, ethTxHash, amount, recipient }) {
    // Every check lives in assertClaimable, so a caller that must decide
    // BEFORE mutating anything - applyTransaction does - asks exactly the same
    // questions this does, rather than a second copy of them that can drift.
    const { asset: a, key, value } = this.assertClaimable({ tokenId, ethTxHash, amount, recipient });

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
  /* ------------------------------------------------- consensus plumbing */

  /**
   * A copy that shares nothing.
   *
   * A candidate block runs against a CLONE of the parent's state. If the
   * ledger were shared, a claim in a block that was never mined - or was mined
   * and then reorged away - would still have consumed its burn, and the burn
   * would be unclaimable forever. Every other record on Molibra is copied for
   * exactly this reason; see State.clone.
   */
  clone() {
    const copy = new InboundLedger();
    for (const [id, a] of this.assets) copy.assets.set(id, { ...a, origin: { ...a.origin } });
    copy.claimed = new Set(this.claimed);
    copy.headers = new Map([...this.headers].map(([k, v]) => [k, { ...v }]));
    return copy;
  }

  /** Sorted lines for the state root. Empty when the ledger is empty, so a
   *  chain with no bridge in it hashes exactly as it did before this existed. */
  rootLines() {
    const lines = [];
    for (const id of [...this.assets.keys()].sort()) {
      const a = this.assets.get(id);
      lines.push(`basset:${id}:${a.origin.chainId}:${a.origin.contract}:`
        + `${a.assetContract ?? ''}:${a.registrar ?? ''}:${a.cap.toString(16)}:`
        + `${a.minted.toString(16)}:${a.burnedIn.toString(16)}:${a.returned.toString(16)}:`
        + (a.pendingCap
          ? `${a.pendingCap.cap.toString(16)}@${a.pendingCap.effectiveAt.toString(16)}`
          : '-'));
    }
    for (const k of [...this.claimed].sort()) lines.push(`bclaim:${k}`);
    for (const k of [...this.headers.keys()].sort()) {
      const h = this.headers.get(k);
      lines.push(`bhead:${k}:${h.receiptsRoot}:${h.by}`);
    }
    return lines;
  }

  toJSON() {
    if (this.assets.size === 0 && this.claimed.size === 0 && this.headers.size === 0) return null;
    const assets = {};
    for (const id of [...this.assets.keys()].sort()) {
      const a = this.assets.get(id);
      assets[id] = {
        symbol: a.symbol,
        origin: { ...a.origin, chainId: String(a.origin.chainId) },
        cap: a.cap.toString(),
        minted: a.minted.toString(),
        burnedIn: a.burnedIn.toString(),
        returned: a.returned.toString(),
        assetContract: a.assetContract,
        registrar: a.registrar,
        pendingCap: a.pendingCap
          ? { cap: a.pendingCap.cap.toString(), effectiveAt: a.pendingCap.effectiveAt.toString(),
            proposedAt: a.pendingCap.proposedAt.toString() }
          : null,
      };
    }
    const headers = {};
    for (const k of [...this.headers.keys()].sort()) headers[k] = this.headers.get(k);
    return { assets, claimed: [...this.claimed].sort(), headers };
  }

  static fromJSON(obj) {
    const ledger = new InboundLedger();
    if (!obj) return ledger;
    for (const [id, a] of Object.entries(obj.assets ?? {})) {
      ledger.assets.set(id, {
        id,
        symbol: a.symbol,
        origin: a.origin,
        cap: BigInt(a.cap),
        minted: BigInt(a.minted),
        burnedIn: BigInt(a.burnedIn),
        returned: BigInt(a.returned),
        assetContract: a.assetContract ?? null,
        authority: bridgeAuthority(id),
        registrar: a.registrar ?? null,
        pendingCap: a.pendingCap
          ? { cap: BigInt(a.pendingCap.cap), effectiveAt: BigInt(a.pendingCap.effectiveAt),
            proposedAt: BigInt(a.pendingCap.proposedAt) }
          : null,
      });
    }
    for (const k of obj.claimed ?? []) ledger.claimed.add(k);
    for (const [k, v] of Object.entries(obj.headers ?? {})) ledger.headers.set(k, v);
    return ledger;
  }

  report(tokenId) {
    const a = this.get(tokenId);
    return {
      symbol: a.symbol,
      origin: a.origin,
      assetContract: a.assetContract,
      // Two addresses that are easy to confuse and must not be. The authority
      // is derived and keyless - it is the only address that can mint. The
      // registrar is a person's wallet - it can commit headers and nothing
      // else, and it is who a reader is being asked to trust.
      authority: a.authority,
      registrar: a.registrar,
      headersCommitted: [...this.headers.values()].filter((h) => h.by === a.registrar).length,
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
