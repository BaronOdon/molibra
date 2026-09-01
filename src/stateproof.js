/**
 * Molibra - proving one fact about the state, without shipping the state.
 *
 * ## What this fixes
 *
 * The whitepaper said, of the state root: "light-client proofs do not exist
 * here yet." They do now. This is that sentence being made false in the good
 * direction rather than being softened.
 *
 * `State.root()` already reduces the whole state to a sorted list of lines -
 * one per account, vote key, token balance, storage slot, spent credential and
 * bridge entry - and hashes them. Hashing them by CONCATENATION gives a
 * fingerprint and nothing else: to convince somebody that one line is in it you
 * have to hand over every other line. Hashing them as a binary Merkle tree
 * gives the same fingerprint's job plus the ability to prove any single line in
 * log(n) hashes.
 *
 * ⛔⛔ This changes the state root, which is consensus. It is therefore gated by
 * height exactly as `MOLI_BURN_ACTIVATION` is: below the flag day the root is
 * computed the old way, so an upgraded node and an un-upgraded one agree on all
 * existing history and on every block until the switch.
 *
 * ## ⭐ The construction is deliberately the one already deployed
 *
 * Leaves are `keccak(line)`; parents are `keccak(left ‖ right)`; an odd node is
 * promoted unchanged. That is byte-for-byte what `merkleRoot` in src/block.js
 * does for transactions, and what `MolibraSettlement.merkleRoot` and
 * `BridgedMoli.merkleRoot` already verify ON ETHEREUM against a bonded anchor.
 *
 * So a Molibra state proof is verifiable by contract code that is already
 * deployed and already in use, with no new verifier to write, audit or trust.
 * A future contract can ask "what was this account's balance at height H" and
 * check the answer against the anchored header - the same path a bridge-out
 * already takes, pointed at the state root instead of the transaction root.
 *
 * ⛔ What this does NOT fix: the root is still recomputed over the whole state
 * every block, so its COST still grows with the size of the state. This buys
 * provability, not incremental update. An incremental structure is a separate,
 * larger change and should not be smuggled in under this one.
 */

import { keccak256, toHex, fromHex, concatBytes } from './crypto.js';

const utf8 = (s) => new TextEncoder().encode(s);

/**
 * ⛔⛔ The height from which the state root is a Merkle root. SET BEFORE SHIPPING.
 *
 * Same reasoning as `MOLI_BURN_ACTIVATION`, and the same danger: below this
 * height the old computation must be used byte-for-byte, or an upgraded node
 * recomputes history differently and rejects its own chain on restart. Replay
 * re-derives the root for every historical block, so this constant is read
 * against each block's own height, never against the tip.
 */
export const STATE_MERKLE_ACTIVATION = 60_000n;

/** A leaf is the hash of the line, so a line never has to be shown to be ruled out. */
export const leafOf = (line) => keccak256(utf8(line));

/**
 * The Merkle root of the state lines.
 *
 * ⚠ Identical construction to `merkleRoot` in src/block.js - odd nodes promoted,
 * not duplicated. Duplicating an odd node is the classic CVE-2012-2459 shape;
 * promoting it is what the rest of this codebase already does and what the
 * deployed Solidity verifiers expect. One construction, three implementations
 * that must agree, and the tests check them against each other.
 */
export function stateRoot(lines) {
  if (lines.length === 0) return '0x' + '00'.repeat(32);
  let level = lines.map(leafOf);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? keccak256(concatBytes(level[i], level[i + 1])) : level[i]);
    }
    level = next;
  }
  return toHex(level[0]);
}

/**
 * An inclusion proof for the line at `index`.
 *
 * ⛔ `siblingOnRight` is recorded per level rather than derived from the index
 * by the verifier. A verifier that always hashes in one order accepts a proof
 * for a different position in the tree, and the deployed contracts take the
 * side as an argument for exactly that reason - so it must be produced here.
 *
 * An odd node that was promoted contributes NO sibling at that level, because
 * nothing was hashed with it. Emitting a placeholder would make the proof fail
 * against the very verifiers this exists to satisfy.
 */
export function proofFor(lines, index) {
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    throw new Error(`no line at index ${index}`);
  }
  let level = lines.map(leafOf);
  let i = index;
  const siblings = [];
  const siblingOnRight = [];
  while (level.length > 1) {
    const isLeft = i % 2 === 0;
    const partner = isLeft ? i + 1 : i - 1;
    if (partner < level.length) {
      siblings.push(toHex(level[partner]));
      siblingOnRight.push(isLeft);
    }
    // else: this node was promoted unchanged - no hashing happened, so there is
    // nothing to prove at this level.
    const next = [];
    for (let k = 0; k < level.length; k += 2) {
      next.push(k + 1 < level.length ? keccak256(concatBytes(level[k], level[k + 1])) : level[k]);
    }
    level = next;
    i = Math.floor(i / 2);
  }
  return { line: lines[index], index, siblings, siblingOnRight };
}

/**
 * Recompute the root a proof implies. This is the whole verifier: a light
 * client holding only a header runs this and compares.
 */
export function rootFromProof({ line, siblings, siblingOnRight }) {
  if (siblings.length !== siblingOnRight.length) throw new Error('malformed proof');
  let node = leafOf(line);
  for (let i = 0; i < siblings.length; i++) {
    const sib = fromHex(siblings[i]);
    node = siblingOnRight[i]
      ? keccak256(concatBytes(node, sib))
      : keccak256(concatBytes(sib, node));
  }
  return toHex(node);
}

/** True when this proof carries `line` up to `root`. */
export function verifyStateProof(proof, root) {
  try { return rootFromProof(proof) === String(root).toLowerCase(); }
  catch { return false; }
}

/* --------------------------------------------------------------- lookups */

/**
 * The line an account contributes, in exactly the form `State.root()` emits.
 *
 * ⛔ Built by asking the state, never by re-deriving the format here: two
 * formatters that must agree forever is the bug this whole file is trying to
 * avoid. An account with no balance and no nonce contributes NOTHING - it is
 * skipped by root() - and a proof for it is impossible rather than empty.
 */
export function accountLine(state, address) {
  const a = state.get(address);
  if (a.balance === 0n && a.nonce === 0n) return null;
  return `${String(address).toLowerCase()}:${a.balance.toString(16)}:${a.nonce.toString(16)}`;
}
