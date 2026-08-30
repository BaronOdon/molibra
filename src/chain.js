/**
 * Molibra - the chain: genesis, validation, fork choice, mining, mempool.
 *
 * The chain is a tree of known blocks; the canonical chain is the heaviest path
 * through it. A block is always validated against ITS OWN PARENT's state, never
 * against whatever the node currently considers the head - that is what makes a
 * competing branch verifiable before the node decides to adopt it.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeAddress } from './crypto.js';
import { decodeTransaction, intrinsicGas } from './tx.js';
import { State, applyTransaction } from './state.js';
import { decodeVoteData, assertVoteShape, voteKey } from './vote.js';
import {
  decodeTokenCreate, decodeExpress, decodeIssue, decodeTransfer,
  normalizeTokenRecord, expressionKey, expressionBurn,
} from './token.js';
import {
  ZERO_HASH, merkleRoot, blockHash, isValidSeal, mineHeader,
  nextDifficulty, serializeBlock, deserializeHeader, blockRewardAt,
  assertHeaderBounds,
} from './block.js';
import {
  MAX_FUTURE_DRIFT_SECONDS, MAX_TRANSACTIONS_PER_BLOCK, MAX_MEMPOOL_SIZE,
  MAX_MEMPOOL_PER_SENDER, MAX_ORPHANS, MAX_ORPHAN_RESOLUTION_DEPTH,
  MAX_REORG_DEPTH,
} from './limits.js';

export class Chain {
  /**
   * `limits` overrides the LOCAL-POLICY bounds only - mempool caps, orphan
   * caps, reorg depth. The consensus bounds in src/limits.js are deliberately
   * not overridable here: a node that could be configured to accept a block
   * its peers reject is a node that forks its operator off the network by
   * config file.
   */
  constructor(genesis, dataDir, limits = {}) {
    this.genesis = genesis;
    this.chainId = genesis.chainId;
    this.dataDir = dataDir;
    this.maxReorgDepth = limits.maxReorgDepth ?? MAX_REORG_DEPTH;
    // Ethereum anchors, when a node is configured to follow them. Null means
    // "not anchoring", and the fork choice then behaves exactly as it did
    // before anchoring existed - so this is additive, never a silent rule
    // change under an operator who did not ask for one. See src/anchor.js.
    this.anchors = limits.anchors ?? null;
    this.maxMempoolSize = limits.maxMempoolSize ?? MAX_MEMPOOL_SIZE;
    this.maxMempoolPerSender = limits.maxMempoolPerSender ?? MAX_MEMPOOL_PER_SENDER;
    this.maxOrphans = limits.maxOrphans ?? MAX_ORPHANS;
    // The floor a transaction must pay to enter THIS node's mempool. Local
    // policy, not consensus - a block carrying a cheaper transaction is still
    // valid. Expressions are exempt; see submitRaw.
    this.minGasPrice = BigInt(limits.minGasPrice ?? 0n);

    this.byHash = new Map();   // every known block, canonical or not
    this.canonical = [];       // canonical blocks, index === height
    this.orphans = new Map();  // parentHash -> [serialized blocks waiting on it]
    this.mempool = new Map();  // txHash -> tx
    this.txIndex = new Map();  // txHash -> { blockNumber, index } (canonical only)
    this.receipts = new Map(); // txHash -> receipt (canonical only)
    this.state = new State();

    this.lastReorg = null;     // { depth, from, to, revertedTx } for observability
  }

  // ---------------------------------------------------------------- genesis

  static loadGenesis(path) {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return {
      chainId: Number(raw.chainId),
      name: raw.name,
      symbol: raw.symbol,
      decimals: Number(raw.decimals ?? 18),
      targetBlockSeconds: Number(raw.targetBlockSeconds ?? 15),
      minimumDifficulty: BigInt(raw.minimumDifficulty ?? 1000),
      initialDifficulty: BigInt(raw.initialDifficulty ?? raw.minimumDifficulty ?? 1000),
      blockGasLimit: BigInt(raw.blockGasLimit ?? 8000000),
      blockReward: BigInt(raw.blockReward ?? '2000000000000000000'),
      // Tail emission (decided 29 Aug 2026): halve every interval down to a
      // permanent floor. 0 disables halving and keeps the flat reward.
      rewardHalvingInterval: BigInt(raw.rewardHalvingInterval ?? 0),
      rewardFloor: BigInt(raw.rewardFloor ?? 0),
      // Fee burn is OFF and declared so, rather than left silent.
      feeBurnBasisPoints: Number(raw.feeBurnBasisPoints ?? 0),
      timestamp: BigInt(raw.timestamp ?? 0),
      extraData: raw.extraData ?? '0x',
      attribution: raw.attribution ?? null,
      theories: raw.theories ?? [],
      alloc: raw.alloc ?? {},
    };
  }

  buildGenesisBlock() {
    const state = new State();
    for (const [address, entry] of Object.entries(this.genesis.alloc)) {
      state.set(address, { balance: BigInt(entry.balance), nonce: 0n });
    }
    const header = {
      number: 0n,
      parentHash: ZERO_HASH,
      timestamp: this.genesis.timestamp,
      miner: '0x' + '00'.repeat(20),
      stateRoot: state.root(),
      txRoot: ZERO_HASH,
      difficulty: this.genesis.initialDifficulty,
      gasLimit: this.genesis.blockGasLimit,
      gasUsed: 0n,
      extraData: this.genesis.extraData,
      nonce: 0n,
    };
    return {
      header,
      hash: blockHash(header),
      transactions: [],
      state,
      totalDifficulty: header.difficulty,
    };
  }

  init() {
    const genesisBlock = this.buildGenesisBlock();
    this.byHash.set(genesisBlock.hash, genesisBlock);
    this.canonical = [genesisBlock];
    this.state = genesisBlock.state.clone();
    this.load();
    return this;
  }

  // ------------------------------------------------------------- accessors

  get head() {
    return this.canonical[this.canonical.length - 1];
  }

  get height() {
    return BigInt(this.canonical.length - 1);
  }

  get totalDifficulty() {
    return this.head.totalDifficulty;
  }

  blockByNumber(n) {
    const index = Number(n);
    return index >= 0 && index < this.canonical.length ? this.canonical[index] : null;
  }

  blockByHash(hash) {
    return this.byHash.get(String(hash).toLowerCase()) ?? null;
  }

  isCanonical(hash) {
    const block = this.blockByHash(hash);
    if (!block) return false;
    return this.blockByNumber(block.header.number)?.hash === block.hash;
  }

  transactionByHash(hash) {
    const key = String(hash).toLowerCase();
    const located = this.txIndex.get(key);
    if (located) {
      const block = this.blockByNumber(located.blockNumber);
      return { tx: block.transactions[located.index], block, index: located.index };
    }
    const pending = this.mempool.get(key);
    return pending ? { tx: pending, block: null, index: null } : null;
  }

  receiptFor(hash) {
    return this.receipts.get(String(hash).toLowerCase()) ?? null;
  }

  pendingNonce(address) {
    const from = normalizeAddress(address);
    let nonce = this.state.nonceOf(from);
    for (const tx of this.mempool.values()) {
      if (tx.from === from && tx.nonce >= nonce) nonce = tx.nonce + 1n;
    }
    return nonce;
  }

  // --------------------------------------------------------------- mempool

  submitRaw(raw) {
    const tx = decodeTransaction(raw, this.chainId);

    const included = this.txIndex.get(tx.hash);
    if (included) {
      throw new Error(`nonce too low: transaction already included in block ${included.blockNumber}`);
    }
    if (this.mempool.has(tx.hash)) return tx.hash;

    const expected = this.pendingNonce(tx.from);
    if (tx.nonce < this.state.nonceOf(tx.from)) {
      throw new Error(`nonce too low: got ${tx.nonce}, account is at ${this.state.nonceOf(tx.from)}`);
    }
    if (tx.nonce > expected) {
      throw new Error(`nonce gap: got ${tx.nonce}, next usable is ${expected}`);
    }
    const gas = intrinsicGas(tx);
    if (tx.gasLimit < gas) throw new Error(`gas limit below intrinsic gas ${gas}`);
    if (this.state.balanceOf(tx.from) < tx.value + gas * tx.gasPrice) {
      throw new Error('insufficient funds for value plus fee');
    }

    // **Speaking is free, and everything else pays.**
    //
    // An expression may set gasPrice to zero. It is not a favour: the act
    // already costs something - it burns the token's declared expressionCost -
    // so the anti-spam property the fee provides is provided twice over, and
    // charging MOLI on top would mean a person needs a transferable, priced
    // asset in hand before they can say anything.
    //
    // That is the line doc 28 §8.7-8.8 draws and the reason this exemption
    // exists rather than a stipend: handing somebody a transferable coin so
    // they can register a political preference, in an election year, is
    // exactly the shape Res.-TSE 23.610/2019 art. 29 §8º describes. The coin
    // must not touch the ballot. So it does not: nothing is handed over,
    // because nothing is needed.
    //
    // Every other transaction pays the floor, which is what keeps a free
    // transaction class from becoming a free spam class.
    if (this.minGasPrice > 0n && tx.gasPrice < this.minGasPrice && !decodeExpress(tx.data)) {
      throw new Error(
        `gas price ${tx.gasPrice} is below this node's minimum ${this.minGasPrice}`);
    }

    // An expression of will is refused at the door when the wallet has already
    // spoken on that poll, or has an unmined one waiting. This is courtesy, not
    // consensus: applyTransaction enforces the same rule when the block is
    // built and again when any node verifies it.
    const expression = decodeVoteData(tx.data);
    if (expression) {
      assertVoteShape(tx, expression);
      const key = voteKey(tx.from, expression.pollId);
      if (this.state.hasVoteKey(key)) {
        throw new Error(`${tx.from} has already expressed on poll ${expression.pollId}`);
      }
      for (const pending of this.mempool.values()) {
        if (pending.from !== tx.from) continue;
        const other = decodeVoteData(pending.data);
        if (other && voteKey(pending.from, other.pollId) === key) {
          throw new Error('an expression on this poll from this wallet is already pending');
        }
      }
    }

    // Token transactions are validated at the door too. Without this an
    // invalid creation or an over-cap expression sits in the mempool and is
    // silently skipped at composition time, which looks to the sender like
    // the network swallowed it. applyTransaction enforces the same rules
    // again when the block is built and once more on every verifying node.
    const creation = decodeTokenCreate(tx.data);
    if (creation) {
      if (tx.value !== 0n) throw new Error('creating a token moves no value');
      // The id depends on the block height, which is not known yet, so
      // validate the record's shape against the next height as a stand-in.
      normalizeTokenRecord(creation, tx.from, this.height + 1n);
    }

    const issue = decodeIssue(tx.data);
    if (issue) {
      if (tx.value !== 0n) throw new Error('an issuance moves no value');
      if (!tx.to) throw new Error('an issuance needs a recipient');
      const token = this.state.getToken(issue.tokenId);
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
    }

    const transfer = decodeTransfer(tx.data);
    if (transfer) {
      if (tx.value !== 0n) throw new Error('a token transfer moves no MOLI');
      if (!tx.to) throw new Error('a transfer needs a recipient');
      const token = this.state.getToken(transfer.tokenId);
      if (!token) throw new Error(`unknown token ${transfer.tokenId}`);
      if (!token.transferable) {
        throw new Error(
          `token ${token.id} is not transferable: it has no market and no price, `
          + 'which is the property it was created to have');
      }
      if (transfer.amount <= 0n) throw new Error('a transfer must be positive');
      if (this.state.tokenBalanceOf(token.id, tx.from) < transfer.amount) {
        throw new Error('insufficient token balance');
      }
    }

    const express = decodeExpress(tx.data);
    if (express) {
      if (tx.value !== 0n) throw new Error('an expression carries no value');
      if (!tx.to || tx.to !== tx.from) {
        throw new Error('an expression must be self-addressed');
      }
      const token = this.state.getToken(express.tokenId);
      if (!token) throw new Error(`unknown token ${express.tokenId}`);
      // One rule, shared with applyTransaction rather than restated here -
      // two copies of a consensus rule is two rules waiting to disagree.
      const burn = expressionBurn(token, express.amount);
      if (this.state.tokenBalanceOf(token.id, tx.from) < burn) {
        throw new Error('no units of this token to spend');
      }
      const scope = token.voteMode === 'quantum' ? express.pollId : token.id;
      const key = expressionKey(tx.from, scope);
      if ((token.voteMode === 'single' || token.voteMode === 'quantum')
          && this.state.hasVoteKey(key)) {
        // Word it by the scope that actually applies, so the sender is told
        // which rule refused them rather than a generic one.
        throw new Error(token.voteMode === 'quantum'
          ? `${tx.from} has already expressed in voting place ${express.pollId}`
          : `${tx.from} has already expressed on token ${token.id}`);
      }
      if (token.voteMode === 'capped'
          && this.state.expressionCount(key) >= BigInt(token.cap)) {
        throw new Error(`cap of ${token.cap} expressions reached for ${tx.from}`);
      }
    }

    // Mempool caps. Without them a funded sender - or anyone at all, since
    // admission does not require the transaction ever to be mined - grows this
    // map until the node dies. The per-sender cap matters as much as the
    // total: one address filling 5,000 slots crowds out everybody else just
    // as effectively as 5,000 addresses filling one each.
    let fromSender = 0;
    for (const pending of this.mempool.values()) {
      if (pending.from === tx.from) fromSender++;
    }
    if (fromSender >= this.maxMempoolPerSender) {
      throw new Error(`too many pending transactions from ${tx.from} (limit ${this.maxMempoolPerSender})`);
    }
    if (this.mempool.size >= this.maxMempoolSize) {
      // Full: only a transaction that pays more than the cheapest one waiting
      // gets in, and it displaces exactly that one. Paying to be included is
      // the intended way to compete for space; flooding is not.
      let cheapest = null;
      for (const pending of this.mempool.values()) {
        if (!cheapest || pending.gasPrice < cheapest.gasPrice) cheapest = pending;
      }
      if (!cheapest || tx.gasPrice <= cheapest.gasPrice) {
        throw new Error('mempool is full and this transaction does not outbid the cheapest waiting');
      }
      this.mempool.delete(cheapest.hash);
    }

    this.mempool.set(tx.hash, tx);
    return tx.hash;
  }

  // ---------------------------------------------------------------- mining

  /** Assemble a candidate on top of a given parent (defaults to the head). */
  composeBlock(miner, parent = this.head) {
    const minerAddress = normalizeAddress(miner);

    // One effective timestamp, used for BOTH the header and the difficulty.
    // Deriving them from different values is how a node ends up mining a block
    // its own validator rejects: the header carries the bumped time while the
    // difficulty was computed from the raw clock, and the verifier - which only
    // ever sees the header - recomputes a different number.
    // Blocks must strictly advance, so a fast miner (or a clock that has not
    // moved on) takes parent + 1.
    const wallClock = BigInt(Math.floor(Date.now() / 1000));
    const timestamp = wallClock > parent.header.timestamp ? wallClock : parent.header.timestamp + 1n;

    const state = parent.state.clone();

    const candidates = [...this.mempool.values()].sort((a, b) => {
      if (a.gasPrice !== b.gasPrice) return a.gasPrice > b.gasPrice ? -1 : 1;
      if (a.from !== b.from) return a.from < b.from ? -1 : 1;
      return a.nonce < b.nonce ? -1 : 1;
    });

    const included = [];
    let gasUsed = 0n;
    for (const tx of candidates) {
      const gas = intrinsicGas(tx);
      if (gasUsed + gas > this.genesis.blockGasLimit) continue;
      try {
        const receipt = applyTransaction(state, tx, gas, minerAddress, parent.header.number + 1n);
        included.push(tx);
        gasUsed += receipt.gasUsed;
      } catch {
        // not applicable in this position; a later block may take it
      }
    }
    state.credit(minerAddress, blockRewardAt(parent.header.number + 1n, this.genesis));

    const header = {
      number: parent.header.number + 1n,
      parentHash: parent.hash,
      timestamp,
      miner: minerAddress,
      stateRoot: state.root(),
      txRoot: merkleRoot(included.map((tx) => tx.hash)),
      difficulty: nextDifficulty(
        parent.header, timestamp,
        this.genesis.targetBlockSeconds, this.genesis.minimumDifficulty,
      ),
      gasLimit: this.genesis.blockGasLimit,
      gasUsed,
      extraData: '0x',
      nonce: 0n,
    };
    return { header, transactions: included };
  }

  /** Compose, seal and process. Returns the block, or null if interrupted. */
  mine(miner, options = {}) {
    const parent = options.parent ?? this.head;
    const candidate = this.composeBlock(miner, parent);
    const sealed = mineHeader(candidate.header, options);
    if (!sealed) return null;
    const block = { header: sealed, hash: blockHash(sealed), transactions: candidate.transactions };
    this.processBlock(block);
    return this.blockByHash(block.hash);
  }

  // ------------------------------------------------------------ validation

  /**
   * Fully verify a block against its parent and return the resulting entry.
   * Never mutates chain state - the caller decides whether to adopt it.
   */
  verifyAgainstParent(block, parent) {
    const header = block.header;

    if (header.number !== parent.header.number + 1n) {
      throw new Error(`bad height: got ${header.number}, parent is ${parent.header.number}`);
    }
    assertHeaderBounds(header);
    if (header.timestamp <= parent.header.timestamp) {
      throw new Error('timestamp does not advance past parent');
    }
    // The time-warp guard. Difficulty falls whenever a block claims the target
    // interval has elapsed, so an unbounded future timestamp is a free
    // difficulty reduction, repeatable every block until the chain costs
    // nothing to mine. Bounding the drift is what makes the claim cost
    // something. Two minutes is loose enough for ordinary clock skew.
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (header.timestamp > now + MAX_FUTURE_DRIFT_SECONDS) {
      throw new Error(
        `timestamp is ${header.timestamp - now}s in the future, limit is ${MAX_FUTURE_DRIFT_SECONDS}s`);
    }
    if (block.transactions.length > MAX_TRANSACTIONS_PER_BLOCK) {
      throw new Error(
        `block carries ${block.transactions.length} transactions, limit is ${MAX_TRANSACTIONS_PER_BLOCK}`);
    }
    if (header.gasUsed > header.gasLimit) {
      throw new Error('header claims more gas used than the block allows');
    }
    const expectedDifficulty = nextDifficulty(
      parent.header, header.timestamp,
      this.genesis.targetBlockSeconds, this.genesis.minimumDifficulty,
    );
    if (header.difficulty !== expectedDifficulty) {
      throw new Error(`bad difficulty: got ${header.difficulty}, expected ${expectedDifficulty}`);
    }
    if (header.gasLimit !== this.genesis.blockGasLimit) {
      throw new Error('bad gas limit');
    }
    if (blockHash(header) !== block.hash) throw new Error('block hash does not match header');
    if (!isValidSeal(header)) throw new Error('proof of work does not satisfy difficulty');
    if (merkleRoot(block.transactions.map((tx) => tx.hash)) !== header.txRoot) {
      throw new Error('transaction root mismatch');
    }

    // Re-execute against the parent's state. A peer is never trusted for state.
    const state = parent.state.clone();
    const receipts = [];
    let gasUsed = 0n;
    for (const tx of block.transactions) {
      const gas = intrinsicGas(tx);
      // Checked BEFORE executing, not after: a block whose transactions
      // overrun the gas limit is invalid, and discovering that only at the end
      // means having done all the work the attacker wanted done.
      if (gasUsed + gas > header.gasLimit) {
        throw new Error('transactions exceed the block gas limit');
      }
      const receipt = applyTransaction(state, tx, gas, header.miner, header.number);
      receipts.push(receipt);
      gasUsed += receipt.gasUsed;
    }
    state.credit(header.miner, blockRewardAt(header.number, this.genesis));

    if (gasUsed !== header.gasUsed) {
      throw new Error(`gas used mismatch: computed ${gasUsed}, header says ${header.gasUsed}`);
    }
    if (state.root() !== header.stateRoot) {
      throw new Error('state root mismatch after re-execution');
    }

    return {
      header,
      hash: block.hash,
      transactions: block.transactions,
      state,
      receipts,
      totalDifficulty: parent.totalDifficulty + header.difficulty,
    };
  }

  // ----------------------------------------------------------- fork choice

  /**
   * Take a block into the tree and re-run fork choice.
   *
   * Returns { accepted, adopted, reorg } - `adopted` means the canonical head
   * moved to this block or a descendant of it.
   */
  processBlock(block, { persist = true, depth = 0 } = {}) {
    if (this.byHash.has(block.hash)) return { accepted: false, adopted: false, reason: 'known' };

    const parent = this.byHash.get(block.header.parentHash);
    if (!parent) {
      // Arrived before its parent: hold it until the parent shows up. Bounded,
      // because an unverifiable block costs a peer nothing to send and this
      // map is the one place the node stores something it has NOT validated.
      if (this.orphanCount() >= this.maxOrphans) {
        return { accepted: false, adopted: false, reason: 'orphan pool full' };
      }
      const waiting = this.orphans.get(block.header.parentHash) ?? [];
      waiting.push(block);
      this.orphans.set(block.header.parentHash, waiting);
      return { accepted: false, adopted: false, reason: 'orphan' };
    }

    const entry = this.verifyAgainstParent(block, parent);
    this.byHash.set(entry.hash, entry);

    let reorg = null;
    // Heaviest chain wins. On an exact tie the incumbent keeps the head, so a
    // node does not flip-flop; whichever side is extended first settles it.
    if (entry.totalDifficulty > this.head.totalDifficulty) {
      // Reorg depth guard. A branch that forks further back than this is
      // refused however heavy it is - which is the defence against somebody
      // mining a deeper chain in private and replacing settled history.
      //
      // The cost is real and is stated in src/limits.js: a node offline or
      // partitioned for longer than the bound will refuse the honest heaviest
      // chain and needs a manual resync. That is the trade, taken knowingly
      // because this chain's total work is small enough to buy.
      const { ancestor } = this.pathToCanonical(entry);
      const depthBelowHead = Number(this.height - ancestor.header.number);

      // ⛔⛔ The anchored floor, checked BEFORE the depth bound.
      //
      // Below a binding Ethereum anchor, accumulated work stops being the
      // argument: rewriting that history here would require rewriting Ethereum.
      // This is the one refusal in the fork choice that no amount of difficulty
      // can buy past, and it is checked first so its reason is the one reported
      // rather than a coincidental depth failure.
      //
      // It only ever TIGHTENS what the depth bound allows - a chain with no
      // anchors behaves exactly as it did before this existed.
      if (this.anchors) {
        const verdict = this.anchors.permitsReorgFrom(ancestor.header.number);
        if (!verdict.ok) {
          this.refusedReorg = {
            at: new Date().toISOString(), depth: depthBelowHead,
            hash: entry.hash, height: Number(entry.header.number),
            anchoredFloor: verdict.floor.toString(), reason: verdict.reason,
          };
          console.warn(`[molibra] REFUSED a reorg to ${entry.hash.slice(0, 12)} - ${verdict.reason}`);
          if (persist) this.persist();
          return { accepted: true, adopted: false, reorg: null, refusedReorg: this.refusedReorg };
        }
      }

      if (depthBelowHead > this.maxReorgDepth) {
        this.refusedReorg = {
          at: new Date().toISOString(), depth: depthBelowHead,
          hash: entry.hash, height: Number(entry.header.number),
        };
        console.warn(`[molibra] REFUSED a ${depthBelowHead}-block reorg to ${entry.hash.slice(0, 12)}`
          + ` - deeper than the ${this.maxReorgDepth}-block limit. The block is kept but not adopted.`);
        if (persist) this.persist();
        return { accepted: true, adopted: false, reorg: null, refusedReorg: this.refusedReorg };
      }
      reorg = this.setHead(entry);
    }

    // The parent's arrival may unblock children that came in early. The depth
    // bound is not decoration: this recursion is driven entirely by data a
    // peer supplies, so a long enough orphan chain is a stack overflow that
    // takes the node with it.
    const children = this.orphans.get(entry.hash);
    if (children && depth < MAX_ORPHAN_RESOLUTION_DEPTH) {
      this.orphans.delete(entry.hash);
      for (const child of children) {
        this.processBlock(child, { persist: false, depth: depth + 1 });
      }
    }

    if (persist) this.persist();
    return { accepted: true, adopted: this.head.hash === entry.hash || this.isCanonical(entry.hash), reorg };
  }

  orphanCount() {
    let total = 0;
    for (const waiting of this.orphans.values()) total += waiting.length;
    return total;
  }

  /** Walk back from a block to the canonical chain, returning the branch. */
  pathToCanonical(entry) {
    const branch = [];
    let cursor = entry;
    while (cursor && !this.isCanonical(cursor.hash)) {
      branch.unshift(cursor);
      cursor = this.byHash.get(cursor.header.parentHash);
    }
    if (!cursor) throw new Error('branch does not connect to the canonical chain');
    return { ancestor: cursor, branch };
  }

  /**
   * Move the canonical head to `entry`, reorganising if it sits on a side
   * branch. Transactions dropped by the reorg go back to the mempool.
   */
  setHead(entry) {
    const { ancestor, branch } = this.pathToCanonical(entry);
    const ancestorHeight = Number(ancestor.header.number);
    const reverted = this.canonical.slice(ancestorHeight + 1);

    // Unwind the abandoned suffix.
    for (const block of reverted) {
      for (const tx of block.transactions) {
        this.txIndex.delete(tx.hash);
        this.receipts.delete(tx.hash);
      }
    }
    this.canonical = this.canonical.slice(0, ancestorHeight + 1);

    // Apply the new branch.
    for (const block of branch) {
      this.canonical.push(block);
      block.transactions.forEach((tx, index) => {
        this.mempool.delete(tx.hash);
        this.txIndex.set(tx.hash, { blockNumber: Number(block.header.number), index });
        const receipt = block.receipts[index];
        this.receipts.set(tx.hash, {
          transactionHash: tx.hash,
          transactionIndex: index,
          blockHash: block.hash,
          blockNumber: block.header.number,
          from: tx.from,
          to: tx.to,
          gasUsed: receipt.gasUsed,
          cumulativeGasUsed: receipt.gasUsed,
          effectiveGasPrice: tx.gasPrice,
          status: receipt.status,
          contractAddress: null,
          voteKey: receipt.voteKey ?? null,
          pollId: receipt.pollId ?? null,
          tokenId: receipt.tokenId ?? null,
          tokenAmount: receipt.tokenAmount ?? null,
          logs: [],
        });
      });
    }

    this.state = entry.state.clone();

    // Anything the reorg dropped and the new branch did not pick up is pending
    // again. It may no longer be applicable; composeBlock will skip it if so.
    let returned = 0;
    for (const block of reverted) {
      for (const tx of block.transactions) {
        if (!this.txIndex.has(tx.hash)) {
          this.mempool.set(tx.hash, tx);
          returned++;
        }
      }
    }

    if (reverted.length === 0) return null;
    this.lastReorg = {
      depth: reverted.length,
      applied: branch.length,
      from: reverted[reverted.length - 1].hash,
      to: entry.hash,
      commonAncestor: ancestor.hash,
      returnedToMempool: returned,
    };
    return this.lastReorg;
  }

  /** Adopt a serialized block received from a peer. */
  appendSerialized(serialized) {
    const header = deserializeHeader(serialized.header);
    const transactions = serialized.transactions.map((raw) => decodeTransaction(raw, this.chainId));
    return this.processBlock({ header, hash: blockHash(header), transactions });
  }

  // ----------------------------------------------------------- persistence

  get chainFile() {
    return join(this.dataDir, 'chain.json');
  }

  /** Persist every known block, not only the canonical ones - a side branch
   *  that is heavier tomorrow must survive a restart today. */
  persist() {
    mkdirSync(this.dataDir, { recursive: true });
    const blocks = [...this.byHash.values()]
      .filter((b) => b.header.number > 0n)
      .sort((a, b) => (a.header.number === b.header.number
        ? (a.hash < b.hash ? -1 : 1)
        : (a.header.number < b.header.number ? -1 : 1)))
      .map(serializeBlock);
    const payload = { chainId: this.chainId, head: this.head.hash, blocks };
    const temp = this.chainFile + '.tmp';
    writeFileSync(temp, JSON.stringify(payload), 'utf8');
    renameSync(temp, this.chainFile); // atomic swap; a crash never leaves a half file
  }

  load() {
    if (!existsSync(this.chainFile)) return false;
    const payload = JSON.parse(readFileSync(this.chainFile, 'utf8'));
    if (Number(payload.chainId) !== this.chainId) {
      throw new Error(`stored chain is id ${payload.chainId}, this node is ${this.chainId}`);
    }
    for (const serialized of payload.blocks) {
      try {
        this.appendSerialized(serialized);
      } catch (error) {
        throw new Error(
          `stored block #${serialized.header.number} in ${this.chainFile} is invalid under the `
          + `current rules (${error.message}). A chain written by an older build cannot be `
          + `loaded; start from a fresh --datadir or resync from a peer.`,
        );
      }
    }
    if (payload.head && this.head.hash !== payload.head) {
      // Fork choice is deterministic, so this should not happen; say so loudly
      // rather than carry on with a head nobody chose.
      console.warn(`[molibra] head after reload is ${this.head.hash}, stored head was ${payload.head}`);
    }
    return true;
  }
}
