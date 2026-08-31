/**
 * Molibra - blind credentials, phase 2: the consensus half.
 *
 * Phase 1 (`blind.js`) is the cryptography: RSA-FDH blind signatures, one key
 * per voting place. This file is what the CHAIN does with them - two tagged
 * transactions and the rules a validator applies to each.
 *
 *   POLL_OPEN           registers a voting place and its credential public key
 *   CREDENTIAL_EXPRESS  spends one credential: serial + signature + commitment
 *
 * ## ⛔⛔ The uniqueness key is the SERIAL, never the wallet
 *
 * An ordinary expression (`vote.js`) is unique per `H(wallet || pollId)` - the
 * chain knows exactly which wallet spoke. A credential expression is unique
 * per `(pollId, serial)` and the wallet is NOT part of the key.
 *
 * That difference IS the feature. If the wallet were in the key, the chain
 * would link the credential to the account that spent it and the blind
 * signature would have bought nothing at all. A reviewer looking for one bug
 * in this file should look here first: any change that mixes `tx.from` into
 * the uniqueness key silently destroys the property the scheme exists for,
 * while leaving every test that only checks "spent once" still passing.
 *
 * ## ⛔ What this buys, by its own name
 *
 * **Unlinkability, not coercion resistance.** The publisher cannot tell which
 * expression came from which credential request. But the person still holds
 * the credential and can prove to a buyer that they used it, and the publisher
 * still learns *that* an account asked for a credential for a place. Calling
 * this "anonymous voting" would be a lie by omission.
 *
 * ## Where the quota lives
 *
 * Not here. The chain enforces two things: the signature is genuine for that
 * place, and the serial has not been spent. How many credentials any account
 * may ask for is the publisher's policy, enforced when it blind-signs - it is
 * the one thing the publisher CAN still see, and the only place a quota is
 * enforceable at all.
 */

import { keccak256, toHex, fromHex, concatBytes, normalizeAddress } from './crypto.js';
import { verify as verifyBlindSignature } from './blind.js';
import { toPollId } from './vote.js';

const utf8 = (text) => new TextEncoder().encode(text);

/** 4-byte tags, derived the same way VOTE_TAG is. */
export const POLL_OPEN_TAG = toHex(keccak256(utf8('openPlace(bytes32,bytes,bytes)'))).slice(0, 10);
export const CREDENTIAL_TAG = toHex(keccak256(utf8('credentialExpress(bytes32,bytes32,bytes32,bytes)'))).slice(0, 10);

/** RSA-2048: a 256-byte modulus and a 256-byte signature. */
export const MODULUS_BYTES = 256;
export const POLL_OPEN_BYTES = 4 + 32 + 4 + MODULUS_BYTES;            // 296
export const CREDENTIAL_BYTES = 4 + 32 + 32 + 32 + MODULUS_BYTES;     // 356

function fixed(value, length, label) {
  const bytes = fromHex(String(value));
  if (bytes.length !== length) {
    throw new Error(`${label} must be ${length} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** Left-pad a bigint into exactly `length` bytes. */
function bigToFixed(value, length, label) {
  const v = BigInt(value);
  if (v < 0n) throw new Error(`${label} must not be negative`);
  const hex = v.toString(16).padStart(length * 2, '0');
  if (hex.length !== length * 2) throw new Error(`${label} does not fit in ${length} bytes`);
  return fromHex('0x' + hex);
}

/* ------------------------------------------------------------ POLL_OPEN */

/**
 * Open a voting place.
 *
 * `data = TAG || pollId(32) || e(4) || n(256)`
 *
 * The exponent is carried in four bytes because every practical RSA exponent
 * fits (65537 is three), and a variable-length field here would make the
 * payload length ambiguous - which is how a decoder ends up guessing.
 */
export function encodePollOpen(pollId, { n, e }) {
  return toHex(concatBytes(
    fromHex(POLL_OPEN_TAG),
    fixed(toPollId(pollId), 32, 'pollId'),
    bigToFixed(e, 4, 'exponent'),
    bigToFixed(n, MODULUS_BYTES, 'modulus'),
  ));
}

export function decodePollOpen(data) {
  if (!data) return null;
  const hex = String(data).toLowerCase();
  if (!hex.startsWith(POLL_OPEN_TAG)) return null;
  const bytes = fromHex(hex);
  if (bytes.length !== POLL_OPEN_BYTES) {
    throw new Error(`a poll opening must be ${POLL_OPEN_BYTES} bytes, got ${bytes.length}`);
  }
  const pollId = toHex(bytes.slice(4, 36));
  const e = BigInt(toHex(bytes.slice(36, 40)));
  const n = BigInt(toHex(bytes.slice(40, 40 + MODULUS_BYTES)));
  return { pollId, e, n };
}

/**
 * Rules a validator applies before a place may exist.
 *
 * A modulus that is too small, or an even one, or an exponent of 0 or 1, would
 * all "work" in the sense of producing signatures anybody could forge. They
 * are refused here rather than left for a court to discover.
 */
export function assertPollOpenShape({ n, e }) {
  const bits = n.toString(2).length;
  if (bits < 2040) throw new Error(`credential modulus too small: ${bits} bits`);
  if (n % 2n === 0n) throw new Error('an even modulus is not an RSA modulus');
  if (e < 3n) throw new Error('a credential exponent below 3 signs nothing safely');
  if (e % 2n === 0n) throw new Error('an even exponent cannot be an RSA exponent');
}

/* --------------------------------------------------- CREDENTIAL_EXPRESS */

/**
 * Spend a credential.
 *
 * `data = TAG || pollId(32) || serial(32) || commitment(32) || signature(256)`
 *
 * The commitment is the same opaque 32 bytes an ordinary expression carries:
 * the chain proves a credential was spent once, and reveals nothing about what
 * was said.
 */
export function encodeCredentialExpress(pollId, serial, commitment, signature) {
  return toHex(concatBytes(
    fromHex(CREDENTIAL_TAG),
    fixed(toPollId(pollId), 32, 'pollId'),
    fixed(serial, 32, 'serial'),
    fixed(commitment, 32, 'commitment'),
    bigToFixed(signature, MODULUS_BYTES, 'signature'),
  ));
}

export function decodeCredentialExpress(data) {
  if (!data) return null;
  const hex = String(data).toLowerCase();
  if (!hex.startsWith(CREDENTIAL_TAG)) return null;
  const bytes = fromHex(hex);
  if (bytes.length !== CREDENTIAL_BYTES) {
    throw new Error(`a credential expression must be ${CREDENTIAL_BYTES} bytes, got ${bytes.length}`);
  }
  return {
    pollId: toHex(bytes.slice(4, 36)),
    serial: toHex(bytes.slice(36, 68)),
    commitment: toHex(bytes.slice(68, 100)),
    signature: BigInt(toHex(bytes.slice(100, 100 + MODULUS_BYTES))),
  };
}

/**
 * The key under which a spent credential is remembered.
 *
 * ⛔ `tx.from` is deliberately absent. See the note at the top of this file
 * before adding it.
 */
export function serialKey(pollId, serial) {
  return `${String(pollId).toLowerCase()}:${String(serial).toLowerCase()}`;
}

/**
 * Is this a genuine credential for this place?
 *
 * Pure public maths, so every node - and a browser - reaches the same verdict
 * from the same public data. No private key is involved in checking.
 */
export function credentialIsValid({ serial, signature }, { n, e }) {
  return verifyBlindSignature(serial, signature, { n, e, bytes: MODULUS_BYTES });
}

/**
 * A credential expression moves no value and is self-addressed, exactly like
 * an ordinary expression: the fee is the whole economic content.
 */
export function assertCredentialShape(tx) {
  if (tx.value !== 0n) throw new Error('a credential expression moves no value');
  if (!tx.to || normalizeAddress(tx.to) !== normalizeAddress(tx.from)) {
    throw new Error('a credential expression must be self-addressed');
  }
}
