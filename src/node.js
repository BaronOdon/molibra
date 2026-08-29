/**
 * Molibra - the node: mining loop, peer replication, RPC hosting.
 *
 * Peering is deliberately plain HTTP. Anyone who can reach a node over HTTP can
 * replicate the chain and verify it independently, which is the whole point of
 * the audit surface - no bespoke wire protocol standing between the public and
 * the data.
 */

import { Chain } from './chain.js';
import { startRpcServer } from './rpc.js';
import { serializeBlock, mineHeader, blockHash } from './block.js';
import { normalizeAddress } from './crypto.js';
import { Treasury } from './faucet.js';

export class Node {
  constructor({ genesisPath, dataDir, miner = null, peers = [], minGasPrice = 1000000000n }) {
    this.chain = new Chain(Chain.loadGenesis(genesisPath), dataDir).init();
    this.miner = miner ? normalizeAddress(miner) : null;
    this.peers = new Set(peers.filter(Boolean));
    this.minGasPrice = BigInt(minGasPrice);
    this.miningRounds = 20000; // nonces per slice before yielding to the event loop
    this.mining = false;
    this.challenges = new Map(); // nonce -> expiry, for wallet linking proofs
    this.server = null;
    this.treasury = null;
    this._stopSignal = { stop: false };
  }

  enableTreasury(options = {}) {
    this.treasury = new Treasury(this, options);
    return this.treasury;
  }

  async start({ host = '127.0.0.1', port = 8545 } = {}) {
    this.server = await startRpcServer(this, { host, port });
    this.rpcUrl = `http://${host}:${port}`;
    return this;
  }

  async stop() {
    this.stopMining();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }

  // --------------------------------------------------------------- mining

  /**
   * Mine continuously. Yields to the event loop between blocks so RPC stays
   * responsive while the grind runs.
   */
  startMining(onBlock = null) {
    if (!this.miner) throw new Error('no miner address configured');
    if (this.mining) return;
    this.mining = true;
    this._stopSignal = { stop: false };

    // Grind in bounded slices, yielding between them, so RPC stays responsive
    // however high difficulty climbs. A candidate survives across slices; it is
    // rebuilt whenever the head moves under us or the mempool changes.
    let candidate = null;
    let candidateParent = null;
    let nonce = 0n;

    const loop = () => {
      if (!this.mining) return;
      try {
        if (!candidate || candidateParent !== this.chain.head.hash) {
          candidateParent = this.chain.head.hash;
          candidate = this.chain.composeBlock(this.miner);
          nonce = 0n;
        }
        this._stopSignal.nextNonce = null;
        const sealed = mineHeader(candidate.header, {
          start: nonce,
          signal: this._stopSignal,
          maxRounds: this.miningRounds,
        });
        if (sealed) {
          const block = { header: sealed, hash: blockHash(sealed), transactions: candidate.transactions };
          this.chain.processBlock(block);
          const stored = this.chain.blockByHash(block.hash);
          candidate = null;
          this.broadcastBlock(stored);
          onBlock?.(stored);
        } else if (this._stopSignal.nextNonce !== null && this._stopSignal.nextNonce !== undefined) {
          nonce = this._stopSignal.nextNonce; // slice exhausted; resume where we left off
        }
      } catch (error) {
        console.error('[molibra] mining error:', error.message);
        candidate = null;
      }
      setImmediate(loop);
    };
    setImmediate(loop);
  }

  stopMining() {
    this.mining = false;
    this._stopSignal.stop = true;
  }

  /** Mine exactly n blocks synchronously. Used by tests and the CLI. */
  mineBlocks(count, onBlock = null) {
    if (!this.miner) throw new Error('no miner address configured');
    const mined = [];
    for (let i = 0; i < count; i++) {
      const block = this.chain.mine(this.miner);
      mined.push(block);
      onBlock?.(block);
    }
    return mined;
  }

  // ---------------------------------------------------------------- peers

  addPeer(url) {
    this.peers.add(url.replace(/\/$/, ''));
  }

  async post(url, path, body) {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return response.json();
  }

  broadcastBlock(block) {
    const payload = { block: serializeBlock(block) };
    for (const peer of this.peers) {
      this.post(peer, '/molibra/submit-block', payload).catch(() => {
        /* a peer being down is not this node's problem */
      });
    }
  }

  broadcastTransaction(raw) {
    for (const peer of this.peers) {
      this.post(peer, '/molibra/submit-tx', { raw }).catch(() => {});
    }
  }

  /**
   * Take a block pushed by a peer. Every block goes into the tree, including
   * one at or below our current height - that is exactly the block a competing
   * branch is made of. Chain.processBlock validates it and re-runs fork choice.
   */
  acceptPeerBlock(serialized) {
    const before = this.chain.head.hash;
    const result = this.chain.appendSerialized(serialized);
    if (result.reorg) {
      console.log(`[molibra] reorg depth ${result.reorg.depth}: ${before.slice(0, 10)} -> ${this.chain.head.hash.slice(0, 10)}`);
    }
    return result;
  }

  /**
   * Pull a peer's blocks and verify each one. Blocks we already have are
   * skipped by hash, not by height, so a fork is fetched rather than ignored.
   * Returns how many new blocks entered the tree.
   */
  async syncFrom(peerUrl) {
    const base = peerUrl.replace(/\/$/, '');
    const head = await (await fetch(base + '/molibra/head', { signal: AbortSignal.timeout(5000) })).json();
    const peerHeight = Number(head.header.number);

    // Walk back far enough to cover a fork, not just the gap in height.
    const from = 0;
    const payload = await (await fetch(`${base}/molibra/blocks?from=${from}&to=${peerHeight}`, {
      signal: AbortSignal.timeout(30000),
    })).json();

    const beforeHead = this.chain.head.hash;
    let accepted = 0;
    for (const serialized of payload.blocks) {
      if (Number(serialized.header.number) === 0) continue; // genesis is ours already
      if (this.chain.blockByHash(serialized.hash)) continue;
      const result = this.chain.appendSerialized(serialized);
      if (result.accepted) accepted++;
    }
    this.lastSyncReorg = this.chain.head.hash !== beforeHead ? this.chain.lastReorg : null;
    return accepted;
  }
}
