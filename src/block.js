/**
 * Molibra - blocks, Merkle roots and proof of work.
 */

import { RLP } from '@ethereumjs/rlp';
import { keccak256, toHex, fromHex, bigToBytes, bytesToBig, concatBytes } from './crypto.js';

export const ZERO_HASH = '0x' + '00'.repeat(32);

/** Binary Merkle root over transaction hashes. Odd nodes are promoted. */
export function merkleRoot(hashes) {
  if (hashes.length === 0) return ZERO_HASH;
  let level = hashes.map((h) => fromHex(h));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? keccak256(concatBytes(level[i], level[i + 1])) : level[i]);
    }
    level = next;
  }
  return toHex(level[0]);
}

/** The header fields that are hashed, in a fixed order. */
function headerItems(header, includeNonce) {
  const items = [
    bigToBytes(header.number),
    fromHex(header.parentHash),
    bigToBytes(header.timestamp),
    fromHex(header.miner),
    fromHex(header.stateRoot),
    fromHex(header.txRoot),
    bigToBytes(header.difficulty),
    bigToBytes(header.gasLimit),
    bigToBytes(header.gasUsed),
    fromHex(header.extraData ?? '0x'),
  ];
  if (includeNonce) items.push(bigToBytes(header.nonce ?? 0));
  return items;
}

/** Hash of the sealed header - this is the block hash. */
export function blockHash(header) {
  return toHex(keccak256(RLP.encode(headerItems(header, true))));
}

/** The pre-seal digest that proof of work grinds against. */
export function sealDigest(header) {
  return keccak256(RLP.encode(headerItems(header, false)));
}

const TWO_256 = 1n << 256n;

/** Difficulty -> the value the seal hash must fall under. */
export function targetFor(difficulty) {
  const d = BigInt(difficulty);
  if (d <= 0n) throw new Error('difficulty must be positive');
  return TWO_256 / d;
}

/** Does this header satisfy its own difficulty? */
export function isValidSeal(header) {
  const digest = sealDigest(header);
  const hash = keccak256(concatBytes(digest, bigToBytes(header.nonce ?? 0)));
  return bytesToBig(hash) < targetFor(header.difficulty);
}

/**
 * Grind nonces until the seal is valid. Returns the sealed header.
 * `signal.stop` lets a caller interrupt a long grind.
 */
export function mineHeader(header, { start = 0n, signal = null, maxRounds = Infinity } = {}) {
  const digest = sealDigest(header);
  const target = targetFor(header.difficulty);
  let nonce = BigInt(start);
  let rounds = 0;
  for (;;) {
    const hash = keccak256(concatBytes(digest, bigToBytes(nonce)));
    if (bytesToBig(hash) < target) {
      return { ...header, nonce };
    }
    nonce += 1n;
    if (signal?.stop) return null;
    // Bounded slices. An unbounded grind starves the event loop, which means a
    // mining node stops answering RPC exactly as difficulty rises - the wallet
    // sees the network as down while the node is busy working.
    if (++rounds >= maxRounds) {
      if (signal) signal.nextNonce = nonce;
      return null;
    }
  }
}

/**
 * Retarget so blocks land near the target interval. Adjusts by 1/16 per block
 * and never drops below the floor - the same shape as Ethereum's homestead
 * rule, without the uncle and bomb terms.
 */
export function nextDifficulty(parentHeader, timestamp, targetSeconds, minimum) {
  const parent = BigInt(parentHeader.difficulty);
  const elapsed = BigInt(timestamp) - BigInt(parentHeader.timestamp);
  const step = parent / 16n || 1n;
  let next = elapsed < BigInt(targetSeconds) ? parent + step : parent - step;
  if (next < BigInt(minimum)) next = BigInt(minimum);
  return next;
}

/** Total work behind a chain tip - the fork-choice metric. */
export function totalDifficulty(blocks) {
  return blocks.reduce((sum, block) => sum + BigInt(block.header.difficulty), 0n);
}

export function serializeBlock(block) {
  return {
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
    hash: block.hash,
    transactions: block.transactions.map((tx) => tx.raw),
  };
}

export function deserializeHeader(header) {
  return {
    number: BigInt(header.number),
    parentHash: header.parentHash,
    timestamp: BigInt(header.timestamp),
    miner: header.miner,
    stateRoot: header.stateRoot,
    txRoot: header.txRoot,
    difficulty: BigInt(header.difficulty),
    gasLimit: BigInt(header.gasLimit),
    gasUsed: BigInt(header.gasUsed),
    extraData: header.extraData ?? '0x',
    nonce: BigInt(header.nonce ?? 0),
  };
}
