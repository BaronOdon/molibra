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
import { Issuer } from './issuer.js';

export class Node {
  constructor({ genesisPath, dataDir, miner = null, peers = [], minGasPrice = 1000000000n,
                limits = {} }) {
    // The node's fee floor is the chain's mempool policy; passing it in one
    // place stops the two disagreeing about what a cheap transaction is.
    this.chain = new Chain(Chain.loadGenesis(genesisPath), dataDir,
      { minGasPrice, ...limits }).init();
    this.miner = miner ? normalizeAddress(miner) : null;
    this.peers = new Set(peers.filter(Boolean));
    this.minGasPrice = BigInt(minGasPrice);
    this.miningRounds = 20000; // nonces per slice before yielding to the event loop
    this.mining = false;
    this.challenges = new Map(); // nonce -> expiry, for wallet linking proofs
    this.server = null;
    this.treasury = null;
    this.issuer = null;
    this._stopSignal = { stop: false };
  }

  enableTreasury(options = {}) {
    this.treasury = new Treasury(this, options);
    return this.treasury;
  }

  /**
   * Run the chalkboard issuer: the publisher's side of "publisher pays,
   * speaker earns". Needs the token's CREATOR key, because an ISSUE is only
   * valid from the creator - that one-directionality is what keeps GIZ
   * marketless.
   */
  enableIssuer(options = {}) {
    this.issuer = new Issuer(this, options);
    return this.issuer;
  }

  async start({ host = '127.0.0.1', port = 8545 } = {}) {
    this.server = await startRpcServer(this, { host, port });
    this.rpcUrl = `http://${host}:${port}`;
    return this;
  }

  async stop() {
    this.stopMining();
    this.stopSyncing();
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

  /**
   * ⛔⛔ Keep following the chain, forever - not once at startup.
   *
   * This exists because of a failure found by running the newcomer's own
   * scenario against a clean clone of the published repository: a joining node
   * synced 50 blocks, printed "synced 50 block(s)", and then **froze there
   * permanently** while the miner it had joined climbed past 97. Every test
   * passed the whole time. Two independent faults produced it, and both are
   * fixed here:
   *
   *   1. **Nothing ever synced again.** `syncFrom` was called once, in a loop
   *      at startup, and never afterwards.
   *   2. **Peering is one-directional.** The joiner is given `--peers`, so it
   *      knows the miner. The miner is told nothing, so its `broadcastBlock`
   *      went to an empty set and the joiner was never pushed to either.
   *
   * A node that syncs once is worse than a node that cannot sync at all: it
   * looks joined, mines on a stale view, and produces a fork nobody accepts.
   *
   * ⭐ **Pull is the primary mechanism, deliberately.** Most joining nodes are
   * behind NAT and are not reachable from the miner, so a design that depends
   * on being pushed to would work here and fail for the people who actually
   * download this. Announcing is an optimisation on top, never the mechanism.
   */
  startSyncing({ intervalMs = 10000 } = {}) {
    if (this.syncTimer || !this.peers.size) return false;
    this.syncing = false;

    const tick = async () => {
      // Never overlap. Verifying blocks re-executes their transactions, so a
      // slow catch-up must not have a second pass stacked behind it.
      if (this.syncing) return;
      this.syncing = true;
      try {
        for (const peer of this.peers) {
          try {
            const adopted = await this.syncFrom(peer);
            if (adopted) {
              console.log(`[molibra] synced ${adopted} block(s) from ${peer}`
                + ` - height ${this.chain.height}`);
            }
            // Best effort, and unimportant if it fails: it only lets the peer
            // push to us, which is latency, not correctness.
            await this.announceTo(peer).catch(() => {});
          } catch (error) {
            // A peer being unreachable is normal and must never stop the loop.
            if (!this.quietSync) {
              console.warn(`[molibra] sync from ${peer} failed: ${error.message}`);
            }
          }
        }
      } finally {
        this.syncing = false;
      }
    };

    this.syncTimer = setInterval(tick, intervalMs);
    this.syncTimer.unref?.();   // never hold the process open on this alone
    tick();
    return true;
  }

  stopSyncing() {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
  }

  /** Tell a peer where to reach us, so it can push new blocks rather than
   *  making us wait for the next poll. Harmless when it fails. */
  async announceTo(peerUrl) {
    if (!this.rpcUrl) return;
    await this.post(peerUrl.replace(/\/$/, ''), '/molibra/announce', { url: this.rpcUrl });
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

    // Walk back far enough to cover a fork, not just the gap in height, and
    // PAGE through it. The peer caps how many blocks one response may carry,
    // so a single request is not a sync - it is the first page of one. Asking
    // for a whole chain in one response was also a way to make a node build a
    // multi-megabyte JSON string on demand, which is a favour no public
    // endpoint should do a stranger.
    const beforeHead = this.chain.head.hash;
    let accepted = 0;
    let cursor = 0;
    for (let page = 0; cursor <= peerHeight && page < 10000; page++) {
      const payload = await (await fetch(`${base}/molibra/blocks?from=${cursor}&to=${peerHeight}`, {
        signal: AbortSignal.timeout(30000),
      })).json();
      if (!payload.blocks?.length) break;
      let sinceYield = 0;
      for (const serialized of payload.blocks) {
        if (Number(serialized.header.number) === 0) continue; // genesis is ours already
        if (this.chain.blockByHash(serialized.hash)) continue;
        const result = this.chain.appendSerialized(serialized);
        if (result.accepted) accepted++;
        // Yield periodically. Verifying a block re-executes every transaction
        // in it, and doing a whole page without pause means the node answers
        // nothing at all while it catches up - the same lesson as the mining
        // loop, which grinds in bounded slices for exactly this reason. A
        // node that goes silent whenever it syncs looks down to every wallet
        // pointed at it.
        if (++sinceYield >= 32) {
          sinceYield = 0;
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      const last = Number(payload.to ?? cursor);
      if (last < cursor) break; // no progress; stop rather than spin
      cursor = last + 1;
      if (!payload.truncated) break;
    }
    this.lastSyncReorg = this.chain.head.hash !== beforeHead ? this.chain.lastReorg : null;
    return accepted;
  }
}
