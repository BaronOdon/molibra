/**
 * Molibra - user-created tokens, and Chalk (GIZ).
 *
 * Two transaction shapes, both ordinary signed transactions tagged in `data`,
 * so a standard wallet can produce either with no custom client:
 *
 *   TOKEN_CREATE   tag(4) ‖ utf8 JSON record
 *   EXPRESS        tag(4) ‖ tokenId(32) ‖ commitment(32)
 *
 * The load-bearing rules, all enforced by consensus rather than by interface:
 *
 *   - **The id is derived, never chosen**: H(creator ‖ title ‖ createdAt). Nobody
 *     can squat a name or impersonate another token's identity.
 *   - **The mode is immutable.** A question whose rules can move after people
 *     have answered is not a record of anything. There is no setter, by design.
 *   - **An electoral token can never be transferable.** A transferable, priced
 *     instrument that grants a say on candidates is a fundamentally different
 *     object; the rule is in the validator, not in a style guide.
 *   - **Expressing burns the unit.** Destroyed, not transferred, so
 *     `minted − remaining = expressions cast` and the count needs no trusted
 *     counter. It also cannot be replayed: the unit no longer exists.
 */

import { keccak256, toHex, fromHex, concatBytes, normalizeAddress } from './crypto.js';

const utf8 = (t) => new TextEncoder().encode(t);
const fromUtf8 = (b) => new TextDecoder().decode(b);

/** 4-byte tags: first bytes of keccak256 of the call signature. */
export const TOKEN_CREATE_TAG = toHex(keccak256(utf8('createToken(bytes)'))).slice(0, 10);
export const EXPRESS_TAG = toHex(keccak256(utf8('express(bytes32,bytes32)0'))).slice(0, 10);

export const VOTE_MODES = ['single', 'capped', 'weighted'];

/** Deterministic token id - derived, so it cannot be squatted. */
export function tokenId(creator, title, createdAt) {
  return toHex(keccak256(concatBytes(
    fromHex(normalizeAddress(creator)),
    utf8(String(title)),
    utf8(String(createdAt)),
  )));
}

/** Build the `data` for a TOKEN_CREATE. */
export function encodeTokenCreate(record) {
  return toHex(concatBytes(fromHex(TOKEN_CREATE_TAG), utf8(JSON.stringify(record))));
}

/** Build the `data` for an EXPRESS. */
export function encodeExpress(id, commitment) {
  const b32 = (v, label) => {
    const bytes = fromHex(String(v));
    if (bytes.length !== 32) throw new Error(`${label} must be 32 bytes`);
    return bytes;
  };
  return toHex(concatBytes(
    fromHex(EXPRESS_TAG), b32(id, 'tokenId'), b32(commitment, 'commitment'),
  ));
}

/** null when the transaction is not a token creation; throws when tagged but broken. */
export function decodeTokenCreate(data) {
  if (!data || !String(data).toLowerCase().startsWith(TOKEN_CREATE_TAG)) return null;
  const bytes = fromHex(String(data).toLowerCase());
  let record;
  try {
    record = JSON.parse(fromUtf8(bytes.slice(4)));
  } catch {
    throw new Error('malformed token creation: payload is not JSON');
  }
  return record;
}

export function decodeExpress(data) {
  if (!data || !String(data).toLowerCase().startsWith(EXPRESS_TAG)) return null;
  const hex = String(data).toLowerCase();
  if (hex.length !== 2 + 136) {
    throw new Error('malformed expression: expected tag + tokenId + commitment');
  }
  return { tokenId: '0x' + hex.slice(10, 74), commitment: '0x' + hex.slice(74, 138) };
}

/**
 * Validate a token record and return it normalised.
 *
 * Everything here is checked at creation because everything here is immutable
 * afterwards. A record that reaches state is a record every node agreed was
 * well-formed.
 */
export function normalizeTokenRecord(raw, creator, createdAt) {
  const title = String(raw?.title ?? '').trim();
  if (!title) throw new Error('token needs a title: it is the question');
  if (title.length > 200) throw new Error('token title too long (max 200)');

  const options = Array.isArray(raw?.options) ? raw.options.map((o) => String(o).trim()) : [];
  if (options.length < 2) throw new Error('token needs at least two options');
  if (options.length > 64) throw new Error('too many options (max 64)');

  const voteMode = String(raw?.voteMode ?? 'single');
  if (!VOTE_MODES.includes(voteMode)) {
    throw new Error(`unknown vote mode ${voteMode}; expected ${VOTE_MODES.join(', ')}`);
  }
  const cap = voteMode === 'capped' ? BigInt(raw?.cap ?? 0) : 0n;
  if (voteMode === 'capped' && cap < 1n) {
    throw new Error('capped mode needs a cap of at least 1');
  }

  const supply = BigInt(raw?.supply ?? 0);
  if (supply <= 0n) throw new Error('token needs a positive supply');

  const electoral = Boolean(raw?.electoral);
  const transferable = Boolean(raw?.transferable);

  // The rule that carries the whole compliance argument. Not a warning, not a
  // lint: a transferable electoral token is refused by consensus.
  if (electoral && transferable) {
    throw new Error(
      'an electoral token can never be transferable: a priced instrument that '
      + 'grants a say on candidates attaches economic value to political '
      + 'participation, which this chain refuses to record',
    );
  }

  return {
    id: tokenId(creator, title, createdAt),
    creator: normalizeAddress(creator),
    title,
    options,
    voteMode,
    cap: cap.toString(),
    supply: supply.toString(),
    electoral,
    transferable,
    createdAt: String(createdAt),
  };
}

/** Per-wallet, per-token key. Same shape as the poll vote key, scoped to a token. */
export function expressionKey(address, id) {
  return toHex(keccak256(concatBytes(
    fromHex(normalizeAddress(address)), fromHex(String(id)),
  )));
}
