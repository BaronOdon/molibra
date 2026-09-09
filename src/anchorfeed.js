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

import { readFileSync } from 'node:fs';

/**
 * Reads the file `anchor-poller.mjs` writes. NO NETWORK.
 *
 * ⛔⛔ It used to poll Ethereum itself and could not: the node mines, mining
 * blocks the event loop past undici's internal connect timeout (10s, and not
 * reachable through the fetch API), so every poll died `fetch failed <-
 * ETIMEDOUT` while curl on the same host answered in 60ms. Raising
 * AbortSignal.timeout could not help - that signal never fired, undici's own
 * timer did. A node that mines cannot reliably make outbound HTTP, so it no
 * longer tries.
 */
export class AnchorFeed {
  /**
   * @param {object} o
   * @param {string} o.file    the anchors.json anchor-poller.mjs writes
   * @param {import('./anchor.js').AnchorStore} o.store
   * @param {number} [o.intervalMs]
   */
  constructor({ file, store, intervalMs = 30000 }) {
    this.file = file;
    this.store = store;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.lastError = null;
    this.anchorsSeen = 0;
    this.readAt = null;
  }

  /**
   * ⛔ A missing or unreadable file is NOT an error worth shouting about on
   * every tick - a node whose poller has not run yet is simply a node with no
   * floor, which is the honest state and the one /molibra already reports. But
   * it must never be read as "no anchors" in a way that RETRACTS a floor: the
   * store only ever accepts anchors, so a bad read leaves what is already held.
   */
  poll() {
    let doc;
    try {
      doc = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      this.lastError = error.code === 'ENOENT'
        ? 'no anchors.json yet - is anchor-poller.mjs running?'
        : error.message;
      return { read: false };
    }
    for (const raw of doc.anchors ?? []) {
      try {
        const added = this.store.add(raw);
        if (added?.added) this.anchorsSeen++;
        if (added?.fault) {
          console.warn(`[molibra] ANCHOR EQUIVOCATION at height ${raw.height}:`,
            JSON.stringify(added.fault).slice(0, 200));
        }
      } catch (error) {
        console.warn(`[molibra] unreadable anchor at height ${raw.height}: ${error.message}`);
      }
    }
    // ⛔ Only after the anchors are in, and only from what was actually read.
    if (doc.ethHead) this.store.setEthereumHead(BigInt(doc.ethHead));
    this.readAt = doc.readAt ?? null;
    this.lastError = null;
    return { read: true, anchors: (doc.anchors ?? []).length };
  }

  start() {
    const tick = () => {
      try { this.poll(); } catch (error) {
        this.lastError = error.message;
        console.warn(`[molibra] anchor feed: ${error.message}`);
      }
    };
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
