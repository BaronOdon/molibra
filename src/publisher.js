/**
 * Molibra - the credential publisher.
 *
 * The publisher holds one RSA key per voting place, and blind-signs credential
 * requests against a per-(account, place) quota. It is the OFF-CHAIN half of
 * blind credentials; the chain half is `credential.js`.
 *
 * ## ⛔⛔ What the publisher can and cannot see - the whole design
 *
 * It sees: WHICH ACCOUNT asked for a credential, for WHICH PLACE, and HOW
 * MANY it has asked for. That is exactly enough to enforce a quota, and it is
 * the reason a quota is enforceable at all.
 *
 * It does not see: the SERIAL. The value it signs is blinded, and the finished
 * credential is unblinded by the client afterwards, so nothing the publisher
 * ever held appears on the chain. It therefore cannot link an expression back
 * to the account that requested the credential.
 *
 * The quota ledger below deliberately stores a COUNT and nothing else. Storing
 * the blinded values, or the timestamps of each request, would quietly rebuild
 * the link the blinding was there to break - a request log and a chain of
 * expressions can be correlated by ordering alone. Keep it a count.
 *
 * ## ⛔ Unlinkability, not coercion resistance
 *
 * Stated again here because this is the file where somebody would be tempted
 * to claim otherwise: the holder still knows their own serial and can prove to
 * a buyer that it was theirs. This scheme breaks the PUBLISHER's link, not the
 * holder's ability to testify against themselves.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  generateCredentialKey, publicParams, signBlinded,
} from './blind.js';
import { encodePollOpen } from './credential.js';
import { toPollId } from './vote.js';
import { normalizeAddress } from './crypto.js';

export class Publisher {
  /**
   * @param {object}  options
   * @param {number}  options.quota      credentials per account, per place
   * @param {string?} options.stateFile  where the quota counts and keys live
   */
  constructor({ quota = 1, stateFile = null } = {}) {
    if (!Number.isInteger(quota) || quota < 1) {
      throw new Error('a quota must be a positive whole number of credentials');
    }
    this.quota = quota;
    this.stateFile = stateFile;
    /** pollId -> { privateKeyPem, publicKeyPem } */
    this.keys = new Map();
    /** `${pollId}:${account}` -> count. A COUNT, deliberately - see the note above. */
    this.issued = new Map();
    this.load();
  }

  /* --------------------------------------------------------- persistence */

  load() {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    const saved = JSON.parse(readFileSync(this.stateFile, 'utf8'));
    for (const [id, k] of Object.entries(saved.keys ?? {})) this.keys.set(id, k);
    for (const [k, v] of Object.entries(saved.issued ?? {})) this.issued.set(k, Number(v));
  }

  save() {
    if (!this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify({
      keys: Object.fromEntries(this.keys),
      issued: Object.fromEntries(this.issued),
    }, null, 2));
  }

  /* --------------------------------------------------------------- places */

  /**
   * Open a place: generate its key and return the POLL_OPEN calldata to put
   * on chain. The private key never leaves this process.
   */
  openPlace(pollId) {
    const id = toPollId(pollId);
    if (this.keys.has(id)) throw new Error(`voting place ${id} already has a key`);
    const key = generateCredentialKey();
    this.keys.set(id, key);
    this.save();
    return { pollId: id, data: encodePollOpen(id, publicParams(key.publicKeyPem)) };
  }

  /** The public parameters anybody needs to verify a credential for a place. */
  paramsFor(pollId) {
    const key = this.keys.get(toPollId(pollId));
    if (!key) throw new Error(`no key for voting place ${toPollId(pollId)}`);
    return publicParams(key.publicKeyPem);
  }

  /* ---------------------------------------------------------------- quota */

  quotaKey(pollId, account) {
    return `${toPollId(pollId)}:${normalizeAddress(account)}`;
  }

  issuedTo(pollId, account) {
    return this.issued.get(this.quotaKey(pollId, account)) ?? 0;
  }

  remainingFor(pollId, account) {
    return Math.max(0, this.quota - this.issuedTo(pollId, account));
  }

  /**
   * Blind-sign one credential request.
   *
   * ⛔ The quota is charged BEFORE signing and is not refunded on failure. A
   * publisher that refunded on error would hand an attacker an oracle: submit
   * a malformed request, watch the count not move, and learn the quota state
   * for free. It is one credential either way.
   *
   * @param {string} account  who is asking - seen, and counted
   * @param {string} pollId   which place
   * @param {bigint} blinded  the blinded value - NOT the serial, never seen
   */
  signFor(account, pollId, blinded) {
    const id = toPollId(pollId);
    const key = this.keys.get(id);
    if (!key) throw new Error(`no key for voting place ${id}`);
    if (typeof blinded !== 'bigint') throw new Error('the blinded value must be a bigint');

    const params = publicParams(key.publicKeyPem);
    // A value at or above the modulus is not a blinded message for this key;
    // refusing it here gives a clear error rather than an OpenSSL one.
    if (blinded <= 0n || blinded >= params.n) {
      throw new Error('the blinded value does not belong to this place');
    }

    const qk = this.quotaKey(id, account);
    const already = this.issued.get(qk) ?? 0;
    if (already >= this.quota) {
      throw new Error(
        `quota reached: ${account} has already been issued ${already} credential(s) for ${id}`);
    }
    this.issued.set(qk, already + 1);
    this.save();

    return signBlinded(blinded, key.privateKeyPem, params);
  }

  /**
   * What this publisher is, without revealing anything it holds.
   *
   * ⛔ Deliberately does NOT list accounts. A public endpoint that named every
   * requester would hand an observer the anonymity set for free.
   */
  describe() {
    return {
      places: [...this.keys.keys()],
      quota: this.quota,
      credentialsIssued: [...this.issued.values()].reduce((a, b) => a + b, 0),
      buys: 'unlinkability between a credential request and the expression that spends it',
      doesNotBuy: 'coercion resistance: the holder can still prove which credential was theirs',
    };
  }
}
