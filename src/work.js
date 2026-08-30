/**
 * Molibra - the earning puzzle.
 *
 * A person with no chalk has to be able to get some by doing something, not by
 * being on a list. This is that something: a small proof of work, done in the
 * browser at the click of a button, which the node checks before the publisher
 * issues GIZ to the address that did it.
 *
 * ## What this is NOT
 *
 * It is **not block mining** and it does not secure the chain. Block PoW is
 * Keccak-256 over a header and it is what MOLI pays for; this is SHA-256 over a
 * challenge and it pays in GIZ, which has no price. Saying otherwise would be a
 * lie to the person clicking the button, and the page says so in those words.
 *
 * SHA-256 rather than Keccak-256 for one blunt reason: the browser has to
 * compute it, and a page that must stay dependency-free can carry a compact
 * SHA-256 but not a Keccak. Nothing consensus-critical depends on this choice -
 * the puzzle is a cost function for a faucet, not a rule of the chain.
 *
 * ## Why work at all
 *
 * Because the alternative is a list of who may speak, and building that list
 * means building the register of identified political preferences the whole
 * design refuses. Work costs the same for everyone and identifies nobody.
 * It is a speed bump against a script claiming a thousand grants, not a
 * Sybil defence - and §8.1 of the white paper does not pretend otherwise.
 */

import { createHash, randomBytes } from 'node:crypto';
import { normalizeAddress, fromHex } from './crypto.js';

/**
 * Default: a few seconds of visible work in a browser, and nothing more.
 *
 * Calibrated, not guessed. The page's own loop measures ~2.2M hashes/s on V8
 * on this machine, so 2,000,000 is a shade under a second on a fast desktop
 * and roughly five to ten on a mid-range phone. That is the band the design
 * wants: long enough that the person SEES the work happen and a script cannot
 * farm grants for free, short enough that nobody abandons it.
 *
 * Re-measure before changing it. `test/browser-work.mjs` prints the rate and the
 * implied wait, and fails if the page and this file ever disagree.
 */
export const DEFAULT_WORK_DIFFICULTY = 2000000;

/** A fresh 16-byte challenge, hex, issued by the node and single-use. */
export function newChallenge() {
  return '0x' + randomBytes(16).toString('hex');
}

/**
 * The preimage: challenge ‖ address ‖ nonce (8 bytes, big-endian).
 *
 * The address is IN the preimage, so a solution is bound to the wallet that
 * will receive the grant. Somebody else's solved challenge is worthless.
 */
export function workPreimage(challenge, address, nonce) {
  const c = fromHex(challenge);
  const a = fromHex(normalizeAddress(address));
  const n = Buffer.alloc(8);
  n.writeBigUInt64BE(BigInt(nonce));
  return Buffer.concat([Buffer.from(c), Buffer.from(a), n]);
}

/**
 * The comparable value of a hash: its first 6 bytes, big-endian, as a Number.
 * Six bytes keeps it exactly representable (2^48 < 2^53), so the browser can
 * run the hot loop in plain integers rather than BigInt - which is the
 * difference between a few seconds and a stalled tab.
 */
export function workValue(hash) {
  return hash[0] * 2 ** 40 + hash[1] * 2 ** 32 + hash[2] * 2 ** 24
    + hash[3] * 2 ** 16 + hash[4] * 2 ** 8 + hash[5];
}

/** The threshold a solution must come in under. */
export function workThreshold(difficulty) {
  const d = Number(difficulty);
  if (!Number.isFinite(d) || d < 1) throw new Error('difficulty must be at least 1');
  return 2 ** 48 / d;
}

export function workHash(challenge, address, nonce) {
  return createHash('sha256').update(workPreimage(challenge, address, nonce)).digest();
}

/** True when this nonce solves this challenge for this address. */
export function verifyWork(challenge, address, nonce, difficulty) {
  return workValue(workHash(challenge, address, nonce)) < workThreshold(difficulty);
}

/**
 * Reference solver. The browser has its own copy of this loop; this one exists
 * so the tests grind a real solution rather than asserting that one would be
 * accepted.
 */
export function solveWork(challenge, address, difficulty, maxNonce = 50_000_000) {
  const threshold = workThreshold(difficulty);
  for (let nonce = 0; nonce < maxNonce; nonce++) {
    if (workValue(workHash(challenge, address, nonce)) < threshold) return nonce;
  }
  return null;
}
