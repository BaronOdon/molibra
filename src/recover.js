/**
 * Orphaned-work recovery (22 Nov 2026).
 *
 * Before the pool-fallback release, a miner that ticked "help the network" but
 * sat behind NAT ran a full node that could never win the canonical race: every
 * block it found was orphaned, its proof of work paid for in electricity and
 * thrown away. This module lets such a miner PROVE that work and be made whole.
 *
 * A claim is a set of block headers the miner sealed. It is self-authenticating,
 * so nothing here needs a signature and nobody can steal another's work:
 *
 *   • The credit for a block goes to that block's OWN coinbase (`header.miner`),
 *     never to whoever relayed the claim. Submitting someone else's headers only
 *     pays THEM.
 *   • The seal proves the difficulty. To claim difficulty D you must show a
 *     nonce whose keccak falls under targetFor(D) - i.e. you did ~D hashes of
 *     real work. Difficulty cannot be inflated; the proof of work is the proof.
 *   • Every block must root in the canonical chain (its parent is a canonical
 *     block, or an earlier block in the same claim that itself roots in
 *     canonical). This ties the work to real Molibra mining, not arbitrary
 *     hashing.
 *   • A block that IS on the canonical chain is skipped - it was already paid,
 *     and is never honoured twice. This is exactly how work that went canonical
 *     before node 1's shutdown is excluded.
 *
 * ⛔ Valuation is by WORK, never by block count. A block is worth the canonical
 *    reward at its height, scaled by its difficulty's share of the canonical
 *    difficulty at that height, and CAPPED at one full reward. So grinding many
 *    easy blocks earns only what their little difficulty is worth, and a single
 *    freakishly hard block earns at most one reward. Paying per block instead
 *    would reward solo-fork inflation - the opposite of honouring real effort.
 *
 * This module only computes and RECORDS what is owed. Paying it out is a
 * separate, operator-reviewed step (installers/recover-tool.mjs) so a human sees
 * every amount before any MOLI moves.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { blockHash, isValidSeal, deserializeHeader, blockRewardAt } from './block.js';

/** The most any one address can be credited across all its claims. */
export const MAX_RECOVERY_WEI = 10_000n * 10n ** 18n; // 10,000 MOLI

const lower = (h) => String(h).toLowerCase();

/**
 * Value a recovery claim against the live chain.
 *
 * @param chain  the node's Chain (needs blockByHash, isCanonical, blockByNumber, head, genesis)
 * @param serializedBlocks  array of { header: {...strings...} } as persisted by serializeBlock
 * @returns {{ perAddress: Map<string,{hashes:string[], wei:bigint}>, accepted:number, skipped:{canonical:number, badSeal:number, noParent:number, badHeight:number} }}
 */
export function valueRecoveryClaim(chain, serializedBlocks) {
  if (!Array.isArray(serializedBlocks) || serializedBlocks.length === 0) {
    throw new Error('claim carries no blocks');
  }
  if (serializedBlocks.length > 100_000) throw new Error('claim too large');

  // Parse + recompute hashes (never trust a submitted hash).
  const parsed = [];
  for (const sb of serializedBlocks) {
    if (!sb || !sb.header) throw new Error('block missing header');
    const header = deserializeHeader(sb.header);
    parsed.push({ header, hash: lower(blockHash(header)) });
  }
  // Lowest height first, so a block's in-claim parent is seen before it.
  parsed.sort((a, b) => (a.header.number < b.header.number ? -1
    : a.header.number > b.header.number ? 1 : 0));

  const inClaim = new Map(parsed.map((b) => [b.hash, b]));
  const rooted = new Set();           // hashes proven to root in canonical
  const perAddress = new Map();
  const skipped = { canonical: 0, badSeal: 0, noParent: 0, badHeight: 0, dupInClaim: 0 };
  let accepted = 0;
  const seen = new Set();

  const headDiff = BigInt(chain.head.header.difficulty);

  for (const b of parsed) {
    if (seen.has(b.hash)) { skipped.dupInClaim++; continue; }
    seen.add(b.hash);

    // Lineage: the parent is a canonical block, or an earlier claim block that
    // itself rooted in canonical. Either way the branch grows out of the real chain.
    const parentHash = lower(b.header.parentHash);
    const canonParent = chain.blockByHash(parentHash);
    let parentNumber = null;
    if (canonParent && chain.isCanonical(canonParent.hash)) {
      parentNumber = BigInt(canonParent.header.number);
    } else if (rooted.has(parentHash)) {
      parentNumber = inClaim.get(parentHash).header.number;
    } else {
      skipped.noParent++;
      continue;
    }

    if (b.header.number !== parentNumber + 1n) { skipped.badHeight++; continue; }
    if (!isValidSeal(b.header)) { skipped.badSeal++; continue; }

    rooted.add(b.hash); // its children may now root through it

    // Already canonical => already paid => never honoured twice.
    const canonAtHeight = chain.blockByNumber(Number(b.header.number));
    if (canonAtHeight && lower(canonAtHeight.hash) === b.hash) { skipped.canonical++; continue; }

    // Work value: reward at this height, scaled by difficulty's share of the
    // canonical difficulty there, capped at one reward.
    const reward = blockRewardAt(b.header.number, chain.genesis);
    const D = canonAtHeight ? BigInt(canonAtHeight.header.difficulty) : headDiff;
    const d = b.header.difficulty;
    const wei = d >= D ? reward : (reward * d) / D;

    const addr = lower(b.header.miner);
    let e = perAddress.get(addr);
    if (!e) { e = { hashes: [], wei: 0n }; perAddress.set(addr, e); }
    e.hashes.push(b.hash);
    e.wei += wei;
    accepted++;
  }

  return { perAddress, accepted, skipped };
}

/**
 * The durable ledger of what recovery each address is owed and whether it was
 * paid. One file next to the chain; a block hash is credited at most once, ever,
 * and an address is capped at MAX_RECOVERY_WEI.
 */
export class RecoveryLedger {
  constructor(file) {
    this.file = file;
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  }

  /** Fold a valued claim in. Returns { [address]: { added:number, owedWei, totalWei } }. */
  record(perAddress) {
    const out = {};
    for (const [addr, { hashes, wei }] of perAddress) {
      const row = this.data[addr] ?? { credited: {}, owedWei: '0', paidWei: '0', paidTx: [] };
      let added = 0;
      let add = 0n;
      for (let i = 0; i < hashes.length; i++) {
        if (row.credited[hashes[i]]) continue;       // a hash pays once, forever
        row.credited[hashes[i]] = true;
        added++;
      }
      // Re-value from scratch would need per-hash amounts; instead we add the
      // claim's wei for the NEW hashes only. Since valueRecoveryClaim returns the
      // whole claim, we scale by the fraction of hashes that were new.
      if (added > 0 && hashes.length > 0) add = (wei * BigInt(added)) / BigInt(hashes.length);
      let owed = BigInt(row.owedWei) + add;
      if (owed > MAX_RECOVERY_WEI) owed = MAX_RECOVERY_WEI;   // per-address cap
      row.owedWei = owed.toString();
      this.data[addr] = row;
      out[addr] = { added, owedWei: row.owedWei, totalWei: row.owedWei };
    }
    this.save();
    return out;
  }

  /** Unpaid balances (owed minus paid), for the airdrop tool. */
  unpaid() {
    const rows = [];
    for (const [addr, row] of Object.entries(this.data)) {
      const due = BigInt(row.owedWei) - BigInt(row.paidWei ?? '0');
      if (due > 0n) rows.push({ address: addr, dueWei: due.toString(), owedWei: row.owedWei, paidWei: row.paidWei ?? '0' });
    }
    return rows;
  }

  markPaid(address, wei, txHash) {
    const row = this.data[lower(address)];
    if (!row) throw new Error(`no recovery row for ${address}`);
    row.paidWei = (BigInt(row.paidWei ?? '0') + BigInt(wei)).toString();
    row.paidTx = [...(row.paidTx ?? []), txHash];
    this.save();
  }

  save() { writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
}
