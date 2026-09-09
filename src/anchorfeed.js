/**
 * Molibra - reading Ethereum anchors into the AnchorStore.
 *
 * `src/anchor.js` is deliberately network-free: it holds anchors and answers
 * "may history change here?". This file is the other half - the part that
 * actually reads Ethereum - kept separate so the rule stays testable without a
 * network, and so a node that cannot reach Ethereum degrades in one obvious
 * place rather than everywhere.
 *
 * ## ⛔⛔ Why this file is the difference between built and binding
 *
 * The anchored floor refuses any reorg below a height Ethereum has attested to,
 * at ANY depth and against ANY amount of work. On a chain this small that is
 * the only defence that changes the argument from "who has more hash power".
 * But `chain.anchors` is null unless something fills it, and until this file
 * existed nothing did. The rule was written, tested, and never fed.
 *
 * ## ⛔ Failure is loud and it does not fabricate
 *
 * If Ethereum cannot be read, the store simply stops advancing: the floor holds
 * where it was and the depth bound still applies. It NEVER assumes an anchor it
 * has not seen, and it never advances `setEthereumHead` past what the node
 * actually read. A floor invented from a failed fetch would be worse than none,
 * because it would be believed.
 */

import { keccak256, toHex } from './crypto.js';

const sel = (sig) => toHex(keccak256(new TextEncoder().encode(sig))).slice(0, 10);
const word = (v) => BigInt(v).toString(16).padStart(64, '0');

/** The three public getters this needs. All plain eth_call - no archive node. */
const SEL = {
  anchorCount: sel('anchorCount()'),
  heights: sel('heights(uint256)'),
  anchors: sel('anchors(uint256)'),
};

export class AnchorFeed {
  /**
   * @param {object} o
   * @param {string} o.rpcUrl        an Ethereum JSON-RPC endpoint
   * @param {string} o.contract      MolibraAnchor's address
   * @param {import('./anchor.js').AnchorStore} o.store
   * @param {number} [o.intervalMs]  how often to poll
   */
  constructor({ rpcUrl, contract, store, intervalMs = 60000 }) {
    this.rpcUrl = rpcUrl.replace(/\/$/, '');
    this.contract = contract.toLowerCase();
    this.store = store;
    this.intervalMs = intervalMs;
    this.ingested = 0n;        // how many of the contract's anchors are held
    this.timer = null;
    this.lastError = null;
    this.anchorsSeen = 0;
  }

  async rpc(method, params) {
    const r = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
    return j.result;
  }

  /**
   * One pass: read the Ethereum head, then the contract's anchor list.
   *
   * ⛔⛔ Reads STATE, not events. eth_getLogs over any useful history is an
   * archive request, and public RPCs refuse it - "Archive requests require a
   * personal token". Anchoring would then only work for an operator paying for
   * an archive node, which is precisely the operator least in need of a floor.
   * MolibraAnchor keeps `heights[]` and `anchors[height]` as public state, so
   * the same facts are readable with plain eth_call from any endpoint.
   *
   * ⛔ The head is set only AFTER the anchors are in. Setting it first would let
   * a read fail while the store believed Ethereum had moved on - which is how
   * an anchor becomes "confirmed" without ever having been read.
   */
  async poll() {
    const head = BigInt(await this.rpc('eth_blockNumber', []));
    const count = BigInt(await this.callUint(SEL.anchorCount));

    // Anchors only ever append, so anything already held can be skipped.
    for (let i = this.ingested; i < count; i++) {
      const height = BigInt(await this.callUint(SEL.heights + word(i)));
      const raw = await this.call(SEL.anchors + word(height));
      const w = String(raw).replace(/^0x/, '').match(/.{64}/g) ?? [];
      if (w.length < 4) continue;
      try {
        const added = this.store.add({
          height,
          blockHash: '0x' + w[0],
          cumulativeWork: BigInt('0x' + w[1]),
          ethBlock: BigInt('0x' + w[2]),
          publisher: '0x' + w[3].slice(24),
        });
        if (added?.added) this.anchorsSeen++;
        // ⛔ An equivocation is not a parse error and must not be swallowed: a
        //    bonded publisher attested two different things at one height.
        if (added?.fault) {
          console.warn(`[molibra] ANCHOR EQUIVOCATION at height ${height}:`,
            JSON.stringify(added.fault).slice(0, 200));
        }
      } catch (error) {
        console.warn(`[molibra] unreadable anchor at index ${i}: ${error.message}`);
      }
      this.ingested = i + 1n;
    }

    this.store.setEthereumHead(head);
    this.lastError = null;
    return { head, anchors: Number(count), anchorsSeen: this.anchorsSeen };
  }

  async call(data) {
    return this.rpc('eth_call', [{ to: this.contract, data }, 'latest']);
  }

  async callUint(data) {
    const v = await this.call(data);
    return v && v !== '0x' ? BigInt(v) : 0n;
  }

  start() {
    const tick = () => this.poll().catch((error) => {
      // ⛔ Loud, and then carry on. The floor stays where it was; it never
      //    advances on a guess.
      this.lastError = error.message;
      console.warn(`[molibra] anchor feed: ${error.message}`);
    });
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
