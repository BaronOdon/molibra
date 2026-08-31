/**
 * Molibra - inclusion proofs, and the honest foundation of a bridge.
 *
 * ## Why this exists before anything called a bridge does
 *
 * Connecting a chain to others means somebody, somewhere, has to be convinced
 * that something happened here. There are only two ways to do that:
 *
 *   1. **Trust an operator** who says so. That is a custodian, and a custodian
 *      is the thing that gets drained - bridges are the most attacked
 *      component in this entire field, and the losses are not close.
 *   2. **Verify it.** Hand the other side a proof it can check itself against
 *      a block header, with no trust in whoever passed it along.
 *
 * This file is (2), and it is deliberately all of what is built. An external
 * verifier given `{ header, proof }` can establish, on its own:
 *
 *   - the header hashes to the block hash it claims (`blockHash`);
 *   - the header satisfies its own stated difficulty (`isValidSeal`) - so real
 *     work was spent on it;
 *   - the transaction is in that block's `txRoot`, by recomputing the path.
 *
 * What it CANNOT establish, and no amount of code here will: that the block is
 * on the canonical chain rather than a discarded fork. That needs following
 * cumulative difficulty, which is what a light client does and what the other
 * side must do for itself. A proof says "this happened in this block"; only a
 * chain of headers says "and that block won".
 *
 * ## Where legislation enters, and where it does not
 *
 * **This chain is built on libertarian theory and Macrobiotic Quantum Theory**
 * (see THEORY.md), not on any one country's statute. It is a general-purpose
 * public chain, and its design answers to its own principles.
 *
 * **MOLI is an ordinary coin of that chain** - mined, priced, transferable by
 * settled design, and **not used in the DataToalha application at all**.
 * Bridging it is a technical question: can the other side verify what happened
 * here? That is what this file answers.
 *
 * ⛔ **GIZ is where legislation applies, and GIZ never crosses.** It is the
 * application token for a board in Brazil, and the electoral rules attach to
 * it and to the questions it carries - not to the chain, and not to MOLI. Its
 * whole design is that it has no market and therefore no price; a bridged
 * claim on it would manufacture both. See `mayCrossABridge` below: GIZ, and
 * any `social`, `purchase` or `electoral` token, is refused in any wrapping.
 *
 * Whoever chooses to *operate* a bridge as a service answers to whatever rules
 * their own jurisdiction puts on that. That is a property of the operator, not
 * of the chain, and not a reason the verifier below should not exist: it moves
 * nothing, holds nothing, and anybody may run it.
 */

import { keccak256, toHex, fromHex, concatBytes } from './crypto.js';
import { merkleRoot, blockHash, isValidSeal, encodeHeader } from './block.js';

/**
 * ⛔⛔ **MOLI and GIZ are not the same thing and must never cross the same
 * line.** Written here, in the bridge file, because this is where confusing
 * them would cost the most.
 *
 *   - **MOLI** is the network's coin. It is transferable, mined, priced, and
 *     carries no voting semantics whatsoever. Bridging it is an ordinary
 *     question about an ordinary asset.
 *   - **GIZ** is chalk. It is non-transferable, has **no market and therefore
 *     no price**, and exists to be spent on speaking. Bridging it would create
 *     the market its whole design denies, and with it the economic value that
 *     Res.-TSE 23.610/2019 art. 29 §8º attaches to political participation.
 *     **GIZ never crosses. Not wrapped, not mirrored, not "representationally".**
 *
 * The same applies to any token declaring a `social`, `purchase` or
 * `electoral` purpose, whatever it calls itself: it is non-transferable here,
 * and a bridge that minted a transferable claim on it elsewhere would have
 * defeated the rule by going around it.
 */
export function mayCrossABridge(token) {
  if (!token) return { ok: false, reason: 'unknown token' };
  if (!token.transferable) {
    return {
      ok: false,
      reason: `${token.symbol || token.id} is not transferable: it has no market and no `
        + 'price, and a bridged claim on it would manufacture both',
    };
  }
  if (['social', 'purchase', 'electoral'].includes(token.purpose)) {
    return {
      ok: false,
      reason: `${token.purpose} subject matter never crosses, in any wrapping`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * The Merkle path for one leaf, in the exact shape `merkleRoot` builds.
 *
 * That tree PROMOTES an odd trailing node rather than duplicating it - a
 * detail that matters more than it looks. A verifier written against the usual
 * "duplicate the last node" convention would reject perfectly good proofs from
 * every block with an odd transaction count, and the failure would look like
 * corruption rather than a mismatch of conventions. So the promotion appears
 * in the proof as what it is: a level with no sibling, and no step.
 */
export function merkleProof(leaves, index) {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error(`leaf index ${index} is outside a tree of ${leaves.length}`);
  }
  let level = leaves.map((h) => fromHex(h));
  let position = index;
  const path = [];

  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const hasSibling = i + 1 < level.length;
      if (i === (position - (position % 2))) {
        // This pair contains our node. A pair with no sibling is a promotion:
        // the node rises unchanged and there is nothing to record.
        if (hasSibling) {
          path.push(position % 2 === 0
            ? { side: 'right', hash: toHex(level[i + 1]) }
            : { side: 'left', hash: toHex(level[i]) });
        }
      }
      next.push(hasSibling ? keccak256(concatBytes(level[i], level[i + 1])) : level[i]);
    }
    level = next;
    position = Math.floor(position / 2);
  }
  return path;
}

/** Recompute the root from a leaf and its path. Pure - no chain needed. */
export function verifyMerkleProof(leaf, path, root) {
  let node = fromHex(leaf);
  for (const step of path) {
    const sibling = fromHex(step.hash);
    node = step.side === 'right'
      ? keccak256(concatBytes(node, sibling))
      : keccak256(concatBytes(sibling, node));
  }
  return toHex(node) === String(root).toLowerCase();
}

/**
 * Everything an outsider needs to check that a transaction happened, without
 * trusting the node that handed it over.
 *
 * The whole header travels, not just the root, because a verifier that is
 * given only a root has to be TOLD which block it belongs to - and being told
 * is the thing this is meant to avoid.
 */
export function transactionProof(chain, txHash) {
  const found = chain.transactionByHash(txHash);
  if (!found || !found.block) return null;
  const { block, index } = found;
  const leaves = block.transactions.map((tx) => tx.hash);
  return {
    txHash: String(txHash).toLowerCase(),
    blockHash: block.hash,
    blockNumber: Number(block.header.number),
    // Canonical *right now*, on this node. A verifier that cares must follow
    // headers itself; this is a courtesy, not a proof, and is labelled so.
    canonicalOnThisNode: chain.isCanonical(block.hash),
    header: {
      number: block.header.number.toString(),
      parentHash: block.header.parentHash,
      timestamp: block.header.timestamp.toString(),
      miner: block.header.miner,
      stateRoot: block.header.stateRoot,
      txRoot: block.header.txRoot,
      difficulty: block.header.difficulty.toString(),
      gasLimit: block.header.gasLimit.toString(),
      gasUsed: block.header.gasUsed.toString(),
      extraData: block.header.extraData ?? '0x',
      nonce: (block.header.nonce ?? 0n).toString(),
    },
    index,
    siblings: merkleProof(leaves, index),
    raw: found.tx.raw,
    // ⛔ The EXACT bytes the block hash is taken over, handed across rather
    // than left to be rebuilt on the other side. MolibraSettlement checks
    // `keccak256(headerRlp) == anchoredHash` and then reads txRoot out of
    // these bytes; if a page re-encoded the header from the fields above,
    // there would be two encoders that must agree forever, and the day they
    // stopped agreeing every settlement would fail with no explanation.
    headerRlp: encodeHeader(block.header),
  };
}

/**
 * The whole check, in one function an outsider can run.
 *
 * Deliberately re-derives everything rather than believing any field it was
 * handed: the block hash from the header, the seal from the header, and the
 * root from the path. A proof that passes this is a proof that a chain with
 * this much work behind it contains this transaction.
 */
export function verifyTransactionProof(proof) {
  const header = {
    number: BigInt(proof.header.number),
    parentHash: proof.header.parentHash,
    timestamp: BigInt(proof.header.timestamp),
    miner: proof.header.miner,
    stateRoot: proof.header.stateRoot,
    txRoot: proof.header.txRoot,
    difficulty: BigInt(proof.header.difficulty),
    gasLimit: BigInt(proof.header.gasLimit),
    gasUsed: BigInt(proof.header.gasUsed),
    extraData: proof.header.extraData ?? '0x',
    nonce: BigInt(proof.header.nonce ?? 0),
  };

  const reasons = [];
  if (blockHash(header) !== String(proof.blockHash).toLowerCase()) {
    reasons.push('the header does not hash to the block hash it claims');
  }
  if (!isValidSeal(header)) {
    reasons.push('the header does not satisfy its own difficulty');
  }
  if (!verifyMerkleProof(proof.txHash, proof.siblings, header.txRoot)) {
    reasons.push('the transaction is not in this block\'s transaction root');
  }
  return {
    ok: reasons.length === 0,
    reasons,
    // Said every time, so nobody builds on a proof believing it says more than
    // it does.
    note: 'proves inclusion in a block with valid proof of work; it does NOT '
      + 'prove that block is canonical - follow headers by cumulative difficulty for that',
  };
}
