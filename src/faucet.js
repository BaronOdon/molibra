/**
 * Molibra - treasury and joining airdrop.
 *
 * The treasury is an ordinary account. It holds what it mined; it has no
 * protocol privileges and cannot create MOLI out of nothing. An airdrop is a
 * normal signed transfer that every node validates like any other, which is
 * the point: a distribution nobody can audit is not much of a distribution.
 *
 * A claim is gated on a linking proof, so the address receiving MOLI is one
 * whose controller signed a fresh single-use challenge. One claim per address.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  generatePrivateKey, privateToAddress, toChecksumAddress, toHex, fromHex, normalizeAddress,
} from './crypto.js';
import { signTransaction } from './tx.js';

export class Treasury {
  constructor(node, { privateKey = null, keyFile = null, claimAmount = 10n ** 18n } = {}) {
    this.node = node;
    this.claimAmount = BigInt(claimAmount);
    this.keyFile = keyFile ?? join(node.chain.dataDir, 'treasury.key');
    this.claims = new Map(); // address -> { txHash, at }
    this.claimsFile = join(node.chain.dataDir, 'claims.json');

    if (privateKey) this.privateKey = privateKey instanceof Uint8Array ? privateKey : fromHex(privateKey);
    else this.privateKey = this.loadOrCreateKey();

    this.address = privateToAddress(this.privateKey);
    this.loadClaims();
  }

  loadOrCreateKey() {
    if (existsSync(this.keyFile)) return fromHex(readFileSync(this.keyFile, 'utf8').trim());
    mkdirSync(this.node.chain.dataDir, { recursive: true });
    const key = generatePrivateKey();
    writeFileSync(this.keyFile, toHex(key), { encoding: 'utf8', mode: 0o600 });
    return key;
  }

  loadClaims() {
    if (!existsSync(this.claimsFile)) return;
    for (const [address, record] of Object.entries(JSON.parse(readFileSync(this.claimsFile, 'utf8')))) {
      this.claims.set(address, record);
    }
  }

  saveClaims() {
    writeFileSync(this.claimsFile, JSON.stringify(Object.fromEntries(this.claims), null, 2), 'utf8');
  }

  get balance() {
    return this.node.chain.state.balanceOf(this.address);
  }

  hasClaimed(address) {
    return this.claims.has(normalizeAddress(address));
  }

  /**
   * Send `amount` from the treasury to `to`. Returns the transaction hash.
   * This is a plain transfer - no special path, no minting.
   */
  send(to, amount = this.claimAmount) {
    const recipient = normalizeAddress(to);
    const value = BigInt(amount);
    const gasPrice = this.node.minGasPrice;
    const fee = 21000n * gasPrice;

    if (this.balance < value + fee) {
      throw new Error(
        `treasury holds ${this.balance} wei, needs ${value + fee} (amount plus fee). Mine more first.`,
      );
    }

    const raw = signTransaction(
      {
        nonce: this.node.chain.pendingNonce(this.address),
        gasPrice,
        gasLimit: 21000n,
        to: recipient,
        value,
        data: '0x',
      },
      this.privateKey,
      this.node.chain.chainId,
    );

    const hash = this.node.chain.submitRaw(toHex(raw));
    this.node.broadcastTransaction(toHex(raw));
    return hash;
  }

  /**
   * Claim the joining airdrop against a verified linking proof.
   * The proof establishes control of the address; this records that the
   * address has claimed, so a second attempt is refused.
   */
  claim(proof) {
    const address = normalizeAddress(proof.address);
    if (this.hasClaimed(address)) {
      const previous = this.claims.get(address);
      throw new Error(`address already claimed on ${previous.at} (${previous.txHash})`);
    }
    const txHash = this.send(address);
    this.claims.set(address, { txHash, at: new Date().toISOString(), appAccount: proof.appAccount ?? null });
    this.saveClaims();
    return { address, amount: this.claimAmount.toString(), txHash };
  }

  describe() {
    return {
      address: toChecksumAddress(this.address),
      balance: this.balance.toString(),
      claimAmount: this.claimAmount.toString(),
      claimsMade: this.claims.size,
      claimsFundable: this.claimAmount > 0n
        ? Number(this.balance / (this.claimAmount + 21000n * this.node.minGasPrice))
        : 0,
    };
  }
}
