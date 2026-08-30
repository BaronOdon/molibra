/**
 * Molibra - user-created tokens, and Chalk (GIZ).
 *
 * Three transaction shapes, all ordinary signed transactions tagged in `data`,
 * so a standard wallet can produce any of them with no custom client:
 *
 *   TOKEN_CREATE   tag(4) ‖ utf8 JSON record
 *   ISSUE          tag(4) ‖ tokenId(32) ‖ amount(32)          to = recipient
 *   EXPRESS        tag(4) ‖ tokenId(32) ‖ pollId(32) ‖ commitment(32) ‖ amount(32)
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
 *   - **Issuance is not transfer.** ISSUE is one-directional, creator → holder.
 *     A holder can never pass a unit on, so no secondary market can form and no
 *     price exists. This is what keeps Res.-TSE 23.610/2019 art. 29 §8º with
 *     nothing to bite on, and it is why the answer to "how does anyone get GIZ"
 *     is issuance rather than transferability.
 *   - **Expressing burns the amount spent.** Destroyed, not transferred, so
 *     `minted − remaining = units burned` and the count needs no trusted
 *     counter. It also cannot be replayed: the units no longer exist.
 *
 * ## Granularity
 *
 * Token amounts are integers in the wei convention: 18 implied decimals. A
 * token is *fine-grained*, spent in small amounts across many questions, rather
 * than being a one-shot ticket - so `expressionCost` is denominated the same
 * way (`10n ** 15n` is 0.001 of a unit).
 */

import { keccak256, toHex, fromHex, concatBytes, normalizeAddress } from './crypto.js';

const utf8 = (t) => new TextEncoder().encode(t);
const fromUtf8 = (b) => new TextDecoder().decode(b);

/** 4-byte tags: first bytes of keccak256 of the call signature. */
export const TOKEN_CREATE_TAG = toHex(keccak256(utf8('createToken(bytes)'))).slice(0, 10);
export const EXPRESS_TAG = toHex(keccak256(utf8('express(bytes32,bytes32)1'))).slice(0, 10);
export const ISSUE_TAG = toHex(keccak256(utf8('issue(bytes32,uint256)'))).slice(0, 10);

export const VOTE_MODES = ['single', 'quantum', 'capped', 'weighted'];

/**
 * What a question is FOR - declared at creation, immutable, and published with
 * the token.
 *
 * The DataToalha mark is registered for **pesquisa e comunicação social**, and
 * that inscription is the scope: a question carried on this chain is market
 * measurement, consumer behaviour, or social communication. Declaring which,
 * on the record, is what makes the scope checkable instead of asserted - and
 * during an election period it is what distinguishes the board from an
 * electoral poll, which is a regulated object with its own registration duty.
 *
 * `electoral` exists as a value precisely so that a question whose subject IS
 * electoral must say so and be bound by the rules that follow. Removing the
 * value would not remove such questions; it would only remove the label.
 */
export const PURPOSES = ['market', 'behaviour', 'social', 'purchase', 'electoral'];

/** The vocabulary of the mark and of the rule, not a translation table. */
export const PURPOSE_LABELS = {
  market: 'aferição de mercado',
  behaviour: 'comportamento do consumidor',
  social: 'comunicação social',
  purchase: 'expressão pública de compra',
  electoral: 'matéria eleitoral',
};

/**
 * `purpose: 'purchase'` — **expressão pública de compra**, and the name is the
 * point.
 *
 * The object it records is this: as consumers, people demand daily-use goods
 * bearing the characteristics of the political figure they prefer, and as a
 * free people they demand that the sale of those goods be **public**. They do
 * not merely permit the publicity; they ask for it. The purchase IS the
 * expression, made by the buyer, about themselves.
 *
 * That is why anything running in an electoral period is declared this way and
 * **never as an enquete or a pesquisa** - to be compliant with the TSE
 * resolutions. Under Res.-TSE 23.600/2019 an enquete is a regulated object,
 * barred outright from 15 August of an election year, and a pesquisa carries a
 * registration duty; a purchase publicly expressed by the person who made it
 * is neither. Calling it either would be both wrong and expensive, so the
 * words are refused in the title below rather than discouraged in a document.
 */
const FORBIDDEN_IN_PURCHASE_TITLE = /\b(enquete|enquetes|pesquisa|pesquisas)\b/i;

/** One unit, in the wei convention. Amounts are integers of 10^-18 of a unit. */
export const UNIT = 10n ** 18n;

/** 0.001 of a unit. Fine enough that one holding covers many questions. */
export const DEFAULT_EXPRESSION_COST = 10n ** 15n;

/**
 * `quantum` — the mode GIZ uses, and the reason the others do not fit it.
 *
 * Each question is a **macrobiotic quantum**: a voting place. A GIZ unit is one
 * of its **subquanta**. A unit enters a voting place when it is spent there
 * and, once it has left, it can never return to THAT place — so a wallet
 * expresses exactly once per voting place. The same wallet's units remain free
 * to enter other voting places, each once.
 *
 * Consequences that distinguish it from every other mode:
 *   - uniqueness is keyed to the VOTING PLACE, `H(wallet ‖ pollId)`, not to the
 *     token. `single` keys to the token, which would cap a wallet at one
 *     expression across all questions for all time — wrong for a currency
 *     meant to be spent in small amounts across many questions.
 *   - one token therefore spans many questions. GIZ is a currency, not a
 *     ballot paper.
 *   - the burn still comes from the token supply, so `minted − remaining`
 *     remains the total burned across every question.
 */

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

const u256 = (v) => {
  const n = BigInt(v);
  if (n < 0n) throw new Error('amount cannot be negative');
  const hex = n.toString(16).padStart(64, '0');
  if (hex.length !== 64) throw new Error('amount does not fit in 32 bytes');
  return fromHex('0x' + hex);
};

const b32 = (v, label) => {
  const bytes = fromHex(String(v));
  if (bytes.length !== 32) throw new Error(`${label} must be 32 bytes`);
  return bytes;
};

/**
 * Build the `data` for an ISSUE. The recipient is the transaction's `to`, so
 * the issuance reads as what it is - a zero-value transaction addressed to the
 * person receiving standing to speak - and no address is duplicated on the wire
 * where the two copies could disagree.
 */
export function encodeIssue(id, amount) {
  return toHex(concatBytes(fromHex(ISSUE_TAG), b32(id, 'tokenId'), u256(amount)));
}

/**
 * Build the `data` for an EXPRESS.
 *
 * `pollId` names the macrobiotic quantum — the voting place. It is carried on
 * every expression, not only the `quantum`-mode ones, so the wire format does
 * not change with the mode of a token the reader may not have fetched yet.
 * Modes that do not scope by voting place simply ignore it.
 *
 * `amount` is the quantity burned. It travels explicitly rather than being
 * implied, so an explorer can read what an expression cost without holding the
 * token record, and so a `weighted` expression states its own weight. The
 * validator refuses anything but exactly `expressionCost` in every mode except
 * `weighted` — a fixed cost is what keeps those modes egalitarian.
 */
export function encodeExpress(id, pollId, commitment, amount = DEFAULT_EXPRESSION_COST) {
  return toHex(concatBytes(
    fromHex(EXPRESS_TAG),
    b32(id, 'tokenId'),
    b32(pollId, 'pollId'),
    b32(commitment, 'commitment'),
    u256(amount),
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

export function decodeIssue(data) {
  if (!data || !String(data).toLowerCase().startsWith(ISSUE_TAG)) return null;
  const hex = String(data).toLowerCase();
  if (hex.length !== 2 + 8 + 128) {
    throw new Error('malformed issuance: expected tag + tokenId + amount');
  }
  return {
    tokenId: '0x' + hex.slice(10, 74),
    amount: BigInt('0x' + hex.slice(74, 138)),
  };
}

export function decodeExpress(data) {
  if (!data || !String(data).toLowerCase().startsWith(EXPRESS_TAG)) return null;
  const hex = String(data).toLowerCase();
  if (hex.length !== 2 + 8 + 256) {
    throw new Error(
      'malformed expression: expected tag + tokenId + pollId + commitment + amount');
  }
  return {
    tokenId: '0x' + hex.slice(10, 74),
    pollId: '0x' + hex.slice(74, 138),
    commitment: '0x' + hex.slice(138, 202),
    amount: BigInt('0x' + hex.slice(202, 266)),
  };
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

  // Supply is two numbers now, not one: what exists at creation, and the
  // ceiling on what may ever exist. `maxSupply: 0` means UNCAPPED, which is
  // the honest default for a question board - questions never stop being
  // created, so demand for the instrument to answer them is unbounded.
  const initialSupply = BigInt(raw?.initialSupply ?? 0);
  if (initialSupply < 0n) throw new Error('initial supply cannot be negative');
  const maxSupply = BigInt(raw?.maxSupply ?? 0);
  if (maxSupply < 0n) throw new Error('max supply cannot be negative');
  if (maxSupply > 0n && initialSupply > maxSupply) {
    throw new Error('initial supply exceeds max supply');
  }

  const expressionCost = BigInt(raw?.expressionCost ?? DEFAULT_EXPRESSION_COST);
  if (expressionCost <= 0n) throw new Error('expression cost must be positive');

  // The purpose is declared, never inferred, and there is no default: a
  // silent default on an immutable record is exactly the trap this field
  // exists to close.
  const purpose = String(raw?.purpose ?? '');
  if (!PURPOSES.includes(purpose)) {
    throw new Error(
      `a token must declare its purpose (${PURPOSES.join(', ')}): the mark is `
      + 'registered for pesquisa e comunicação social, and which of those a '
      + 'question is has to be on the record rather than asserted',
    );
  }
  // The naming rule, enforced. A question declared as expressão pública de
  // compra cannot carry the name of a regulated object it is not.
  if (purpose === 'purchase' && FORBIDDEN_IN_PURCHASE_TITLE.test(title)) {
    throw new Error(
      'a token declared as expressão pública de compra cannot be called an '
      + 'enquete or a pesquisa: those are regulated objects under the TSE '
      + 'resolutions, with their own duties and prohibitions, and this is not '
      + 'one of them',
    );
  }

  const electoral = purpose === 'electoral';
  // `electoral` is DERIVED from the purpose, so the two can never disagree.
  // A record that states it anyway and states it wrongly is refused rather
  // than silently overridden.
  if (raw?.electoral !== undefined && Boolean(raw.electoral) !== electoral) {
    throw new Error(
      `electoral is derived from purpose: purpose ${purpose} implies electoral=${electoral}`);
  }

  const transferable = Boolean(raw?.transferable);
  const issuable = raw?.issuable === undefined ? true : Boolean(raw.issuable);

  // The rule that carries the whole compliance argument. Not a warning, not a
  // lint: it is refused by consensus.
  //
  // It binds `social` and `purchase` as well as `electoral`, and deliberately:
  // comunicação social on public affairs, and a purchase publicly expressed in
  // an electoral period, are the very surface Res.-TSE 23.610/2019 art. 29 §8º
  // guards. A priced instrument for speaking there attaches economic value to
  // political participation just as directly as one labelled electoral would.
  // Market measurement and consumer behaviour are a different object and may
  // be transferable if a creator opts in.
  if ((electoral || purpose === 'social' || purpose === 'purchase') && transferable) {
    throw new Error(
      `a ${purpose} token can never be transferable: a priced instrument that `
      + 'grants a say on public matters attaches economic value to political '
      + 'participation, which this chain refuses to record',
    );
  }

  // The dead end, refused at the door. A token that is neither issuable nor
  // transferable can never reach a second holder, so nobody but the creator
  // could ever express on it. That is not a strict token, it is a token
  // nobody can use, and it would be discovered only after the record became
  // immutable.
  if (!issuable && !transferable) {
    throw new Error(
      'a token that is neither issuable nor transferable can never reach a '
      + 'second holder: nobody but the creator could ever express on it',
    );
  }
  if (!issuable && initialSupply === 0n) {
    throw new Error('a token with no initial supply must be issuable, or no unit can ever exist');
  }

  return {
    id: tokenId(creator, title, createdAt),
    creator: normalizeAddress(creator),
    title,
    options,
    voteMode,
    cap: cap.toString(),
    initialSupply: initialSupply.toString(),
    maxSupply: maxSupply.toString(),
    expressionCost: expressionCost.toString(),
    issuable,
    purpose,
    electoral,
    transferable,
    createdAt: String(createdAt),
  };
}

/**
 * What an expression must burn, given the token and the amount on the wire.
 * Throws with the reason when the amount is not allowed, so the mempool guard
 * and the state transition can share one rule rather than two copies of it.
 *
 * Fixed for `single`, `quantum` and `capped`: nobody's expression can be larger
 * than anyone else's, which is what keeps those modes egalitarian. Only
 * `weighted` lets the amount vary, because there the amount IS the weight -
 * which is exactly why that mode is plutocratic by construction.
 */
export function expressionBurn(token, amount) {
  const cost = BigInt(token.expressionCost);
  const asked = BigInt(amount);
  if (token.voteMode === 'weighted') {
    if (asked < cost) {
      throw new Error(`a weighted expression must burn at least ${cost}, got ${asked}`);
    }
    return asked;
  }
  if (asked !== cost) {
    throw new Error(
      `an expression on this token burns exactly ${cost}, got ${asked}: `
      + 'a fixed cost is what keeps this mode egalitarian',
    );
  }
  return cost;
}

/**
 * The uniqueness key. `scope` is the token id for `single` and `capped`, and
 * the POLL id for `quantum` — which is the whole difference between them.
 */
export function expressionKey(address, scope) {
  return toHex(keccak256(concatBytes(
    fromHex(normalizeAddress(address)), fromHex(String(scope)),
  )));
}
