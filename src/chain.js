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
  decodeTokenCreate, decodeExpress, normalizeTokenRecord, expressionKey,
} from './token.js';
import {
  ZERO_HASH, merkleRoot, blockHash, isValidSeal, mineHeader,
  nextDifficulty, serializeBlock, deserializeHeader, blockRewardAt,
} from './block.js';

export class Chain {
  constructor(genesis, dataDir) {
    this.genesis = genesis;
    this.chainId = genesis.chainId;
    this.dataDir = dataDir;

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

    const express = decodeExpress(tx.data);
    if (express) {
      if (tx.value !== 0n) throw new Error('an expression carries no value');
      if (!tx.to || tx.to !== tx.from) {
        throw new Error('an expression must be self-addressed');
      }
      const token = this.state.getToken(express.tokenId);
      if (!token) throw new Error(`unknown token ${express.tokenId}`);
      if (this.state.tokenBalanceOf(token.id, tx.from) < 1n) {
        throw new Error('no units of this token to spend');
      }
      const key = expressionKey(tx.from, token.id);
      if (token.voteMode === 'single' && this.state.hasVoteKey(key)) {
        throw new Error(`${tx.from} has already expressed on token ${token.id}`);
      }
      if (token.voteMode === 'capped'
          && this.state.expressionCount(key) >= BigInt(token.cap)) {
        throw new Error(`cap of ${token.cap} expressions reached for ${tx.from}`);
      }
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
    if (header.timestamp <= parent.header.timestamp) {
      throw new Error('timestamp does not advance past parent');
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
  processBlock(block, { persist = true } = {}) {
    if (this.byHash.has(block.hash)) return { accepted: false, adopted: false, reason: 'known' };

    const parent = this.byHash.get(block.header.parentHash);
    if (!parent) {
      // Arrived before its parent: hold it until the parent shows up.
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
      reorg = this.setHead(entry);
    }

    // The parent's arrival may unblock children that came in early.
    const children = this.orphans.get(entry.hash);
    if (children) {
      this.orphans.delete(entry.hash);
      for (const child of children) this.processBlock(child, { persist: false });
    }

    if (persist) this.persist();
    return { accepted: true, adopted: this.head.hash === entry.hash || this.isCanonical(entry.hash), reorg };
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
