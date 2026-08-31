/**
 * Molibra - account state.
 *
 * Balance and nonce per address, plus deployed code and contract storage.
 *
 * Code and storage live in their own maps rather than inside the account
 * record, for the same reason tokens and vote keys do: they are appended to
 * the root ONLY when present, so a chain written before contracts existed
 * hashes to exactly the same root it always did. Adding the EVM is therefore
 * not a hard fork of the existing chain.
 *
 * NOTE ON stateRoot: this is a deterministic Keccak-256 over the sorted
 * account set, NOT an Ethereum Merkle-Patricia trie root. It gives every node
 * the same fingerprint for the same state (which is what consensus needs), but
 * it is not comparable with an Ethereum state root and does not support
 * trie proofs. Wallets do not check it.
 */

import { keccak256, toHex, fromHex, normalizeAddress } from './crypto.js';
import { runEvm } from './evm.js';
import { decodeVoteData, assertVoteShape, voteKey } from './vote.js';
import {
  decodePollOpen, assertPollOpenShape, decodeCredentialExpress,
  assertCredentialShape, credentialIsValid, serialKey,
} from './credential.js';
import {
  decodeTokenCreate, decodeExpress, decodeIssue, decodeTransfer,
  normalizeTokenRecord, expressionKey, expressionBurn,
} from './token.js';

/** A storage word of zero. Unset and zero are the same thing, as in the EVM. */
export const ZERO_WORD = '0x' + '00'.repeat(32);

/** Anything word-shaped -> a 32-byte 0x hex string, so keys and values sort. */
export function toWord(value) {
  if (value instanceof Uint8Array) {
    const padded = new Uint8Array(32);
    padded.set(value.slice(-32), 32 - Math.min(32, value.length));
    return toHex(padded);
  }
  const big = typeof value === 'bigint' ? value : BigInt(value ?? 0);
  if (big < 0n) throw new Error('negative storage word');
  return '0x' + big.toString(16).padStart(64, '0');
}

const storageKey = (address, slot) => `${normalizeAddress(address)}:${toWord(slot)}`;

/** A transaction's calldata as bytes, whether it arrived as hex or bytes. */
const dataBytes = (tx) => (tx.data instanceof Uint8Array ? tx.data
  : (tx.data ? fromHex(tx.data) : new Uint8Array(0)));

export class State {
  constructor(accounts = new Map(), voteKeys = new Set(),
              tokens = new Map(), tokenBalances = new Map(),
              expressCounts = new Map(),
              code = new Map(), storage = new Map(),
              polls = new Map(), spentSerials = new Set()) {
    this.accounts = accounts;
    // Voting places opened by POLL_OPEN: pollId -> { opener, n, e }. The
    // credential public key lives in consensus state because every node must
    // reach the same verdict on a signature, and a key held off-chain would
    // make that verdict a matter of who you asked.
    this.polls = polls;
    // Credentials already spent, keyed `${pollId}:${serial}`.
    // ⛔ The WALLET IS NOT IN THIS KEY, and must never be - see credential.js.
    this.spentSerials = spentSerials;
    // Deployed runtime code, keyed by address. An address with no entry is an
    // externally owned account; that is the only difference between the two.
    this.code = code;
    // Contract storage, keyed `${address}:${slot}` where slot is a 32-byte
    // hex word. A slot set back to zero is DELETED rather than stored as
    // zero, so the root cannot depend on whether a slot was ever written.
    this.storage = storage;
    // The token registry. Immutable records, plus the supply accounting
    // that makes `minted - remaining = expressions cast` checkable by
    // anyone. Balances are keyed `${tokenId}:${address}`.
    this.tokens = tokens;
    this.tokenBalances = tokenBalances;
    // capped(n) needs a count, not just a flag.
    this.expressCounts = expressCounts;
    // voteKeys holds H(wallet || pollId) for every expression of will already
    // recorded. It lives in state, so a reorg that unwinds a block also unwinds
    // the right to speak again - no separate bookkeeping to get out of step.
    this.voteKeys = voteKeys;
  }

  hasVoteKey(key) {
    return this.voteKeys.has(String(key).toLowerCase());
  }

  recordVoteKey(key) {
    this.voteKeys.add(String(key).toLowerCase());
  }

  /* ----------------------------- tokens ----------------------------- */

  getToken(id) {
    return this.tokens.get(String(id).toLowerCase()) ?? null;
  }

  /**
   * Register a token. `minted`, `burned` and `expressions` are the running
   * accounting: minted grows with every issuance, burned with every
   * expression, and `expressions` counts the acts rather than the units - the
   * two differ under `weighted`, where one expression may burn any amount.
   */
  putToken(record) {
    this.tokens.set(String(record.id).toLowerCase(), {
      ...record,
      minted: record.minted ?? record.initialSupply ?? '0',
      burned: record.burned ?? '0',
      expressions: record.expressions ?? '0',
    });
  }

  tokenBalanceOf(id, address) {
    const k = `${String(id).toLowerCase()}:${normalizeAddress(address)}`;
    return BigInt(this.tokenBalances.get(k) ?? 0n);
  }

  setTokenBalance(id, address, amount) {
    const k = `${String(id).toLowerCase()}:${normalizeAddress(address)}`;
    if (BigInt(amount) === 0n) this.tokenBalances.delete(k);
    else this.tokenBalances.set(k, BigInt(amount));
  }

  /**
   * Mint units into an address. The ONLY path by which units come into
   * existence, used by creation and by ISSUE alike, so `maxSupply` is checked
   * in exactly one place and cannot be bypassed by adding a caller.
   */
  mintToken(id, address, amount) {
    const rec = this.getToken(id);
    if (!rec) throw new Error(`unknown token ${id}`);
    const asked = BigInt(amount);
    if (asked <= 0n) throw new Error('an issuance must be positive');
    const minted = BigInt(rec.minted ?? 0) + asked;
    const max = BigInt(rec.maxSupply ?? 0);
    if (max > 0n && minted > max) {
      throw new Error(`issuing ${asked} would exceed the declared max supply ${max}`);
    }
    rec.minted = minted.toString();
    this.setTokenBalance(id, address, this.tokenBalanceOf(id, address) + asked);
  }

  /**
   * Move units between holders. Only reachable for a token that declared
   * itself transferable - the check lives in applyTransaction, before this is
   * called, because a balance function that enforced policy would be a policy
   * nobody could find.
   */
  moveToken(id, from, to, amount) {
    const held = this.tokenBalanceOf(id, from);
    const asked = BigInt(amount);
    if (held < asked) throw new Error('insufficient token balance');
    this.setTokenBalance(id, from, held - asked);
    this.setTokenBalance(id, to, this.tokenBalanceOf(id, to) + asked);
  }

  /** Destroyed, not transferred - which is what makes the burn the tally. */
  burnToken(id, address, amount) {
    const held = this.tokenBalanceOf(id, address);
    if (held < BigInt(amount)) throw new Error('insufficient token balance');
    this.setTokenBalance(id, address, held - BigInt(amount));
    const rec = this.getToken(id);
    rec.burned = (BigInt(rec.burned ?? 0) + BigInt(amount)).toString();
    rec.expressions = (BigInt(rec.expressions ?? 0) + 1n).toString();
  }

  expressionCount(key) {
    return BigInt(this.expressCounts.get(String(key).toLowerCase()) ?? 0n);
  }

  bumpExpressionCount(key) {
    const k = String(key).toLowerCase();
    this.expressCounts.set(k, this.expressionCount(k) + 1n);
  }

  /** Accepts either a bare account map or { accounts, voteKeys }. */
  static fromJSON(obj) {
    const source = obj && obj.accounts ? obj.accounts : (obj || {});
    const accounts = new Map();
    for (const [address, account] of Object.entries(source)) {
      accounts.set(normalizeAddress(address), {
        balance: BigInt(account.balance ?? 0),
        nonce: BigInt(account.nonce ?? 0),
      });
    }
    const voteKeys = new Set((obj && obj.voteKeys ? obj.voteKeys : []).map((k) => String(k).toLowerCase()));
    const state = new State(accounts, voteKeys);
    for (const [address, hex] of Object.entries((obj && obj.code) || {})) {
      state.setCode(address, fromHex(hex));
    }
    for (const [address, slots] of Object.entries((obj && obj.storage) || {})) {
      for (const [slot, value] of Object.entries(slots)) state.setStorage(address, slot, value);
    }
    return state;
  }

  toJSON() {
    const accounts = {};
    for (const address of [...this.accounts.keys()].sort()) {
      const account = this.accounts.get(address);
      accounts[address] = { balance: account.balance.toString(), nonce: account.nonce.toString() };
    }
    const out = { accounts, voteKeys: [...this.voteKeys].sort() };
    // Omitted entirely when empty, so a chain with no contracts serialises
    // byte-for-byte the way it did before contracts existed.
    if (this.code.size > 0) {
      out.code = {};
      for (const address of [...this.code.keys()].sort()) out.code[address] = toHex(this.code.get(address));
    }
    if (this.storage.size > 0) {
      out.storage = {};
      for (const key of [...this.storage.keys()].sort()) {
        const [address, slot] = key.split(':');
        (out.storage[address] ??= {})[slot] = this.storage.get(key);
      }
    }
    return out;
  }

  clone() {
    const accounts = new Map();
    for (const [address, account] of this.accounts) {
      accounts.set(address, { balance: account.balance, nonce: account.nonce });
    }
    // Vote keys are copied, not shared: a candidate block built on this state
    // must not be able to write a vote back into its parent.
    return new State(
      accounts,
      new Set(this.voteKeys),
      // Records are copied, not shared: a candidate block must not be able
      // to write a burn back into its parent's state.
      new Map([...this.tokens].map(([k, v]) => [k, { ...v }])),
      new Map(this.tokenBalances),
      new Map(this.expressCounts),
      // Code bytes are immutable once deployed, so the arrays may be shared;
      // the MAP must not be, or a candidate block deploying a contract would
      // write it into its parent's state.
      new Map(this.code),
      new Map(this.storage),
      new Map([...this.polls].map(([k, v]) => [k, { ...v }])),
      new Set(this.spentSerials),
    );
  }

  get(address) {
    return this.accounts.get(normalizeAddress(address)) ?? { balance: 0n, nonce: 0n };
  }

  balanceOf(address) {
    return this.get(address).balance;
  }

  nonceOf(address) {
    return this.get(address).nonce;
  }

  set(address, account) {
    this.accounts.set(normalizeAddress(address), account);
  }

  credit(address, amount) {
    const account = this.get(address);
    this.set(address, { balance: account.balance + BigInt(amount), nonce: account.nonce });
  }

  debit(address, amount) {
    const account = this.get(address);
    if (account.balance < BigInt(amount)) {
      throw new Error(`insufficient balance for ${address}`);
    }
    this.set(address, { balance: account.balance - BigInt(amount), nonce: account.nonce });
  }

  bumpNonce(address) {
    const account = this.get(address);
    this.set(address, { balance: account.balance, nonce: account.nonce + 1n });
  }

  /* ------------------------- code and storage ------------------------- */

  /** Deployed runtime code, or an empty array for an ordinary account. */
  getCode(address) {
    return this.code.get(normalizeAddress(address)) ?? new Uint8Array(0);
  }

  hasCode(address) {
    return this.getCode(address).length > 0;
  }

  /**
   * Set deployed code. Empty code is DELETED rather than stored empty, so
   * "deployed nothing" and "never deployed" cannot produce different roots.
   */
  setCode(address, bytes) {
    const key = normalizeAddress(address);
    const code = bytes instanceof Uint8Array ? bytes : fromHex(bytes);
    if (code.length === 0) this.code.delete(key);
    else this.code.set(key, code);
  }

  /** Storage word as a 32-byte hex string; unset slots read as zero. */
  getStorage(address, slot) {
    return this.storage.get(storageKey(address, slot)) ?? ZERO_WORD;
  }

  /** Writing zero clears the slot - see the note on `this.storage`. */
  setStorage(address, slot, value) {
    const key = storageKey(address, slot);
    const word = toWord(value);
    if (word === ZERO_WORD) this.storage.delete(key);
    else this.storage.set(key, word);
  }

  /* ------------------------ credentials ------------------------ */

  getPlace(pollId) {
    return this.polls.get(String(pollId).toLowerCase()) ?? null;
  }

  openPlace(pollId, record) {
    this.polls.set(String(pollId).toLowerCase(), { ...record });
  }

  hasSpentSerial(key) {
    return this.spentSerials.has(String(key).toLowerCase());
  }

  spendSerial(key) {
    this.spentSerials.add(String(key).toLowerCase());
  }

  /** Every slot this address holds, as `{ slot, value }`, sorted by slot. */
  storageOf(address) {
    const prefix = normalizeAddress(address) + ':';
    const out = [];
    for (const key of [...this.storage.keys()].sort()) {
      if (key.startsWith(prefix)) out.push({ slot: key.slice(prefix.length), value: this.storage.get(key) });
    }
    return out;
  }

  /**
   * Deterministic fingerprint of the whole state: accounts, then vote keys.
   *
   * Vote keys are part of the root because every node must agree on who has
   * already spoken - otherwise a block carrying a duplicate expression would be
   * accepted by one node and rejected by another, which is a chain split. They
   * are appended after the accounts and only when present, so a chain written
   * before expressions existed still hashes to exactly the same root.
   */
  root() {
    const lines = [];
    for (const address of [...this.accounts.keys()].sort()) {
      const account = this.accounts.get(address);
      if (account.balance === 0n && account.nonce === 0n) continue; // empty accounts do not count
      lines.push(`${address}:${account.balance.toString(16)}:${account.nonce.toString(16)}`);
    }
    for (const key of [...this.voteKeys].sort()) lines.push(`vote:${key}`);
    // Tokens, balances and counts are consensus state: every node must
    // agree on what exists, who holds it, and how much has been burned,
    // or a block spending a unit would be valid on one node and not
    // another. Appended only when present, so a chain written before
    // tokens existed still hashes to exactly the same root.
    for (const id of [...this.tokens.keys()].sort()) {
      const t = this.tokens.get(id);
      // Every field a node could disagree about is in here: the immutable
      // rules (mode, cap, ceiling, cost, flags) and the running accounting
      // (minted, burned, expressions). An issuance that one node counted and
      // another did not must break the root, not drift quietly.
      lines.push(`token:${id}:${t.kind}:${t.symbol}:${t.decimals}:${t.voteMode}:`
        + `${t.purpose}:${t.cap}:${t.maxSupply}:${t.minted}:${t.burned}:`
        + `${t.expressions}:${t.expressionCost}:`
        + `${t.transferable ? 1 : 0}${t.electoral ? 1 : 0}${t.issuable ? 1 : 0}`);
    }
    for (const k of [...this.tokenBalances.keys()].sort()) {
      lines.push(`tbal:${k}:${this.tokenBalances.get(k).toString(16)}`);
    }
    for (const k of [...this.expressCounts.keys()].sort()) {
      lines.push(`ecount:${k}:${this.expressCounts.get(k).toString(16)}`);
    }
    // Code and storage, on the same terms as everything above: appended only
    // when present, so a chain with no contracts hashes exactly as it did
    // before the EVM existed. Code is hashed rather than inlined - the root
    // must not grow by the size of every contract deployed.
    for (const address of [...this.code.keys()].sort()) {
      lines.push(`code:${address}:${toHex(keccak256(this.code.get(address)))}`);
    }
    for (const key of [...this.storage.keys()].sort()) {
      lines.push(`slot:${key}:${this.storage.get(key)}`);
    }
    // Voting places and spent credentials, on the same appended-only-when-
    // present terms as everything above, so a chain with no credentials in it
    // hashes exactly as it did before they existed.
    for (const id of [...this.polls.keys()].sort()) {
      const p = this.polls.get(id);
      lines.push(`place:${id}:${p.opener}:${p.e.toString(16)}:${p.n.toString(16)}`);
    }
    for (const k of [...this.spentSerials].sort()) lines.push(`serial:${k}`);
    return toHex(keccak256(new TextEncoder().encode(lines.join('\n'))));
  }
}

/**
 * Apply one transaction to the state.
 * Returns the receipt fields; throws with a reason when the transaction is
 * not applicable, so the caller can drop it from the block.
 */
export async function applyTransaction(state, tx, intrinsicGas, miner, blockNumber = 0n,
                                       { chainId = 20226n, timestamp = 0n } = {}) {
  const expectedNonce = state.nonceOf(tx.from);
  if (tx.nonce !== expectedNonce) {
    throw new Error(`bad nonce for ${tx.from}: got ${tx.nonce}, expected ${expectedNonce}`);
  }
  if (tx.gasLimit < intrinsicGas) {
    throw new Error(`gas limit ${tx.gasLimit} below intrinsic gas ${intrinsicGas}`);
  }
  const fee = intrinsicGas * tx.gasPrice;
  const total = fee + tx.value;
  if (state.balanceOf(tx.from) < total) {
    throw new Error(`insufficient funds: ${tx.from} needs ${total}`);
  }

  // An expression of will: the same signed-transaction path, tagged in `data`.
  // Checked BEFORE anything is mutated, so a refused vote leaves no trace.
  const expression = decodeVoteData(tx.data);
  let key = null;
  if (expression) {
    assertVoteShape(tx, expression);
    key = voteKey(tx.from, expression.pollId);
    if (state.hasVoteKey(key)) {
      throw new Error(`${tx.from} has already expressed on poll ${expression.pollId}`);
    }
  }

  // ---------------------------------------------------------------- tokens
  // Both shapes are checked BEFORE anything is mutated, so a refused
  // transaction leaves no trace in state.
  const creation = decodeTokenCreate(tx.data);
  let record = null;
  if (creation) {
    if (tx.value !== 0n) throw new Error('creating a token moves no value');
    // createdAt is the block height, supplied by the caller; the id derives
    // from it, so the same record proposed in two different blocks is two
    // different tokens rather than a collision.
    record = normalizeTokenRecord(creation, tx.from, blockNumber ?? 0n);
    if (state.getToken(record.id)) {
      throw new Error(`token ${record.id} already exists`);
    }
  }

  // An issuance: creator → holder, one-directional. This is NOT a transfer.
  // A holder cannot pass a unit on, so no secondary market can form and no
  // price exists - which is the property the whole electoral position rests
  // on. Refusing it here, before any mutation, keeps a rejected issuance from
  // leaving a trace.
  const issue = decodeIssue(tx.data);
  let issued = null;
  if (issue) {
    if (tx.value !== 0n) throw new Error('an issuance moves no value');
    if (!tx.to) throw new Error('an issuance needs a recipient');
    const token = state.getToken(issue.tokenId);
    if (!token) throw new Error(`unknown token ${issue.tokenId}`);
    if (!token.issuable) throw new Error(`token ${token.id} is not issuable`);
    if (tx.from !== token.creator) {
      throw new Error(
        'only the creator may issue: issuance is one-directional, so a holder '
        + 'passing units on would be a transfer by another name');
    }
    if (issue.amount <= 0n) throw new Error('an issuance must be positive');
    const max = BigInt(token.maxSupply);
    if (max > 0n && BigInt(token.minted) + issue.amount > max) {
      throw new Error(`issuing ${issue.amount} would exceed the declared max supply ${max}`);
    }
    issued = { token, to: tx.to, amount: issue.amount };
  }

  // A transfer: holder → holder, and the ONE place the transferable flag
  // stops being a description and becomes a rule. A token that did not declare
  // itself transferable cannot move, however its holder asks.
  const transfer = decodeTransfer(tx.data);
  let moved = null;
  if (transfer) {
    if (tx.value !== 0n) throw new Error('a token transfer moves no MOLI');
    if (!tx.to) throw new Error('a transfer needs a recipient');
    const token = state.getToken(transfer.tokenId);
    if (!token) throw new Error(`unknown token ${transfer.tokenId}`);
    if (!token.transferable) {
      throw new Error(
        `token ${token.id} is not transferable: it has no market and no price, `
        + 'which is the property it was created to have');
    }
    if (transfer.amount <= 0n) throw new Error('a transfer must be positive');
    if (state.tokenBalanceOf(token.id, tx.from) < transfer.amount) {
      throw new Error('insufficient token balance');
    }
    moved = { token, to: tx.to, amount: transfer.amount };
  }

  const express = decodeExpress(tx.data);
  let expressed = null;
  let burnAmount = 0n;
  if (express) {
    if (tx.value !== 0n) throw new Error('an expression carries no value');
    if (!tx.to || tx.to !== tx.from) {
      throw new Error('an expression must be self-addressed');
    }
    const token = state.getToken(express.tokenId);
    if (!token) throw new Error(`unknown token ${express.tokenId}`);
    // What it costs is on the record, in wei granularity - not a hardcoded
    // whole unit. Fixed for every mode but `weighted`, where the amount IS
    // the weight.
    burnAmount = expressionBurn(token, express.amount);
    if (state.tokenBalanceOf(token.id, tx.from) < burnAmount) {
      throw new Error('no units of this token to spend');
    }
    // The scope IS the rule. `quantum` keys to the voting place, so a wallet
    // expresses once per question and remains free in every other question.
    const scope = token.voteMode === 'quantum' ? express.pollId : token.id;
    const key = expressionKey(tx.from, scope);
    if (token.voteMode === 'quantum') {
      if (state.hasVoteKey(key)) {
        throw new Error(
          `${tx.from} has already expressed in voting place ${express.pollId}`);
      }
    } else if (token.voteMode === 'single') {
      // One expression per wallet, however much of the token it holds.
      if (state.hasVoteKey(key)) {
        throw new Error(`${tx.from} has already expressed on token ${token.id}`);
      }
    } else if (token.voteMode === 'capped') {
      if (state.expressionCount(key) >= BigInt(token.cap)) {
        throw new Error(`cap of ${token.cap} expressions reached for ${tx.from}`);
      }
    }
    // `weighted` has no per-wallet limit by design - weight is whatever the
    // holder burns. It is plutocratic by construction and labelled so.
    expressed = { token, key, amount: burnAmount };
  }

  // ------------------------------------------------------------ credentials
  // Both are checked BEFORE anything is mutated, so a refused credential
  // leaves no trace - the same discipline every path above follows.
  const opening = decodePollOpen(tx.data);
  if (opening) {
    if (tx.value !== 0n) throw new Error('opening a voting place moves no value');
    assertPollOpenShape(opening);
    if (state.getPlace(opening.pollId)) {
      throw new Error(`voting place ${opening.pollId} is already open`);
    }
  }

  const credential = decodeCredentialExpress(tx.data);
  let spent = null;
  if (credential) {
    assertCredentialShape(tx);
    const place = state.getPlace(credential.pollId);
    if (!place) throw new Error(`no voting place ${credential.pollId}`);
    // ⛔ Verified against THAT PLACE's key. A credential for one place is
    // arithmetically useless in another, which is what makes a per-place
    // quota enforceable at all.
    if (!credentialIsValid(credential, place)) {
      throw new Error('credential signature does not verify for this place');
    }
    const key = serialKey(credential.pollId, credential.serial);
    // ⛔⛔ Keyed on the serial, NOT on tx.from. Putting the wallet in this key
    // would link the credential to the spender and destroy the unlinkability
    // the blind signature was bought for - while leaving this very check
    // still passing. See the note at the top of credential.js.
    if (state.hasSpentSerial(key)) {
      throw new Error(`credential ${credential.serial} has already been spent`);
    }
    spent = key;
  }

  // ------------------------------------------------------------------ EVM
  //
  // A transaction reaches the EVM only when it is NOT one of Molibra's own
  // typed payloads. Every decoder above has already run, so `native` is the
  // authoritative answer to "did the validator claim this?" - the ordering is
  // the disambiguation rule, and it must stay that way. A contract call and a
  // vote both live in `data`; if a contract could claim a vote payload, or a
  // vote could be routed to bytecode, the electoral rules would be optional.
  const native = Boolean(expression || creation || issue || moved || express
    || opening || credential);
  const isCreate = !native && !tx.to && dataBytes(tx).length > 0;
  const isCall = !native && tx.to && state.hasCode(tx.to);

  let evm = null;
  if (isCreate || isCall) {
    // Execution gas is what is left after the intrinsic cost, exactly as on
    // Ethereum. The sender must be able to cover the WHOLE limit up front,
    // because how much will actually burn is not knowable until it has.
    const maxFee = tx.gasLimit * tx.gasPrice;
    if (state.balanceOf(tx.from) < maxFee + tx.value) {
      throw new Error(`insufficient funds for gas + value: ${tx.from} needs ${maxFee + tx.value}`);
    }
    evm = await runEvm(state, {
      from: tx.from,
      to: isCreate ? null : tx.to,
      value: tx.value,
      data: dataBytes(tx),
      gasLimit: tx.gasLimit - intrinsicGas,
      chainId, blockNumber, timestamp, coinbase: miner, gasPrice: tx.gasPrice,
    });
  }

  if (evm) {
    // The EVM has already moved `value` itself, so the fee is all that is
    // taken here. Debiting the value again would spend it twice.
    const spent = intrinsicGas + evm.gasUsed;
    state.debit(tx.from, spent * tx.gasPrice);
    state.credit(miner, spent * tx.gasPrice);
  } else {
    state.debit(tx.from, total);
    if (tx.to) state.credit(tx.to, tx.value);
    else state.credit(tx.from, tx.value); // a bare value-to-nobody is returned
    state.credit(miner, fee);
  }
  state.bumpNonce(tx.from);
  if (key) state.recordVoteKey(key);

  if (opening) {
    state.openPlace(opening.pollId, {
      opener: tx.from, n: opening.n, e: opening.e, openedAt: blockNumber,
    });
  }
  if (spent) state.spendSerial(spent);

  if (record) {
    // Only the declared initial supply exists at creation - which for a
    // question board is normally none at all. Units reach people by ISSUE,
    // the single mint path, so a token with a declared `maxSupply` cannot
    // exceed it and an uncapped one grows only by an act the creator signs.
    state.putToken(record);
    if (BigInt(record.initialSupply) > 0n) {
      state.setTokenBalance(record.id, record.creator, BigInt(record.initialSupply));
    }
  }

  if (issued) {
    state.mintToken(issued.token.id, issued.to, issued.amount);
  }

  if (moved) {
    state.moveToken(moved.token.id, tx.from, moved.to, moved.amount);
  }

  if (expressed) {
    // Burn, do not transfer: the units are destroyed, so they cannot be
    // replayed and `minted - remaining` is what anyone can verify.
    state.burnToken(expressed.token.id, tx.from, expressed.amount);
    if (expressed.token.voteMode === 'single'
        || expressed.token.voteMode === 'quantum') {
      state.recordVoteKey(expressed.key);
    } else {
      state.bumpExpressionCount(expressed.key);
    }
  }

  return {
    gasUsed: evm ? intrinsicGas + evm.gasUsed : intrinsicGas,
    // A failed contract call is a MINED transaction with status 0, not a
    // rejected one: the gas was spent and the nonce consumed, so the block
    // must record it. Only the native paths above throw.
    status: evm && evm.failed ? 0 : 1,
    contractAddress: evm?.createdAddress ?? null,
    logs: evm?.logs ?? [],
    returnValue: evm ? toHex(evm.returnValue) : null,
    evmError: evm?.error ?? null,
    voteKey: key ?? expressed?.key ?? null,
    placeOpened: opening?.pollId ?? null,
    credentialSerial: credential?.serial ?? null,
    pollId: expression?.pollId ?? null,
    tokenId: record?.id ?? expressed?.token.id ?? issued?.token.id ?? moved?.token.id ?? null,
    tokenAmount: expressed ? expressed.amount.toString()
      : (issued ? issued.amount.toString()
        : (moved ? moved.amount.toString() : null)),
  };
}
