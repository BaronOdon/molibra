/**
 * Molibra - anchoring, and the reorg risk it actually removes.
 *
 * ## The problem, stated honestly
 *
 * Molibra's security against rewritten history is its accumulated proof of
 * work, and that work is small. `SECURITY.md` and the bridge page both say so
 * outright: a header with valid work can be mined privately in seconds. The
 * existing defence is `MAX_REORG_DEPTH` in src/limits.js - refuse any reorg
 * deeper than 128 blocks - and that defence is a **trade, not a win**. It stops
 * a deep private rewrite by also refusing an honest chain that a partitioned
 * node should have adopted. It substitutes stubbornness for security.
 *
 * ## What anchoring changes
 *
 * An anchor is one sentence published on a chain with enormous accumulated
 * work: *at Molibra height H, the block was `hash`, with cumulative work W.*
 * Once that sentence is buried under enough Ethereum blocks, rewriting Molibra
 * below H means rewriting **Ethereum** too. Nobody is buying that with a laptop.
 *
 * So Molibra history splits in two:
 *
 *   - **Below the deepest binding anchor** - settled by Ethereum's work, not
 *     Molibra's. No amount of privately-mined Molibra difficulty moves it. This
 *     is real finality, and it is inherited rather than manufactured.
 *   - **Above it** - still ordinary heaviest-chain, still only as strong as
 *     Molibra's own hash rate. Anchoring does not make recent blocks safe. It
 *     makes *old* blocks permanent.
 *
 * ⭐ **Security is therefore anchor frequency, and nothing else.** An anchor
 * every 100 blocks means at most 100 blocks are ever at risk. Say that number
 * plainly wherever the chain's finality is described; do not say "final".
 *
 * ## ⛔ What this does NOT do, said before anybody assumes it
 *
 *   - It does not protect the gap since the last anchor.
 *   - It does not make the anchor's *publisher* trustworthy. A publisher can
 *     anchor a chain nobody else saw. That is what equivocation detection and
 *     the bond are for - see `detectEquivocation` below - and a bond is only
 *     economic security if the bonded asset has a market. Today WSRO does not.
 *     A bond in a marketless token is a **commitment device, not collateral**,
 *     and calling it collateral would be the same category error as calling
 *     chalk a currency.
 *   - It does not remove `MAX_REORG_DEPTH`. The two compose: the anchor is a
 *     hard floor, the depth bound is a soft one. Whichever refuses first wins,
 *     and an anchor may only ever **tighten** what is allowed, never loosen it.
 */

import { keccak256, toHex, concatBytes, fromHex } from './crypto.js';

/**
 * Ethereum blocks that must sit on top of an anchor before Molibra treats it as
 * binding. An anchor inside a reorganised Ethereum block is worth nothing, and
 * adopting one early would import Ethereum's reorg risk while claiming to have
 * removed Molibra's.
 *
 * Post-merge Ethereum finalises in two epochs (~64 slots, ~12.8 minutes). This
 * is deliberately past that: finality, plus room, because the cost of waiting is
 * a few minutes and the cost of not waiting is a false floor under history.
 */
export const ETH_CONFIRMATIONS = 96;

/** How often the chain wants an anchor. Not enforced here - it is a policy the
 *  publisher keeps, and `anchorHealth` reports whether it is being kept. */
export const TARGET_ANCHOR_INTERVAL = 100;

/**
 * ⛔⛔ The publishers whose anchors this node believes, by default.
 *
 * MolibraAnchor is permissionless behind a WSRO bond, and WSRO has no market,
 * so the bond is a commitment device and not collateral (see the header). An
 * anchor from anybody else is therefore an unauthenticated sentence, and one
 * such sentence at a height above the tip used to raise the floor above the
 * head and refuse every new block - a network halt for the price of a bond.
 * Only these keys (the two operator publishers) are believed unless the
 * operator names others with --anchor-publishers.
 */
export const DEFAULT_ANCHOR_PUBLISHERS = Object.freeze([
  '0x8d1f2713eb83e4d55fbeda47b26fd08ec9170e14',
  '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a',
]);

/** Parse a comma-separated publisher list. Throws on anything that is not an address. */
export function parsePublishers(list) {
  const out = String(list ?? '').split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!out.length) throw new Error('an anchor publisher allowlist cannot be empty');
  for (const p of out) {
    if (!/^0x[0-9a-f]{40}$/.test(p)) throw new Error(`not an address: ${p}`);
  }
  return out;
}

/** The bytes a publisher signs, and the contract stores. One encoder, so the
 *  two sides can never disagree about what was attested. */
export function anchorDigest({ height, blockHash, cumulativeWork }) {
  return toHex(keccak256(concatBytes(
    new TextEncoder().encode('molibra:anchor:v1'),
    fromHex(blockHash),
    fromHex('0x' + BigInt(height).toString(16).padStart(64, '0')),
    fromHex('0x' + BigInt(cumulativeWork).toString(16).padStart(64, '0')),
  )));
}

function normalize(raw) {
  const height = BigInt(raw?.height ?? -1);
  if (height < 0n) throw new Error('an anchor needs a Molibra height');
  const blockHash = String(raw?.blockHash ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(blockHash)) throw new Error('an anchor needs a 32-byte block hash');
  const cumulativeWork = BigInt(raw?.cumulativeWork ?? 0);
  if (cumulativeWork <= 0n) throw new Error('an anchor needs positive cumulative work');
  const ethBlock = BigInt(raw?.ethBlock ?? 0);
  if (ethBlock <= 0n) throw new Error('an anchor needs the Ethereum block it was published in');
  return {
    height,
    blockHash,
    cumulativeWork,
    ethBlock,
    ethTxHash: raw?.ethTxHash ?? null,
    publisher: raw?.publisher ? String(raw.publisher).toLowerCase() : null,
    digest: anchorDigest({ height, blockHash, cumulativeWork }),
  };
}

/**
 * The anchors a node knows about, and the questions the chain asks them.
 *
 * Deliberately dumb about *where* anchors come from. Reading Ethereum is
 * somebody else's job; this holds what was read and answers "may history change
 * here?". Keeping those separate is what makes the rule testable without a
 * network.
 */
export class AnchorStore {
  /**
   * @param {object} [o]
   * @param {number|bigint} [o.ethConfirmations]
   * @param {string[]|null} [o.publishers] allowlist; defaults to
   *   DEFAULT_ANCHOR_PUBLISHERS. `null` disables the allowlist and exists ONLY
   *   for unit tests of the floor rule itself - the CLI never passes it.
   */
  constructor({ ethConfirmations = ETH_CONFIRMATIONS, publishers = DEFAULT_ANCHOR_PUBLISHERS } = {}) {
    this.ethConfirmations = BigInt(ethConfirmations);
    this.publishers = publishers === null
      ? null
      : new Set([...publishers].map((p) => String(p).toLowerCase()));
    /** Anchors dropped because their publisher is not allowlisted. */
    this.ignoredPublishers = 0;
    /** The local chain, once attached: { height(): bigint, hashAt(h): string|null }. */
    this.local = null;
    /** Keys already warned about, so a bad anchor is logged loudly ONCE, not every tick. */
    this.warned = new Set();
    /** height (as string) -> anchor. One per height; conflicts are faults. */
    this.byHeight = new Map();
    /** Equivocations found: the same height attested two different ways. */
    this.equivocations = [];
    this.ethHead = 0n;
  }

  /** Tell the store how far Ethereum has got, which is what makes anchors bind. */
  setEthereumHead(blockNumber) {
    const n = BigInt(blockNumber);
    if (n < this.ethHead) {
      // Ethereum going backwards is a reorg on the anchoring chain itself.
      // Not fatal - confirmations exist for exactly this - but never silent.
      this.reorgOnAnchorChain = { from: this.ethHead.toString(), to: n.toString() };
    }
    this.ethHead = n;
  }

  /**
   * ⛔ Two anchors for the same height that disagree is not a race, a duplicate
   * or a retry - it is a publisher attesting to two different histories, and it
   * is the only misbehaviour an anchor publisher can commit that is provable
   * from the data alone. Record it and refuse to treat that height as binding:
   * an anchor whose publisher has equivocated tells us nothing about which
   * chain is real.
   */
  detectEquivocation(anchor) {
    const existing = this.byHeight.get(anchor.height.toString());
    if (!existing) return null;
    if (existing.digest === anchor.digest) return null;
    const fault = {
      height: anchor.height.toString(),
      publisher: anchor.publisher ?? existing.publisher,
      a: { blockHash: existing.blockHash, digest: existing.digest, ethBlock: existing.ethBlock.toString() },
      b: { blockHash: anchor.blockHash, digest: anchor.digest, ethBlock: anchor.ethBlock.toString() },
      note: 'the same height attested to two different blocks; this height is not binding, '
        + 'and on the Ethereum side this pair is the slashing proof',
    };
    this.equivocations.push(fault);
    return fault;
  }

  /**
   * Add an anchor. Returns { added, fault }.
   *
   * Monotonicity is checked but a violation is NOT thrown away: an anchor that
   * goes backwards in work while going forwards in height is itself evidence
   * about the publisher, and discarding evidence to keep a data structure tidy
   * is how faults become invisible.
   */
  add(raw) {
    const anchor = normalize(raw);
    // ⛔⛔ Allowlist BEFORE equivocation detection: an outsider's anchor must not
    //    even be able to fault (and so un-bind) a height a real publisher anchored.
    if (this.publishers && !this.publishers.has(anchor.publisher ?? '')) {
      this.ignoredPublishers++;
      this.warnOnce(`pub:${anchor.publisher}:${anchor.height}`,
        `[molibra] ANCHOR IGNORED: publisher ${anchor.publisher ?? '(none)'} is not on the `
        + `allowlist (height ${anchor.height}, hash ${anchor.blockHash.slice(0, 18)}...)`);
      return { added: false, fault: null, ignored: 'publisher not on the allowlist' };
    }
    const fault = this.detectEquivocation(anchor);
    if (fault) return { added: false, fault };

    // Work must strictly increase with height. Equal work at a greater height
    // means blocks with no difficulty, which this chain cannot produce.
    for (const other of this.byHeight.values()) {
      if (other.height < anchor.height && other.cumulativeWork >= anchor.cumulativeWork) {
        const regression = {
          height: anchor.height.toString(),
          note: `cumulative work ${anchor.cumulativeWork} at height ${anchor.height} does not `
            + `exceed ${other.cumulativeWork} at the lower height ${other.height}`,
        };
        this.equivocations.push(regression);
        return { added: false, fault: regression };
      }
    }

    this.byHeight.set(anchor.height.toString(), anchor);
    return { added: true, fault: null, anchor };
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }

  /**
   * Attach the node's own chain. From then on an anchor can only bind a block
   * this node actually holds, canonically, at that height (see `binding`).
   * @param {{ height: () => bigint, hashAt: (h: bigint) => (string|null) }} view
   */
  attachChain(view) {
    this.local = view;
    return this;
  }

  /** Every non-faulted anchor buried deeply enough on Ethereum to be believed. */
  attested() {
    const faulted = new Set(this.equivocations.map((e) => e.height));
    return [...this.byHeight.values()]
      .filter((a) => !faulted.has(a.height.toString()))
      .filter((a) => this.ethHead - a.ethBlock >= this.ethConfirmations)
      .sort((a, b) => (a.height < b.height ? -1 : 1));
  }

  /**
   * ⛔⛔ The anchors that may raise the floor.
   *
   * An attested anchor binds ONLY if the anchored height is at or below the
   * local tip AND the local canonical block at that height has exactly the
   * anchored hash. Anything else is ignored, loudly, once:
   *
   *   - above the tip: a floor above the head refuses every extension of the
   *     head (the extension's fork point IS the head), which halts the node;
   *   - a different hash: the floor would forbid the node from ever moving to
   *     the anchored chain, so it would pin the node to the wrong history.
   *
   * Ignoring can only LOWER the floor, never raise it, so this only ever
   * removes refusals; it never adds one. With no chain attached (unit tests of
   * the rule) every attested anchor binds, as before.
   */
  binding() {
    const attested = this.attested();
    if (!this.local) return attested;
    const tip = BigInt(this.local.height());
    return attested.filter((a) => {
      if (a.height > tip) {
        this.warnOnce(`tip:${a.height}:${a.blockHash}`,
          `[molibra] ANCHOR NOT BINDING: height ${a.height} is above the local tip ${tip}; `
          + 'it cannot raise the floor until this node holds that block');
        return false;
      }
      const mine = this.local.hashAt(a.height);
      if (!mine || mine.toLowerCase() !== a.blockHash) {
        this.warnOnce(`hash:${a.height}:${a.blockHash}:${mine}`,
          `[molibra] ANCHOR NOT BINDING: height ${a.height} anchors ${a.blockHash} but the local `
          + `block is ${mine ?? '(none)'} - ignored for the floor, reported as a disagreement`);
        return false;
      }
      return true;
    });
  }

  /**
   * The height at or below which Molibra history is settled by Ethereum.
   * `-1` when nothing is anchored yet, so callers can tell "no floor" from
   * "a floor at genesis" without a special case.
   */
  finalizedHeight() {
    const b = this.binding();
    return b.length ? b[b.length - 1].height : -1n;
  }

  /** The anchor covering a height, if one binds it. */
  bindingAt(height) {
    const h = BigInt(height);
    return this.binding().find((a) => a.height === h) ?? null;
  }

  /**
   * ⛔⛔ The question the fork choice asks, and the whole point of this file.
   *
   * A candidate branch forks from the canonical chain at `forkHeight`. May the
   * chain follow it? Not if doing so would rewrite a block Ethereum has already
   * attested to - **however much work the branch carries**. That is the
   * inversion: below the floor, work stops being the argument.
   */
  permitsReorgFrom(forkHeight) {
    const floor = this.finalizedHeight();
    if (floor < 0n) return { ok: true, reason: null, floor: null };
    if (BigInt(forkHeight) < floor) {
      return {
        ok: false,
        floor,
        reason: `refused: the branch forks at ${forkHeight}, below the anchored floor ${floor}. `
          + 'That history is attested on Ethereum, so rewriting it here would require '
          + 'rewriting Ethereum. Accumulated work does not override an anchor.',
      };
    }
    return { ok: true, reason: null, floor };
  }

  /**
   * ⛔ Does the chain the node holds actually match what was attested?
   *
   * A binding anchor naming a block this node does not have at that height
   * means one of two things, and the node cannot tell which: it is on the wrong
   * chain, or the publisher anchored a chain nobody else saw. Either way it is
   * the loudest possible signal and must never be swallowed.
   */
  disagreements(hashAtHeight) {
    const out = [];
    // attested(), not binding(): a mismatched anchor never binds, and it is
    // exactly the one that must still be reported.
    for (const a of this.attested()) {
      const mine = hashAtHeight(a.height);
      if (mine && mine.toLowerCase() !== a.blockHash) {
        out.push({
          height: a.height.toString(),
          anchored: a.blockHash,
          local: mine.toLowerCase(),
          note: 'this node is on a different chain from the one anchored on Ethereum, or the '
            + 'publisher anchored a chain nobody else saw',
        });
      }
    }
    return out;
  }

  /**
   * How much history is still only as strong as Molibra's own hash rate.
   * This is the number to publish, rather than the word "final".
   */
  anchorHealth(currentHeight) {
    const floor = this.finalizedHeight();
    const exposed = floor < 0n ? BigInt(currentHeight) : BigInt(currentHeight) - floor;
    return {
      anchors: this.byHeight.size,
      binding: this.binding().length,
      finalizedHeight: floor < 0n ? null : floor.toString(),
      blocksExposed: exposed.toString(),
      targetInterval: TARGET_ANCHOR_INTERVAL,
      healthy: floor >= 0n && exposed <= BigInt(TARGET_ANCHOR_INTERVAL) * 2n,
      equivocations: this.equivocations.length,
      note: floor < 0n
        ? 'nothing is anchored: all history rests on Molibra work alone'
        : `history at or below ${floor} is settled by Ethereum; ${exposed} block(s) above it `
          + 'rest on Molibra work alone',
    };
  }
}
