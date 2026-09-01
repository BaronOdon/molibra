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
import { runEvm, simulate } from './evm.js';
import { decodeVoteData, assertVoteShape, voteKey } from './vote.js';
import {
  decodePollOpen, assertPollOpenShape, decodeCredentialExpress,
  assertCredentialShape, credentialIsValid, serialKey,
} from './credential.js';
import {
  decodeTokenCreate, decodeExpress, decodeIssue, decodeTransfer,
  normalizeTokenRecord, expressionKey, expressionBurn,
} from './token.js';
import {
  decodeBridgeRegister, decodeHeaderCommit, decodeBridgeClaim, decodeBridgeRelease,
  bridgeAuthority, mintCall, burnCall, isBurnCall, BRIDGE_GETTER,
} from './bridgemint.js';
import { InboundLedger } from './inbound.js';
import { decodeMoliBurn, OutboundLedger, MOLI_BURN_ACTIVATION } from './moliburn.js';
import {
  stateRoot as merkleStateRoot, proofFor, STATE_MERKLE_ACTIVATION,
} from './stateproof.js';
import { foreignAssetRecord } from './foreign.js';
import { proveBurn } from './burnproof.js';

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
    // The inbound bridge ledger: which foreign assets may exist here, how much
    // of each does, and which origin burns have been paid. It is state and not
    // a service for the same reason vote keys are: a reorg must unwind a claim
    // along with the block that made it, or a burn would be spent on a chain
    // that no longer exists. Assigned rather than passed in, so every existing
    // caller of this constructor keeps working unchanged.
    this.inbound = new InboundLedger();
    // The outbound counter: MOLI destroyed to be minted on another chain.
    // State for the same reason the inbound ledger is - a reorg must unwind
    // a burn with the block that made it, or the far side would be holding a
    // proof against a destruction this chain no longer records.
    this.outbound = new OutboundLedger();
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
    if (obj && obj.inbound) state.inbound = InboundLedger.fromJSON(obj.inbound);
    if (obj && obj.outbound) state.outbound = OutboundLedger.fromJSON(obj.outbound);
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
    // Omitted when the ledger is empty, on the same terms as everything above,
    // so a datadir written before the bridge existed round-trips unchanged.
    const inbound = this.inbound.toJSON();
    if (inbound) out.inbound = inbound;
    const outbound = this.outbound.toJSON();
    if (outbound) out.outbound = outbound;
    return out;
  }

  clone() {
    const accounts = new Map();
    for (const [address, account] of this.accounts) {
      accounts.set(address, { balance: account.balance, nonce: account.nonce });
    }
    const copy = this.cloneWith(accounts);
    // The bridge ledger is copied, not shared: a candidate block honouring a
    // burn must not consume that burn in its parent's state.
    copy.inbound = this.inbound.clone();
    copy.outbound = this.outbound.clone();
    return copy;
  }

  cloneWith(accounts) {
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
  /** Every line the state contributes, sorted and canonical. */
  rootLines() {
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
    // The bridge ledger: registered assets with their running accounting, the
    // burns already paid, and the origin headers committed. Every node must
    // agree on all three or a claim would be honoured on one node and refused
    // on another - which is the same class of disagreement as a double-spend.
    // Appended only when present, so the chain that exists today, which has no
    // bridged asset on it, hashes to exactly the root it already has.
    lines.push(...this.inbound.rootLines());
    // What has been destroyed to exist elsewhere, on the same terms.
    lines.push(...this.outbound.rootLines());
    return lines;
  }

  /**
   * The state fingerprint, by CONCATENATION.
   *
   * ⛔ This is the pre-activation computation and it must never change. Replay
   * re-derives the root of every historical block, so altering this by a byte
   * would make a node reject its own chain.
   */
  rootConcat() {
    return toHex(keccak256(new TextEncoder().encode(this.rootLines().join('\n'))));
  }

  /**
   * The state fingerprint as a MERKLE root over the same lines.
   *
   * Same inputs, different combination - which is what buys inclusion proofs.
   * See src/stateproof.js for why the construction is the one already deployed
   * in Solidity rather than a new one.
   */
  rootMerkle() {
    return merkleStateRoot(this.rootLines());
  }

  /**
   * The state root for a block at `height`.
   *
   * ⛔⛔ Height-gated, exactly as the MOLI burn is. Below the flag day the old
   * computation is used byte-for-byte, so upgraded and un-upgraded nodes agree
   * on all existing history; only crossing the height changes anything.
   *
   * ⛔ The default is deliberately the OLD form. A caller that forgets to pass
   * a height gets today's consensus, not tomorrow's - the failure mode of an
   * omitted argument must be "no change", never "silent fork".
   */
  root(height = 0n) {
    return BigInt(height) >= STATE_MERKLE_ACTIVATION ? this.rootMerkle() : this.rootConcat();
  }

  /** An inclusion proof for one state line, against `rootMerkle()`. */
  proofForLine(line) {
    const lines = this.rootLines();
    const index = lines.indexOf(line);
    if (index === -1) return null;
    return { ...proofFor(lines, index), root: merkleStateRoot(lines) };
  }
}

/**
 * Apply one transaction to the state.
 * Returns the receipt fields; throws with a reason when the transaction is
 * not applicable, so the caller can drop it from the block.
 */
export async function applyTransaction(state, tx, intrinsicGas, miner, blockNumber = 0n,
                                       { chainId = 20226n, timestamp = 0n } = {}) {
  // ⛔⛔ Nothing is ever sent FROM a bridge authority.
  //
  // Those addresses are hash images, not public-key images, so no signature
  // recovers to one and this can never fire against a real transaction. It is
  // here because the security of every bridged asset rests on that fact, and a
  // property nobody wrote down is a property nobody can check. If this ever
  // throws, keccak256 or secp256k1 is broken and the right response is to stop
  // rather than to mint.
  if (state.inbound.isAuthority(tx.from)) {
    throw new Error(
      `${tx.from} is a bridge authority: it mints only through a proved burn, and `
      + 'there is no key that could have signed this');
  }

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

  // ---------------------------------------------------------------- bridge
  //
  // Three payloads, checked here and executed below, in the order a unit of a
  // foreign asset actually comes into existence: an asset is REGISTERED, an
  // origin header is COMMITTED, and a burn under that header is CLAIMED. The
  // fourth, RELEASE, is the way back out.
  //
  // ⛔ Everything is checked before anything mutates, exactly as above, because
  // a claim that half-happened would have spent a burn without minting against
  // it - and that burn is gone on the origin chain, so there is no second try.

  const registration = decodeBridgeRegister(tx.data);
  let registering = null;
  if (registration) {
    if (tx.value !== 0n) throw new Error('registering a bridged asset moves no value');
    // foreignAssetRecord applies `mayEnterFromABridge`: an arriving token can
    // only ever be an asset, and social/purchase/electoral subject matter
    // never crosses. GIZ cannot reach this line whatever it is called.
    const record = foreignAssetRecord({
      originChainId: registration.originChainId,
      contract: registration.contract,
      symbol: registration.symbol,
      name: registration.symbol,
    });
    if (state.inbound.assets.has(record.id)) {
      throw new Error(`bridged asset ${record.id} is already registered`);
    }
    if (!state.hasCode(registration.assetContract)) {
      throw new Error('the asset contract has no code: units need somewhere to live');
    }
    // ⛔⛔ The check the whole design rests on. The contract's `bridge` is
    // immutable, set at construction, and it must be the KEYLESS address
    // derived from this asset's id. Without this, anyone could register a
    // contract that trusts their own wallet and the ledger below would be
    // faithfully accounting for units somebody mints at will.
    const authority = bridgeAuthority(record.id);
    const probe = await simulate(state, {
      from: tx.from, to: registration.assetContract,
      data: fromHex(BRIDGE_GETTER), gasLimit: 100000n,
    });
    if (probe.failed) throw new Error('the asset contract has no bridge(): it is not a BridgedAsset');
    const trusted = normalizeAddress('0x' + toHex(probe.returnValue).slice(-40));
    if (trusted !== authority) {
      throw new Error(
        `${registration.assetContract} trusts ${trusted}, not ${authority}. A bridged asset `
        + 'must trust the keyless address derived from its own id, or its supply is whatever '
        + 'the holder of that key decides.');
    }
    registering = { record, cap: registration.cap, assetContract: registration.assetContract };
  }

  const header = decodeHeaderCommit(tx.data);
  if (header) {
    if (tx.value !== 0n) throw new Error('committing a header moves no value');
    // Rehearsed on a copy so a refused commit leaves the ledger untouched.
    state.inbound.clone().commitHeader({ ...header, by: tx.from });
  }

  const claimed = decodeBridgeClaim(tx.data);
  let claiming = null;
  if (claimed) {
    if (tx.value !== 0n) throw new Error('a bridge claim moves no MOLI');
    const asset = state.inbound.get(claimed.tokenId);
    if (!asset.assetContract) throw new Error(`${asset.symbol} has no contract to mint into`);
    const receiptsRoot = state.inbound.receiptsRootFor(asset.origin.chainId, claimed.blockNumber);
    if (!receiptsRoot) {
      throw new Error(
        `no receiptsRoot is committed for chain ${asset.origin.chainId} block `
        + `${claimed.blockNumber}. A proof against a root nobody committed is a proof `
        + 'against a number the claimant chose.');
    }
    // ⛔ The burn is PROVED here - against the committed root, against THIS
    // asset's origin contract - and only then is it asked whether paying it is
    // permitted. Both, in this order, every time.
    const proved = proveBurn({
      receiptsRoot,
      txIndex: claimed.txIndex,
      proof: claimed.proof,
      contract: asset.origin.contract,
      ethTxHash: claimed.ethTxHash,
      recipient: claimed.recipient,
    });
    const { value } = state.inbound.assertClaimable({
      tokenId: asset.id, ethTxHash: proved.ethTxHash,
      amount: proved.amount, recipient: proved.recipient,
    });
    claiming = { asset, proved, value };
  }

  const releasing = decodeBridgeRelease(tx.data);
  let releasingAsset = null;
  if (releasing) {
    if (tx.value !== 0n) throw new Error('a bridge release moves no MOLI');
    const asset = state.inbound.get(releasing.tokenId);
    if (!asset.assetContract) throw new Error(`${asset.symbol} has no contract to burn from`);
    if (releasing.amount > asset.minted) {
      throw new Error(
        `cannot release ${releasing.amount}: only ${asset.minted} exists here`);
    }
    releasingAsset = asset;
  }

  // ⛔⛔ The outbound leg for MOLI ITSELF: destroy it here so it may be minted
  // there. Unlike `bridgeOut` in src/bridge.js - which moves nothing and is a
  // signed statement - this one really takes the coin out of existence, and
  // that destruction is the only thing backing a unit on the far side.
  //
  // Checked here with everything else and executed below, because a burn that
  // half-happened would either destroy MOLI the far side can never mint
  // against, or mint against MOLI that still exists here.
  // ⛔⛔ Gated by height. Below activation this decodes to null and the
  // payload takes the ordinary path - which is EXACTLY what a node running
  // the old code does with it, so the two agree until the flag day. See the
  // note on MOLI_BURN_ACTIVATION before changing this.
  const burningMoli = blockNumber >= MOLI_BURN_ACTIVATION ? decodeMoliBurn(tx.data) : null;
  if (burningMoli) {
    if (tx.value !== 0n) {
      throw new Error('a MOLI burn carries its amount in the payload, not in value');
    }
    // The fee is taken on top of the burn, so the sender must cover both. The
    // check is here, before any mutation, rather than relying on `debit` to
    // throw halfway through applying the transaction.
    if (state.balanceOf(tx.from) < total + burningMoli.amount) {
      throw new Error(
        `insufficient funds to burn: ${tx.from} needs ${total + burningMoli.amount}`);
    }
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
    || opening || credential || registration || header || claimed || releasing
    || burningMoli);

  // ⛔ A bridged asset's units are destroyed through BRIDGE_RELEASE, never by
  // calling `burn` on the contract directly.
  //
  // `burn` is public - anybody may destroy their own units - and it has to
  // stay that way, because the contract is already deployed and its bytecode
  // is immutable. But a direct burn would take units out of existence without
  // telling the ledger, and `minted` would then overstate what is there
  // forever. So the rule is enforced where it still can be: here, in
  // consensus, before the call reaches the contract.
  //
  // ⚠ Stated exactly: this stops an ACCOUNT burning directly. A contract
  // holding units could still burn its own, and the ledger would keep counting
  // them. That direction is conservative - fewer units exist than the ledger
  // believes, so the cap binds harder rather than softer - and no unit is
  // created by it. It is a discrepancy, not a hole, and it is written down
  // here rather than discovered later.
  if (!native && tx.to && isBurnCall(tx.data) && state.inbound.assetAt(tx.to)) {
    throw new Error(
      'burn a bridged asset with BRIDGE_RELEASE, not by calling burn() directly: '
      + 'a direct burn destroys units the inbound ledger would go on counting');
  }
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

  // The two bridge paths that touch the contract drive the EVM themselves,
  // rather than being routed to it by `isCall`. What differs is the SENDER,
  // and that is the entire point:
  //
  //   a claim   runs as the asset's keyless authority - the only address the
  //             contract will mint for, and an address no signature reaches
  //   a release runs as the claimant, because `burn` destroys the caller's own
  //             units and nobody else's
  //
  // ⛔ A failure here THROWS rather than mining with status 0. Every other
  // contract call is mined whatever it returned, because the gas was really
  // spent; but a claim whose mint reverted must not consume the burn, and a
  // release whose burn reverted must not lower `minted`. The ledger and the
  // contract move together or neither moves.
  if (claiming || releasingAsset) {
    const asset = claiming ? claiming.asset : releasingAsset;
    const maxFee = tx.gasLimit * tx.gasPrice;
    if (state.balanceOf(tx.from) < maxFee) {
      throw new Error(`insufficient funds for gas: ${tx.from} needs ${maxFee}`);
    }
    evm = await runEvm(state, {
      from: claiming ? asset.authority : tx.from,
      to: asset.assetContract,
      data: fromHex(claiming
        ? mintCall(claiming.proved.recipient, claiming.value)
        : burnCall(releasing.amount)),
      gasLimit: tx.gasLimit - intrinsicGas,
      chainId, blockNumber, timestamp, coinbase: miner,
      // The internal call is not charged by the EVM; the claimant is charged
      // below, on the same terms as any other transaction. Charging twice
      // would take the fee from an address that cannot hold a balance.
      gasPrice: 0n,
    });
    if (evm.failed) {
      throw new Error(claiming
        ? `the mint reverted (${evm.error}): the burn is not consumed and may be claimed again`
        : `the burn reverted (${evm.error}): nothing is released`);
    }
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

  // The ledger moves last, after the contract already did, so `minted` is
  // never ahead of the units that exist.
  if (registering) {
    state.inbound.register(registering.record, registering.cap, {
      assetContract: registering.assetContract,
      registrar: tx.from,
    });
  }
  if (header) {
    state.inbound.commitHeader({ ...header, by: tx.from });
  }
  if (claiming) {
    state.inbound.claim({
      tokenId: claiming.asset.id,
      ethTxHash: claiming.proved.ethTxHash,
      amount: claiming.value,
      recipient: claiming.proved.recipient,
    });
  }
  if (releasingAsset) {
    state.inbound.release({ tokenId: releasingAsset.id, amount: releasing.amount });
  }
  if (burningMoli) {
    // ⛔ Debited and credited to NOBODY. There is no vault address, no
    // treasury, no holding account - those are the things a bridge gets robbed
    // through. The supply of MOLI simply falls, and the counter below is what
    // the far side's totalSupply is checked against.
    state.debit(tx.from, burningMoli.amount);
    state.outbound.burn(burningMoli.recipient, burningMoli.amount);
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
    bridgeAsset: registering?.record.id ?? claiming?.asset.id ?? releasingAsset?.id ?? null,
    bridgeMinted: claiming ? claiming.value.toString() : null,
    bridgeReleased: releasingAsset ? releasing.amount.toString() : null,
    headerCommitted: header
      ? { chainId: header.originChainId.toString(), blockNumber: header.blockNumber.toString() }
      : null,
    credentialSerial: credential?.serial ?? null,
    pollId: expression?.pollId ?? null,
    tokenId: record?.id ?? expressed?.token.id ?? issued?.token.id ?? moved?.token.id ?? null,
    tokenAmount: expressed ? expressed.amount.toString()
      : (issued ? issued.amount.toString()
        : (moved ? moved.amount.toString() : null)),
  };
}
