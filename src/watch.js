/**
 * Molibra - the anchor watcher.
 *
 * ## ⛔⛔ Why this exists
 *
 * A challenge window is a promise that somebody will look. `BridgedMoli` waits
 * 7,200 Ethereum blocks before a burn can be minted, and `MolibraSettlement`
 * waits 75 before it pays - and until this file existed, nothing looked in
 * either window. The delay protected nobody; it just made the theft slower.
 *
 * This does the looking. For every `Anchored` event on `MolibraAnchor` it asks
 * one question a full node can answer with certainty:
 *
 *     is the hash anchored at height H the block THIS chain has at height H?
 *
 * If it is not, one of two things is true - the publisher attested to a block
 * that is not on the chain, or this node is on a fork - and both are worth
 * waking somebody for. The watcher does not decide which. It reports what it
 * sees, with both hashes, and leaves the judgement to a person.
 *
 * ## ⛔ What it deliberately does NOT do
 *
 * It holds no key and sends nothing. `proveEquivocation` pays its prover out
 * of the liar's bond, so there is a real argument for submitting
 * automatically - but it needs a funded key, and a watcher that can spend is a
 * watcher that can be robbed. Detection is the part that has no downside, so
 * detection is the part that ships first. `equivocationProofFor` below builds
 * the argument list for a human to submit.
 *
 * ## ⛔ The honest limit, stated here as well as in the register
 *
 * A publisher who anchors ONE false hash per height has not equivocated, and
 * `proveEquivocation` cannot slash them. This watcher will still SEE it - the
 * anchored hash will not match the chain - which is exactly why seeing matters
 * more than the bond does.
 */

import { keccak256, toHex } from './crypto.js';
import { anchorDigest } from './anchor.js';

const utf8 = (s) => new TextEncoder().encode(s);

/**
 * Event topics, DERIVED rather than pasted.
 *
 * ⛔ The first draft of this file carried a hand-written topic that was simply
 * invented. It would not have thrown: `eth_getLogs` filtered on a topic no
 * event ever emits returns an empty array, so the watcher would have reported
 * "0 anchors checked, all fine" forever. A monitoring tool that fails silent
 * is worse than none, because it is trusted.
 */
export const ANCHORED_TOPIC = toHex(keccak256(utf8('Anchored(uint256,bytes32,uint256,address)')));
export const EQUIVOCATION_TOPIC =
  toHex(keccak256(utf8('Equivocation(address,uint256,bytes32,bytes32,uint256)')));

/** How a finding is classified. Ordered worst-first, deliberately. */
export const SEVERITY = ['mismatch', 'unknown-height', 'stale', 'ok'];

/**
 * Compare one anchor against what a chain says.
 *
 * `chainHashAt` is any function from height to the hash that chain has there,
 * or null when it does not have that height yet. Passing it in rather than
 * reaching for a node keeps this pure and testable: the interesting cases -
 * a mismatch, a height nobody has - are the ones that are hard to stage
 * against a live chain and trivial against a function.
 */
export function classifyAnchor(anchor, chainHashAt) {
  const height = BigInt(anchor.height);
  const anchored = String(anchor.blockHash).toLowerCase();
  const mine = chainHashAt(height);

  if (mine === null || mine === undefined) {
    return {
      severity: 'unknown-height',
      height,
      anchored,
      mine: null,
      message: `anchor claims height ${height}, which this node does not have. `
        + 'It is either ahead of us or describing a chain we are not on.',
    };
  }

  const ours = String(mine).toLowerCase();
  if (ours !== anchored) {
    return {
      severity: 'mismatch',
      height,
      anchored,
      mine: ours,
      publisher: anchor.publisher ?? null,
      message: `⛔⛔ ANCHOR MISMATCH at height ${height}. Anchored ${anchored}, this chain has `
        + `${ours}. Either the publisher attested to a block that is not on this chain, or this `
        + 'node is on a fork. Do not accept anything minted against this anchor until it is '
        + 'resolved by a person.',
    };
  }

  return { severity: 'ok', height, anchored, mine: ours, message: `height ${height} agrees` };
}

/**
 * Is the chain still moving?
 *
 * A node that stops advancing looks identical, from outside, to one that is
 * simply not being mined - and both are worth knowing about, because a
 * watcher that is comparing anchors against a frozen chain will report
 * mismatches that are its own fault. This is checked FIRST for that reason.
 *
 * ⛔ Born from a real failure: a published node synced once and then froze
 * forever while appearing joined, and nothing noticed for a day.
 */
export function classifyLiveness({ height, previousHeight, secondsSince, expectedBlockSeconds = 15 }) {
  // Generous: ten times the target interval before it is called stalled, so
  // ordinary variance in proof-of-work does not page anybody at 3am.
  const limit = expectedBlockSeconds * 10;
  if (previousHeight !== null && height === previousHeight && secondsSince > limit) {
    return {
      severity: 'stale',
      message: `⛔ the chain has not advanced past ${height} in ${Math.round(secondsSince)}s `
        + `(expected a block roughly every ${expectedBlockSeconds}s). The node may be frozen, `
        + 'or mining may have stopped.',
    };
  }
  return { severity: 'ok', message: `advancing: height ${height}` };
}

/**
 * The arguments a person needs to call `proveEquivocation`, given two
 * attestations the same publisher signed for one height.
 *
 * ⛔ Returns null unless they genuinely differ. The contract refuses a "proof"
 * that two identical attestations conflict, and building one here would only
 * waste the submitter's gas discovering that.
 */
export function equivocationProofFor(a, b) {
  if (BigInt(a.height) !== BigInt(b.height)) return null;
  const same = String(a.blockHash).toLowerCase() === String(b.blockHash).toLowerCase()
    && BigInt(a.cumulativeWork) === BigInt(b.cumulativeWork);
  if (same) return null;
  return {
    height: BigInt(a.height),
    hashA: String(a.blockHash).toLowerCase(),
    workA: BigInt(a.cumulativeWork),
    sigA: a.signature,
    hashB: String(b.blockHash).toLowerCase(),
    workB: BigInt(b.cumulativeWork),
    sigB: b.signature,
    digestA: anchorDigest(a),
    digestB: anchorDigest(b),
  };
}

/**
 * One pass: classify liveness, then every anchor, worst first.
 *
 * Returns findings rather than printing them, so the same pass can drive a
 * console, an exit code, or an alert without three copies of the logic.
 */
export function review({ anchors, chainHashAt, liveness }) {
  const findings = [];
  if (liveness) {
    const l = classifyLiveness(liveness);
    if (l.severity !== 'ok') findings.push(l);
  }
  for (const a of anchors) {
    const f = classifyAnchor(a, chainHashAt);
    if (f.severity !== 'ok') findings.push(f);
  }
  findings.sort((x, y) => SEVERITY.indexOf(x.severity) - SEVERITY.indexOf(y.severity));
  return {
    findings,
    worst: findings.length ? findings[0].severity : 'ok',
    checked: anchors.length,
  };
}
