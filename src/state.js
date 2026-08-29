/**
 * Molibra - account state.
 *
 * A plain account model: balance and nonce per address. There is no EVM in
 * v0.1, so there is no code or storage to track.
 *
 * NOTE ON stateRoot: this is a deterministic Keccak-256 over the sorted
 * account set, NOT an Ethereum Merkle-Patricia trie root. It gives every node
 * the same fingerprint for the same state (which is what consensus needs), but
 * it is not comparable with an Ethereum state root and does not support
 * trie proofs. Wallets do not check it.
 */

import { keccak256, toHex, normalizeAddress } from './crypto.js';
import { decodeVoteData, assertVoteShape, voteKey } from './vote.js';

export class State {
  constructor(accounts = new Map(), voteKeys = new Set()) {
    this.accounts = accounts;
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
    return new State(accounts, voteKeys);
  }

  toJSON() {
    const accounts = {};
    for (const address of [...this.accounts.keys()].sort()) {
      const account = this.accounts.get(address);
      accounts[address] = { balance: account.balance.toString(), nonce: account.nonce.toString() };
    }
    return { accounts, voteKeys: [...this.voteKeys].sort() };
  }

  clone() {
    const accounts = new Map();
    for (const [address, account] of this.accounts) {
      accounts.set(address, { balance: account.balance, nonce: account.nonce });
    }
    // Vote keys are copied, not shared: a candidate block built on this state
    // must not be able to write a vote back into its parent.
    return new State(accounts, new Set(this.voteKeys));
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
    return toHex(keccak256(new TextEncoder().encode(lines.join('\n'))));
  }
}

/**
 * Apply one transaction to the state.
 * Returns the receipt fields; throws with a reason when the transaction is
 * not applicable, so the caller can drop it from the block.
 */
export function applyTransaction(state, tx, intrinsicGas, miner) {
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

  state.debit(tx.from, total);
  if (tx.to) state.credit(tx.to, tx.value);
  else state.credit(tx.from, tx.value); // no contract creation in v0.1; value is returned
  state.credit(miner, fee);
  state.bumpNonce(tx.from);
  if (key) state.recordVoteKey(key);

  return { gasUsed: intrinsicGas, status: 1, voteKey: key, pollId: expression?.pollId ?? null };
}
