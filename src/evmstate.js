/**
 * Molibra - the EVM's view of the state.
 *
 * @ethereumjs/evm wants a StateManager. This is that interface implemented
 * over Molibra's own State, so State stays the single thing root() hashes.
 * The EVM does not get its own trie, its own cache, or its own copy: it reads
 * and writes the same accounts, code and storage every node agrees on.
 *
 * ⛔ THIS ADAPTER IS ALSO THE WALL. It exposes accounts, code and storage and
 * nothing else. The token registry, token balances, vote keys and expression
 * counts are NOT reachable through it, so no contract - however it is written
 * - can mint a registry token, forge an expression of will, or move a unit of
 * a non-transferable one. Those semantics stay where they are enforceable: in
 * the validator, on typed transactions the consensus rules can read. A
 * contract may of course implement its own ERC-20 and do as it likes with it;
 * what it cannot do is reach into the electoral registry and pretend to be
 * one of those tokens. Keep it that way: adding a passthrough here would move
 * the compliance boundary without anyone noticing.
 */

import { Account, Address, bytesToHex as utilBytesToHex } from '@ethereumjs/util';

import { keccak256, toHex, fromHex, normalizeAddress } from './crypto.js';
import { toWord, ZERO_WORD } from './state.js';

/** keccak256 of the empty byte string - the codeHash of every plain account. */
const EMPTY_CODE_HASH = keccak256(new Uint8Array(0));

const addressToHex = (address) => normalizeAddress(
  typeof address === 'string' ? address : utilBytesToHex(address.bytes));

export class MolibraStateManager {
  /**
   * @param {import('./state.js').State} state the live state to read and write
   */
  constructor(state) {
    this.state = state;
    // checkpoint/commit/revert. A CALL that reverts must leave nothing
    // behind, so each checkpoint pushes a full clone and a revert restores
    // it. Clones are cheap here because the maps are small; if that ever
    // stops being true this is the place to make it a journal instead.
    this._checkpoints = [];
    // EIP-2200 SSTORE pricing needs the value a slot had at the START of the
    // transaction, not at the start of the current call frame.
    this.originalStorageCache = {
      _cache: new Map(),
      get: async (address, key) => {
        const k = `${addressToHex(address)}:${toWord(key)}`;
        if (!this._cacheHas(k)) {
          this._cacheSet(k, fromHex(this.state.getStorage(addressToHex(address), toWord(key))));
        }
        return this._cacheGet(k);
      },
      clear: () => { this.originalStorageCache._cache.clear(); },
    };
  }

  _cacheHas(k) { return this.originalStorageCache._cache.has(k); }
  _cacheGet(k) { return this.originalStorageCache._cache.get(k); }
  _cacheSet(k, v) { this.originalStorageCache._cache.set(k, v); }

  /* ---------------------------------------------------------- accounts */

  async getAccount(address) {
    const hex = addressToHex(address);
    const account = this.state.get(hex);
    const code = this.state.getCode(hex);
    if (account.balance === 0n && account.nonce === 0n && code.length === 0) return undefined;
    return new Account(account.nonce, account.balance, undefined, keccak256(code));
  }

  async putAccount(address, account) {
    const hex = addressToHex(address);
    if (account === undefined) return this.deleteAccount(address);
    this.state.set(hex, { balance: account.balance, nonce: account.nonce });
  }

  async deleteAccount(address) {
    const hex = addressToHex(address);
    this.state.accounts.delete(hex);
    this.state.setCode(hex, new Uint8Array(0));
    await this.clearStorage(address);
  }

  async modifyAccountFields(address, fields) {
    const hex = addressToHex(address);
    const account = this.state.get(hex);
    this.state.set(hex, {
      balance: fields.balance ?? account.balance,
      nonce: fields.nonce ?? account.nonce,
    });
    if (fields.code !== undefined) this.state.setCode(hex, fields.code);
  }

  /* ------------------------------------------------------------- code */

  async putCode(address, value) {
    this.state.setCode(addressToHex(address), value ?? new Uint8Array(0));
  }

  async getCode(address) {
    return this.state.getCode(addressToHex(address));
  }

  async getCodeSize(address) {
    return this.state.getCode(addressToHex(address)).length;
  }

  /* ---------------------------------------------------------- storage */

  async getStorage(address, key) {
    const word = this.state.getStorage(addressToHex(address), toWord(key));
    // The EVM expects the MINIMAL big-endian encoding, not a padded word:
    // a padded zero would read as a 32-byte value rather than as absent.
    return word === ZERO_WORD ? new Uint8Array(0) : trimLeadingZeros(fromHex(word));
  }

  async putStorage(address, key, value) {
    this.state.setStorage(addressToHex(address), toWord(key),
      value && value.length ? toWord(value) : 0n);
  }

  async clearStorage(address) {
    const hex = addressToHex(address);
    for (const { slot } of this.state.storageOf(hex)) this.state.setStorage(hex, slot, 0n);
  }

  /* ------------------------------------------------- checkpoint / revert */

  async checkpoint() {
    this._checkpoints.push(this.state.clone());
  }

  async commit() {
    // Keeping the current state IS the commit; drop the snapshot we no
    // longer need to roll back to.
    this._checkpoints.pop();
  }

  async revert() {
    const snapshot = this._checkpoints.pop();
    if (!snapshot) throw new Error('revert with no checkpoint');
    // Restore in place: callers (and the EVM) hold a reference to `state`,
    // so replacing the object would leave them pointing at the reverted one.
    this.state.accounts = snapshot.accounts;
    this.state.code = snapshot.code;
    this.state.storage = snapshot.storage;
    this.state.tokens = snapshot.tokens;
    this.state.tokenBalances = snapshot.tokenBalances;
    this.state.expressCounts = snapshot.expressCounts;
    this.state.voteKeys = snapshot.voteKeys;
  }

  /* --------------------------------------------------------------- roots */

  /**
   * Molibra's root is a Keccak over the sorted state, not a trie root, so
   * this is a fingerprint the EVM can compare - never a proof it can walk.
   * See the note at the top of state.js.
   */
  async getStateRoot() {
    return fromHex(this.state.root());
  }

  async setStateRoot() {
    throw new Error('Molibra state cannot be reset by root: it is not a trie');
  }

  async hasStateRoot(root) {
    return toHex(root) === this.state.root();
  }

  clearCaches() {
    this.originalStorageCache.clear();
  }

  shallowCopy() {
    return new MolibraStateManager(this.state.clone());
  }
}

/** Minimal big-endian: the EVM treats leading zeros as not part of the value. */
function trimLeadingZeros(bytes) {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  return bytes.slice(i);
}

/** An Address for @ethereumjs from any Molibra address string. */
export function toEvmAddress(hex) {
  return new Address(fromHex(normalizeAddress(hex)));
}

export { EMPTY_CODE_HASH };
