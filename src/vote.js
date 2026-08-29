/**
 * Molibra - expressions of will.
 *
 * An expression is an ordinary EIP-155 transaction whose `data` carries a tag,
 * so a standard wallet can produce one with no custom client - the same reason
 * the rest of the chain reuses Ethereum's primitives.
 *
 * Shape of a tagged transaction:
 *
 *   to    = from        the ballot never moves money; a vote is self-addressed
 *   value = 0           nothing of value changes hands, only the fee is spent
 *   data  = TAG (4 bytes) || pollId (32) || commitment (32)
 *
 * The fee is the whole economic content: it makes an identity cost something,
 * which is the anti-Sybil property, without attaching anything of value to the
 * act of speaking.
 *
 * The choice itself is NOT in the clear. `commitment` is an opaque 32 bytes -
 * a hash of the choice and a blinding factor - so the chain proves that a
 * wallet spoke once on a poll while revealing nothing about what it said. The
 * count is public; the content stays private until reveal.
 *
 * Uniqueness key: H(wallet || pollId). Scoped to the poll on purpose - a wallet
 * that has spoken on one question is untouched on every other. The keys live in
 * State, so a reorg that unwinds the block unwinds the right to speak again for
 * free; there is no separate register to drift out of step with the chain.
 */

import { keccak256, toHex, fromHex, concatBytes, normalizeAddress } from './crypto.js';

const utf8 = (text) => new TextEncoder().encode(text);

/** 4-byte tag: the first bytes of keccak256("express(bytes32,bytes32)"). */
export const VOTE_TAG = toHex(keccak256(utf8('express(bytes32,bytes32)'))).slice(0, 10);

export const VOTE_DATA_BYTES = 68; // 4 + 32 + 32

/** Anything -> a 32-byte poll id. 0x-prefixed 32 bytes passes through; any
 *  other string is hashed, so "prefeitura-sp-2026" is a usable poll id. */
export function toPollId(value) {
  const text = String(value);
  if (/^0x[0-9a-fA-F]{64}$/.test(text)) return text.toLowerCase();
  return toHex(keccak256(utf8(text)));
}

function toBytes32(value, label) {
  const bytes = fromHex(String(value));
  if (bytes.length !== 32) throw new Error(`${label} must be 32 bytes, got ${bytes.length}`);
  return bytes;
}

/** Build the `data` field of an expression. */
export function encodeVoteData(pollId, commitment) {
  return toHex(concatBytes(
    fromHex(VOTE_TAG),
    toBytes32(toPollId(pollId), 'pollId'),
    toBytes32(commitment, 'commitment'),
  ));
}

/**
 * Read an expression out of a `data` field.
 * Returns null when the transaction is not tagged - an ordinary transfer.
 * Throws when it IS tagged but malformed, so a broken vote is never silently
 * treated as a payment.
 */
export function decodeVoteData(data) {
  if (!data || data === '0x') return null;
  const hex = String(data).toLowerCase();
  if (!hex.startsWith(VOTE_TAG)) return null;
  const bytes = fromHex(hex);
  if (bytes.length !== VOTE_DATA_BYTES) {
    throw new Error(`malformed expression: data is ${bytes.length} bytes, expected ${VOTE_DATA_BYTES}`);
  }
  return {
    pollId: toHex(bytes.slice(4, 36)),
    commitment: toHex(bytes.slice(36, 68)),
  };
}

/** The uniqueness key: H(wallet || pollId), scoped to that one poll. */
export function voteKey(address, pollId) {
  return toHex(keccak256(concatBytes(
    fromHex(normalizeAddress(address)),
    toBytes32(toPollId(pollId), 'pollId'),
  )));
}

/**
 * The rules a tagged transaction must satisfy, independent of state.
 * Kept separate from the duplicate check so the mempool and the block
 * validator can both use it without duplicating the reasoning.
 */
export function assertVoteShape(tx, expression) {
  if (tx.value !== 0n) {
    throw new Error('an expression must carry no value: nothing is bought by speaking');
  }
  if (!tx.to || tx.to !== tx.from) {
    throw new Error('an expression must be self-addressed: the ballot does not move money');
  }
  return expression;
}
