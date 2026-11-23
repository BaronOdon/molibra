/**
 * Orphaned-work self-scan (23 Nov 2026).
 *
 * A node already stores every block it ever saw - canonical AND orphan - in
 * chain.json. So it can value the orphaned work and record what each miner is
 * owed WITHOUT waiting for anyone to submit a claim: it simply reads its own
 * store. This is the scheduled complement to the POST /molibra/recover-claim
 * route - the route catches orphans a node never saw; this catches everything
 * the node already has.
 *
 * It reuses the exact same valuation as the claim route (valueRecoveryClaim)
 * and folds the result into the same durable ledger (RecoveryLedger), so a
 * block hash is still credited at most once ever and an address is still capped
 * at MAX_RECOVERY_WEI. Running it repeatedly is safe and additive: new orphans
 * accrue, already-credited hashes are ignored, and paid balances are untouched.
 *
 * It MOVES NO MONEY. Payout stays the separate, human-reviewed
 * installers/recover-tool.mjs step.
 *
 *   node installers/recover-scan.mjs --chain <datadir>/chain.json
 *        [--ledger <datadir>/recover-claims.json]   (defaults next to chain)
 *        [--genesis <path>]                          (defaults ./genesis.json)
 *        [--chunk 90000]                             (claim-size the valuer caps at 100k)
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Chain } from '../src/chain.js';
import { valueRecoveryClaim, RecoveryLedger, MAX_RECOVERY_WEI } from '../src/recover.js';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const lower = (h) => String(h).toLowerCase();
const MOLI = (w) => (Number(BigInt(w) / 10n ** 14n) / 1e4).toFixed(4);

const chainFile = arg('chain');
if (!chainFile || !existsSync(chainFile)) {
  console.error('need --chain <path to chain.json> (not found)');
  process.exit(1);
}
const ledgerFile = arg('ledger', join(dirname(chainFile), 'recover-claims.json'));
const genesisPath = arg('genesis', join(process.cwd(), 'genesis.json'));
const CHUNK = Number(arg('chunk', '90000'));

const genesis = Chain.loadGenesis(genesisPath);
const persisted = JSON.parse(readFileSync(chainFile, 'utf8'));

// Build the read-only chain view valueRecoveryClaim needs, straight from the store.
const byHash = new Map();
for (const b of persisted.blocks) byHash.set(lower(b.hash), b);
const canonSet = new Set();
const canonByNum = new Map();
let cur = lower(persisted.head);
let tip = 0;
while (byHash.has(cur)) {
  const b = byHash.get(cur);
  canonSet.add(cur);
  canonByNum.set(Number(b.header.number), b);
  tip = Math.max(tip, Number(b.header.number));
  cur = lower(b.header.parentHash);
}
const headBlock = byHash.get(lower(persisted.head));
const chain = {
  genesis,
  head: headBlock,
  chainFile,
  blockByHash: (h) => byHash.get(lower(h)) ?? null,
  isCanonical: (h) => canonSet.has(lower(h)),
  blockByNumber: (n) => canonByNum.get(Number(n)) ?? null,
};

const orphans = persisted.blocks.filter((b) => !canonSet.has(lower(b.hash)));
orphans.sort((a, b) => Number(a.header.number) - Number(b.header.number));
console.log(`chain tip ${tip}  known ${persisted.blocks.length}  canonical ${canonSet.size}  orphan ${orphans.length}`);

const ledger = new RecoveryLedger(ledgerFile);
const skipTotal = { canonical: 0, badSeal: 0, noParent: 0, badHeight: 0, dupInClaim: 0 };
let accepted = 0;
const addedByAddr = new Map();
for (let i = 0; i < orphans.length; i += CHUNK) {
  const valued = valueRecoveryClaim(chain, orphans.slice(i, i + CHUNK));
  accepted += valued.accepted;
  for (const k in skipTotal) skipTotal[k] += valued.skipped[k] || 0;
  const recorded = ledger.record(valued.perAddress); // folds in; new hashes only
  for (const [addr, r] of Object.entries(recorded)) {
    addedByAddr.set(addr, (addedByAddr.get(addr) || 0) + r.added);
  }
}

console.log(`valued ${accepted} orphan block(s); skipped ${JSON.stringify(skipTotal)}`);
const unpaid = ledger.unpaid();
let total = 0n;
console.log('=== ledger: address  owed  (newly credited this run) ===');
for (const row of unpaid.sort((a, b) => (BigInt(b.dueWei) > BigInt(a.dueWei) ? 1 : -1))) {
  total += BigInt(row.dueWei);
  const capped = BigInt(row.owedWei) >= MAX_RECOVERY_WEI ? ' [AT 10k CAP]' : '';
  console.log(`${row.address}  ${MOLI(row.dueWei).padStart(12)} MOLI  (+${addedByAddr.get(row.address) || 0})${capped}`);
}
console.log(`\n${unpaid.length} address(es) owed; total due ${MOLI(total)} MOLI`);
console.log(`ledger written: ${ledgerFile}`);
