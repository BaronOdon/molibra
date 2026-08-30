/**
 * Molibra - the chalkboard issuer.
 *
 * The redesign of 30 Aug made GIZ issuable rather than transferable, which
 * fixed the dead end in consensus. This is the other half: the thing that
 * actually puts chalk in somebody's hand, because "issuable by the creator"
 * is not a distribution path until the creator is running something that
 * issues.
 *
 * The publisher pays; the speaker earns. Two ways to earn, both ending in one
 * ordinary ISSUE transaction that every node validates like any other:
 *
 *   1. **Work** - the person clicks a button on the chalk page, their browser
 *      solves a small puzzle bound to their address, and the node issues.
 *      No list, no eligibility register, no identification of anyone.
 *   2. **A linking proof** - the person has already proved control of their
 *      address to the application, so the application asks for a grant on
 *      their behalf at the push of one button before they speak.
 *
 * ⛔ The application must never do (1). Mining inside a mobile app is banned by
 * Apple 3.1.5(ii) and by Google Play outright; the app's button is (2), which
 * is not mining and moves no value the person owns. This is not a style
 * preference - shipping the puzzle inside the app breaks the store position
 * that the whole compliance argument rests on.
 *
 * ## The eligibility rule, and why it is this one
 *
 * A grant is refused while the address still holds enough to speak. That caps
 * hoarding without knowing anything about the person: you come back when you
 * have spent what you were given. Every alternative worth having - one per
 * person, one per device, one per document - requires building the register of
 * identified political participation the design exists to avoid.
 *
 * It is a speed bump, not a Sybil defence. Somebody willing to run the puzzle
 * against a thousand fresh addresses gets a thousand grants, exactly as they
 * could mine a thousand times. WHITEPAPER §8.1 says so; this file does not
 * pretend otherwise.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  privateToAddress, toChecksumAddress, toHex, fromHex, normalizeAddress,
} from './crypto.js';
import { signTransaction } from './tx.js';
import { encodeIssue } from './token.js';
import {
  newChallenge, verifyWork, DEFAULT_WORK_DIFFICULTY, workThreshold,
} from './work.js';

export class Issuer {
  constructor(node, {
    tokenId,
    privateKey = null,
    keyFile = null,
    grantExpressions = 20,
    // **Off by default, and that is a compliance decision, not a default.**
    //
    // A stipend hands the recipient MOLI, which is transferable and therefore
    // priced. Handing a priced asset to somebody for registering a political
    // preference, in an election year, is the silhouette of Res.-TSE
    // 23.610/2019 art. 29 §8º - and doc 28 §8.8 states the rule in one line:
    // the transferable coin must not touch the ballot.
    //
    // It is unnecessary as well as unwise: an expression may be signed with
    // gasPrice zero (see Chain.submitRaw), so speaking costs no MOLI at all.
    // Nothing needs to be given to anybody.
    //
    // Set it above zero ONLY for a deployment with no electoral surface, and
    // record the reason.
    gasStipend = 0n,
    difficulty = DEFAULT_WORK_DIFFICULTY,
    challengeTtlMs = 10 * 60 * 1000,
    cooldownMs = 30 * 1000,
  } = {}) {
    if (!tokenId) throw new Error('an issuer needs the token id it issues for');
    this.node = node;
    this.tokenId = String(tokenId).toLowerCase();
    this.grantExpressions = BigInt(grantExpressions);
    this.gasStipend = BigInt(gasStipend);
    this.difficulty = Number(difficulty);
    this.challengeTtlMs = challengeTtlMs;
    this.cooldownMs = cooldownMs;

    this.keyFile = keyFile ?? join(node.chain.dataDir, 'issuer.key');
    if (privateKey) {
      this.privateKey = privateKey instanceof Uint8Array ? privateKey : fromHex(privateKey);
    } else {
      if (!existsSync(this.keyFile)) {
        throw new Error(
          `no issuer key at ${this.keyFile}: the issuer signs as the token's CREATOR, `
          + 'so the key must be the creator\'s and cannot be generated here');
      }
      this.privateKey = fromHex(readFileSync(this.keyFile, 'utf8').trim());
    }
    this.address = privateToAddress(this.privateKey);

    this.challenges = new Map(); // challenge -> { address, expires }
    this.grants = new Map();     // address -> { txHash, at, via }
    this.grantsFile = join(node.chain.dataDir, 'grants.json');
    this.loadGrants();
  }

  loadGrants() {
    if (!existsSync(this.grantsFile)) return;
    for (const [address, record] of Object.entries(JSON.parse(readFileSync(this.grantsFile, 'utf8')))) {
      this.grants.set(address, record);
    }
  }

  saveGrants() {
    mkdirSync(this.node.chain.dataDir, { recursive: true });
    writeFileSync(this.grantsFile, JSON.stringify(Object.fromEntries(this.grants), null, 2), 'utf8');
  }

  get token() {
    const record = this.node.chain.state.getToken(this.tokenId);
    if (!record) throw new Error(`token ${this.tokenId} does not exist on this chain`);
    return record;
  }

  /** One grant is enough chalk for `grantExpressions` expressions. */
  get grantAmount() {
    return BigInt(this.token.expressionCost) * this.grantExpressions;
  }

  /**
   * Why an address may not receive right now, or null when it may.
   * Returned as a reason rather than a boolean so the page can say which rule
   * refused, instead of a shrug.
   */
  refusalFor(address) {
    const to = normalizeAddress(address);
    const token = this.token;
    if (!token.issuable) return `token ${token.id} is not issuable`;
    if (this.address !== token.creator) {
      return 'this node does not hold the creator key for that token, so it cannot issue';
    }
    const held = this.node.chain.state.tokenBalanceOf(token.id, to);
    if (held >= BigInt(token.expressionCost)) {
      return 'you already hold enough chalk to speak - come back when you have spent it';
    }
    const previous = this.grants.get(to);
    if (previous && Date.now() - Date.parse(previous.at) < this.cooldownMs) {
      return 'a grant to this address is still being mined - wait for it to land';
    }
    return null;
  }

  /** A fresh puzzle, bound to the address that will receive the grant. */
  challengeFor(address) {
    const to = normalizeAddress(address);
    const refusal = this.refusalFor(to);
    if (refusal) throw new Error(refusal);
    const challenge = newChallenge();
    const expires = Date.now() + this.challengeTtlMs;
    this.challenges.set(challenge, { address: to, expires });
    this.sweep();
    return {
      challenge,
      address: to,
      difficulty: this.difficulty,
      threshold: workThreshold(this.difficulty),
      expires: new Date(expires).toISOString(),
      grant: this.grantAmount.toString(),
      expressions: Number(this.grantExpressions),
    };
  }

  sweep() {
    const now = Date.now();
    for (const [challenge, entry] of this.challenges) {
      if (entry.expires < now) this.challenges.delete(challenge);
    }
  }

  /** Redeem a solved puzzle. Single-use: the challenge is consumed either way. */
  redeem({ address, challenge, nonce }) {
    const to = normalizeAddress(address);
    const entry = this.challenges.get(String(challenge));
    if (!entry) throw new Error('unknown or already-used challenge');
    this.challenges.delete(String(challenge));
    if (entry.expires < Date.now()) throw new Error('challenge has expired');
    if (entry.address !== to) throw new Error('this challenge was issued to another address');
    if (!verifyWork(challenge, to, nonce, this.difficulty)) {
      throw new Error('that nonce does not solve the challenge');
    }
    return this.issueTo(to, 'work');
  }

  /**
   * Grant against a verified linking proof - the application's one button.
   * The proof establishes control of the address; it grants nothing on its own,
   * which is why the eligibility rule is still applied here.
   */
  grantForProof(proof) {
    return this.issueTo(normalizeAddress(proof.address), 'proof');
  }

  /** The one place an ISSUE is built, so every path obeys the same rule. */
  issueTo(address, via) {
    const to = normalizeAddress(address);
    const refusal = this.refusalFor(to);
    if (refusal) throw new Error(refusal);

    const amount = this.grantAmount;
    const gasPrice = this.node.minGasPrice;
    const raw = toHex(signTransaction(
      {
        nonce: this.node.chain.pendingNonce(this.address),
        gasPrice,
        gasLimit: 120000n,
        to,
        value: 0n,
        data: encodeIssue(this.tokenId, amount),
      },
      this.privateKey,
      this.node.chain.chainId,
    ));

    const txHash = this.node.chain.submitRaw(raw);
    this.node.broadcastTransaction(raw);

    // The fare, sent only when they cannot already pay it. If the publisher
    // is out of MOLI the chalk still lands - a grant that half worked is
    // better than one that failed, and the caller is told which it was.
    let stipendTx = null;
    let stipendSkipped = null;
    const balance = this.node.chain.state.balanceOf(to);
    if (this.gasStipend > 0n && balance < this.gasStipend) {
      const short = this.gasStipend - balance;
      const fee = 21000n * gasPrice;
      if (this.node.chain.state.balanceOf(this.address) < short + fee) {
        stipendSkipped = 'the publisher is out of MOLI, so no gas was sent with the chalk';
      } else {
        const fare = toHex(signTransaction(
          {
            nonce: this.node.chain.pendingNonce(this.address),
            gasPrice,
            gasLimit: 21000n,
            to,
            value: short,
            data: '0x',
          },
          this.privateKey,
          this.node.chain.chainId,
        ));
        stipendTx = this.node.chain.submitRaw(fare);
        this.node.broadcastTransaction(fare);
      }
    }

    const record = {
      txHash, at: new Date().toISOString(), via, amount: amount.toString(),
      stipendTx, stipendSkipped,
    };
    this.grants.set(to, record);
    this.saveGrants();
    return { address: to, ...record, expressions: Number(this.grantExpressions) };
  }

  describe() {
    let token = null;
    let error = null;
    try { token = this.token; } catch (e) { error = e.message; }
    return {
      issuer: toChecksumAddress(this.address),
      tokenId: this.tokenId,
      token: token ? { title: token.title, voteMode: token.voteMode,
                       expressionCost: token.expressionCost, issuable: token.issuable } : null,
      error,
      grant: token ? this.grantAmount.toString() : null,
      gasStipend: this.gasStipend.toString(),
      expressions: Number(this.grantExpressions),
      difficulty: this.difficulty,
      grantsMade: this.grants.size,
      moliBalance: this.node.chain.state.balanceOf(this.address).toString(),
      rule: 'a grant is refused while the address still holds enough to speak',
      notMining: 'the puzzle earns GIZ; it is not block mining and does not secure the chain',
    };
  }
}
