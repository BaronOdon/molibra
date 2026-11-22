/**
 * Orphaned-work recovery (22 Nov 2026).
 *
 * A miner behind NAT that lost every canonical race can prove its orphaned work
 * and be made whole. This checks the trust-critical parts:
 *   - a valid orphan (rooted in canonical, real seal, not canonical) is credited
 *     to its OWN coinbase, valued by WORK (difficulty), not by block count;
 *   - a block that is canonical is skipped (never honoured twice);
 *   - a tampered seal is rejected; a block with no canonical root is rejected;
 *   - the ledger credits a hash once (replay), and caps an address at 10k MOLI.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mineHeader, blockHash } from '../src/block.js';
import { valueRecoveryClaim, RecoveryLedger, MAX_RECOVERY_WEI } from '../src/recover.js';

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`FAIL  ${label} ${detail}`); }
}

const genesis = { blockReward: '2000000000000000000', rewardHalvingInterval: '2102400', rewardFloor: '250000000000000000' };
const A = '0x' + '11'.repeat(20);   // miner A
const B = '0x' + '22'.repeat(20);   // miner B
const Z = '0x' + '00'.repeat(32);

function hdr(number, parentHash, difficulty, miner, ts) {
  return { number: BigInt(number), parentHash, timestamp: BigInt(ts), miner,
    stateRoot: Z, txRoot: Z, difficulty: BigInt(difficulty), gasLimit: 8000000n,
    gasUsed: 0n, extraData: '0x', nonce: 0n };
}
const mine = (h) => mineHeader(h, {});       // grind a valid nonce (low difficulty = fast)
const ser = (h) => ({ header: {
  number: h.number.toString(), parentHash: h.parentHash, timestamp: h.timestamp.toString(),
  miner: h.miner, stateRoot: h.stateRoot, txRoot: h.txRoot, difficulty: h.difficulty.toString(),
  gasLimit: h.gasLimit.toString(), gasUsed: h.gasUsed.toString(), extraData: h.extraData,
  nonce: h.nonce.toString() } });

// --- build a tiny canonical chain, each block really sealed ---
const CD = 4000n;                 // canonical difficulty
const canon = [];
let parent = { hash: '0x' + 'ab'.repeat(32), header: { number: 0n, difficulty: CD } };
canon[0] = parent;
for (let n = 1; n <= 3; n++) {
  const sealed = mine(hdr(n, parent.hash, CD, A, 1000 + n));
  const block = { hash: blockHash(sealed).toLowerCase(), header: sealed };
  canon[n] = block; parent = block;
}
const canonByHash = new Map(canon.map((b) => [b.hash.toLowerCase(), b]));
const chain = {
  genesis,
  head: canon[3],
  blockByHash: (h) => canonByHash.get(String(h).toLowerCase()) ?? null,
  isCanonical: (h) => canonByHash.has(String(h).toLowerCase()),
  blockByNumber: (n) => canon[Number(n)] ?? null,
};

// --- an orphan: mined on canonical #2, at height 3, HALF the canonical difficulty ---
const orphan = mine(hdr(3, canon[2].hash, CD / 2n, A, 1100));
const orphanHash = blockHash(orphan).toLowerCase();
check('orphan is not on the canonical chain', canon[3].hash !== orphanHash);

const r1 = valueRecoveryClaim(chain, [ser(orphan)]);
check('orphan accepted', r1.accepted === 1, JSON.stringify(r1.skipped));
check('credited to its own coinbase A', r1.perAddress.has(A.toLowerCase()));
const reward = 2000000000000000000n;
const expect = (reward * (CD / 2n)) / CD;      // half difficulty => half a reward
check('valued by WORK (half difficulty -> half reward)',
  r1.perAddress.get(A.toLowerCase())?.wei === expect,
  `${r1.perAddress.get(A.toLowerCase())?.wei} vs ${expect}`);

// --- a canonical block is never honoured twice ---
const rc = valueRecoveryClaim(chain, [ser(canon[3].header)]);
check('a canonical block is skipped (not double-honoured)',
  rc.accepted === 0 && rc.skipped.canonical === 1, JSON.stringify(rc.skipped));

// --- a tampered seal is rejected ---
const bad = { ...ser(orphan) };
bad.header = { ...bad.header, nonce: (BigInt(orphan.nonce) + 1n).toString() };
const rb = valueRecoveryClaim(chain, [bad]);
check('a tampered/invalid seal is rejected', rb.accepted === 0 && rb.skipped.badSeal === 1, JSON.stringify(rb.skipped));

// --- a block with no canonical root is rejected ---
const floating = mine(hdr(9, '0x' + 'cd'.repeat(32), CD / 2n, A, 1200));
const rf = valueRecoveryClaim(chain, [ser(floating)]);
check('a block not rooted in canonical is rejected', rf.accepted === 0 && rf.skipped.noParent === 1, JSON.stringify(rf.skipped));

// --- the credit goes to the block's own coinbase, not the submitter ---
const orphanB = mine(hdr(3, canon[2].hash, CD / 2n, B, 1101));
const rab = valueRecoveryClaim(chain, [ser(orphanB)]);
check('credit follows the block coinbase (B), relayer cannot steal it',
  rab.perAddress.has(B.toLowerCase()) && !rab.perAddress.has(A.toLowerCase()));

// --- ledger: a hash is credited once; address capped at 10k ---
const dir = mkdtempSync(join(tmpdir(), 'recover-'));
try {
  const led = new RecoveryLedger(join(dir, 'recover-claims.json'));
  const first = led.record(r1.perAddress);
  check('ledger records the new credit', first[A.toLowerCase()].added === 1);
  const again = led.record(valueRecoveryClaim(chain, [ser(orphan)]).perAddress);
  check('⛔ replay: the same hash is not credited twice', again[A.toLowerCase()].added === 0);

  // cap
  const huge = new Map([[A.toLowerCase(), { hashes: ['0x' + 'ee'.repeat(32)], wei: MAX_RECOVERY_WEI * 5n }]]);
  const capped = led.record(huge);
  check('per-address cap holds at 10k MOLI', BigInt(capped[A.toLowerCase()].owedWei) === MAX_RECOVERY_WEI,
    capped[A.toLowerCase()].owedWei);

  const un = led.unpaid();
  check('unpaid() lists the owed address', un.some((r) => r.address === A.toLowerCase()));
  led.markPaid(A, MAX_RECOVERY_WEI, '0xpaid');
  check('markPaid clears the due amount', led.unpaid().every((r) => r.address !== A.toLowerCase()));
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\nrecover: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
