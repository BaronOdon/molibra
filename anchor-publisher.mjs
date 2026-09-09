/**
 * Publish one Molibra anchor to Ethereum. This is the cron that raises the floor.
 *
 *   node anchor-publisher.mjs                       pre-flight; signs nothing, sends nothing
 *   node anchor-publisher.mjs --send                do it
 *   node anchor-publisher.mjs --send --node http://localhost:8545 --depth 200
 *
 * ## What it does
 *
 * The anchored floor in src/anchor.js only rises when somebody anchors. Nothing
 * did, so the floor sat 9,377 blocks behind the tip while both nodes reported
 * `anchored: true` - true, and nearly worthless, because a floor two days back
 * finalises nothing that anyone would attack. This closes that loop: read the
 * chain, pick a block that can no longer be reorged away, and record it on
 * Ethereum from the bonded publisher.
 *
 * ## ⛔⛔ EXACTLY ONE HOST MAY RUN THIS
 *
 * `MolibraAnchor.anchor()` requires height AND cumulative work to strictly
 * increase. Two hosts running this on a timer race: whichever lands second
 * reverts `HeightNotIncreasing` and pays full gas for nothing, on a publisher
 * funded for ~100 anchors. Worse, the two would be attesting from two nodes
 * whose tips legitimately differ, so they would not even be describing the same
 * block. Install the timer on ONE host. The lock below only protects against
 * overlapping runs on the SAME host - it cannot see the other one.
 *
 * ## ⛔ Why the depth is not a taste parameter
 *
 * An anchor to a block that later gets reorged away is worse than no anchor:
 * `matchesAttested` in src/anchor.js then reports that this node is on the
 * wrong chain, and it cannot tell whether that is true. A block more than
 * MAX_REORG_DEPTH below the tip cannot be reorged away by this node's own
 * rules, so the depth is derived FROM that constant and refuses to go below it.
 * Raising MAX_REORG_DEPTH therefore raises this depth, and raises the
 * steady-state `exposed` window that /molibra reports as healthy.
 *
 * ## ⛔ The key
 *
 * Read from CREDENTIALS.md, matched by DERIVING the address rather than
 * trusting a label, used to sign locally, never printed. Only signed
 * transactions reach the network. Same discipline as bond-publisher.mjs, and
 * for the same reason: a key written from a Uint8Array once became decimal
 * bytes and the write succeeded, so the address is derived from the file's
 * contents every run rather than assumed.
 */
import { readFileSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signTransaction, decodeTransaction } from './src/tx.js';
import { privateToAddress, toChecksumAddress, toHex, keccak256 } from './src/crypto.js';
import { MAX_REORG_DEPTH } from './src/limits.js';
import { TARGET_ANCHOR_INTERVAL } from './src/anchor.js';

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) =>
  a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') === false ? all[i + 1] : true]] : []));

const ETH_RPC = args.rpc ?? 'https://ethereum-rpc.publicnode.com';
const NODE = args.node ?? 'http://localhost:8545';
const CHAIN_ID = 1n;                                   // Ethereum mainnet
const PUBLISHER = '0x8D1F2713EB83e4D55FBEDA47b26fd08eC9170e14';
const ANCHOR = '0x2beba454d810eac41c6778e351f81d37a07ae03b';
const CRED = args.credentials ?? 'C:/Users/Administrator/Desktop/Server Ops/CREDENTIALS.md';
// ⛔ os.tmpdir(), not a hardcoded /tmp: on Windows that resolves to C:\tmp,
//    which does not exist, so the lock create fails and the run exits reporting
//    "already in progress" - a false clean exit is the worst failure available
//    to a scheduled job.
const LOCK = args.lock ?? join(tmpdir(), 'molibra-anchor-publisher.lock');

// The shallowest depth that cannot be reorged away, plus margin. Derived, so it
// cannot silently fall below MAX_REORG_DEPTH when that constant changes.
const MIN_DEPTH = MAX_REORG_DEPTH + 1;
const DEPTH = BigInt(args.depth ?? MAX_REORG_DEPTH + 72);

const sel = (s) => toHex(keccak256(new TextEncoder().encode(s))).slice(0, 10);
const pad = (h) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const n32 = (v) => pad(BigInt(v).toString(16));
const eth = (w) => (Number(w) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 8 });
const gwei = (w) => (Number(w) / 1e9).toFixed(3);

async function jsonRpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}
const rpc = (m, p) => jsonRpc(ETH_RPC, m, p);
const call = (data) => rpc('eth_call', [{ to: ANCHOR, data, from: PUBLISHER }, 'latest']);
const callUint = async (data) => {
  const v = await call(data);
  return v && v !== '0x' ? BigInt(v) : 0n;
};
async function audit(path) {
  const r = await fetch(NODE + path, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

// ⛔ One run at a time on this host. `wx` fails if the file exists rather than
//    truncating it, which is the only atomic "create if absent" node offers.
let held = false;
try {
  closeSync(openSync(LOCK, 'wx'));
  held = true;
} catch {
  console.error(`[anchor-publisher] ${LOCK} exists - a run is already in progress. Exiting.`);
  process.exit(0);
}
const release = () => { if (held) { try { unlinkSync(LOCK); } catch { /* gone */ } held = false; } };
process.on('exit', release);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(1); });

try {
  await main();
} catch (error) {
  // Unwrap undici's "fetch failed", which hides the reason in error.cause.
  const parts = [error.message];
  for (let c = error.cause; c; c = c.cause) parts.push(c.code ?? c.message);
  console.error(`[anchor-publisher] ${parts.filter(Boolean).join(' <- ')}`);
  process.exitCode = 1;
} finally {
  release();
}

async function main() {
  const SEND = process.argv.includes('--send');

  // --- the key, found by derivation, never by label -------------------------
  let KEY = null;
  for (const c of new Set(readFileSync(CRED, 'utf8').match(/\b[0-9a-fA-F]{64}\b/g) ?? [])) {
    try {
      if (toChecksumAddress(privateToAddress(c)).toLowerCase() === PUBLISHER.toLowerCase()) KEY = c;
    } catch { /* not a key */ }
  }
  if (!KEY) throw new Error(`no key in ${CRED} derives ${PUBLISHER}`);
  console.log('key            : found, derives the publisher (never printed)');

  // --- what does the chain say? ---------------------------------------------
  if (DEPTH < BigInt(MIN_DEPTH)) {
    throw new Error(`--depth ${DEPTH} is at or below MAX_REORG_DEPTH ${MAX_REORG_DEPTH}: `
      + `a block that shallow can still be reorged away, and anchoring one that is `
      + `later reorged tells every node it is on the wrong chain. Minimum ${MIN_DEPTH}.`);
  }
  const status = await audit('/molibra');
  const tip = BigInt(status.height);
  const height = tip - DEPTH;
  if (height <= 0n) throw new Error(`chain is only ${tip} blocks; nothing is ${DEPTH} deep yet`);

  const block = await audit(`/molibra/block/${height}?decoded=1`);
  const blockHash = block.hash;
  const cumulativeWork = BigInt(block.totalDifficulty);

  // ⛔ The audit route reports whether the block is on the canonical chain. An
  //    anchor to an orphan is the exact failure this whole script guards
  //    against, so it is checked rather than assumed.
  if (block.canonical === false) throw new Error(`block ${height} is not canonical on ${NODE}`);
  if (!blockHash || cumulativeWork <= 0n) throw new Error(`block ${height} has no hash or no work`);

  console.log(`node           : ${NODE}`);
  console.log(`  tip          : ${tip}`);
  console.log(`  anchoring    : ${height}  (depth ${DEPTH}, min ${MIN_DEPTH})`);
  console.log(`  hash         : ${blockHash}`);
  console.log(`  work         : ${cumulativeWork}`);

  // --- may it be published? -------------------------------------------------
  const [bonded, minBond, slashed, tipHeight, tipWork, gasBal, gasPrice] = await Promise.all([
    callUint(sel('bondOf(address)') + pad(PUBLISHER)),
    callUint(sel('minimumBond()')),
    callUint(sel('slashed(address)') + pad(PUBLISHER)),
    callUint(sel('tipHeight()')),
    callUint(sel('tipWork()')),
    rpc('eth_getBalance', [PUBLISHER, 'latest']).then(BigInt),
    rpc('eth_gasPrice', []).then(BigInt),
  ]);
  const count = await callUint(sel('anchorCount()'));

  console.log(`publisher      : ${PUBLISHER}`);
  console.log(`  bonded       : ${eth(bonded)} WSRO  (minimum ${eth(minBond)})`);
  console.log(`  ETH for gas  : ${eth(gasBal)}`);
  console.log(`  gas price    : ${gwei(gasPrice)} gwei`);
  console.log(`contract       : ${count} anchor(s), tip height ${tipHeight}, tip work ${tipWork}`);

  const problems = [];
  if (slashed !== 0n) problems.push('the publisher is SLASHED - it can never anchor again');
  if (bonded < minBond) problems.push(`bond ${eth(bonded)} is below the minimum ${eth(minBond)}`);
  // ⛔ Both monotonicity rules are checked HERE so a doomed transaction is never
  //    signed. On-chain they revert, and a revert costs the same gas as success
  //    out of a wallet funded for about a hundred of these.
  if (count > 0n && height <= tipHeight) {
    problems.push(`height ${height} does not exceed the anchored tip ${tipHeight} `
      + '- the chain has not advanced past the last anchor yet');
  }
  if (count > 0n && cumulativeWork <= tipWork) {
    problems.push(`cumulative work ${cumulativeWork} does not exceed ${tipWork} at the anchored tip`);
  }
  if (problems.length) {
    console.log('\nNothing to do:');
    for (const p of problems) console.log('  ⛔ ' + p);
    // Not an error: the timer runs far more often than the chain advances a
    // full interval, so "too early" is the normal case and must not page anyone.
    const fatal = slashed !== 0n || bonded < minBond;
    process.exitCode = fatal ? 1 : 0;
    return;
  }

  // --- build, sign, and READ BACK what was signed ---------------------------
  const data = sel('anchor(uint256,bytes32,uint256)') + n32(height) + pad(blockHash) + n32(cumulativeWork);
  const nonce = BigInt(await rpc('eth_getTransactionCount', [PUBLISHER, 'pending']));
  let gasLimit;
  try {
    gasLimit = BigInt(await rpc('eth_estimateGas', [{ from: PUBLISHER, to: ANCHOR, data }])) * 12n / 10n;
  } catch (error) {
    // An estimate that reverts means the call itself would revert. Say which,
    // rather than sending a guessed limit into a transaction that cannot work.
    throw new Error(`eth_estimateGas reverted, so anchor() would too: ${error.message}`);
  }
  const cost = gasPrice * gasLimit;

  const raw = signTransaction({ nonce, gasPrice, gasLimit, to: ANCHOR, value: 0n, data }, KEY, CHAIN_ID);
  // ⛔ Decode the signed bytes and check them against intent. Re-printing the
  //    inputs proves nothing; a wrong `to` on mainnet is unrecoverable.
  const back = decodeTransaction(raw, Number(CHAIN_ID));
  const ok = (back.from ?? '').toLowerCase() === PUBLISHER.toLowerCase()
    && (back.to ?? '').toLowerCase() === ANCHOR.toLowerCase()
    && BigInt(back.value) === 0n
    && (back.data ?? '').toLowerCase() === data.toLowerCase();
  console.log('\nanchor(height, blockHash, cumulativeWork)');
  console.log(`  to     ${back.to}  ${ok ? '✓' : '⛔ MISMATCH'}`);
  console.log(`  from   ${back.from}`);
  console.log(`  nonce  ${nonce}  gas ${gasLimit}  cost ≤ ${eth(cost)} ETH`);
  if (cost > 0n) {
    console.log(`  runway ${(gasBal / cost).toString()} more anchor(s) at this gas price`);
  }
  if (!ok) throw new Error('signed transaction does not match intent — refusing');
  if (gasBal < cost) throw new Error(`holds ${eth(gasBal)} ETH, needs ${eth(cost)} - fund the publisher`);

  if (!SEND) {
    console.log('\nPRE-FLIGHT ONLY — nothing sent. Re-run with --send.');
    return;
  }

  const hash = await rpc('eth_sendRawTransaction', [toHex(raw)]);
  console.log(`  sent   ${hash}`);
  for (let i = 0; i < 60; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) {
      const good = BigInt(r.status) === 1n;
      console.log(`  mined  block ${BigInt(r.blockNumber)}  status ${good ? 'OK' : 'FAILED'}  `
        + `gas used ${BigInt(r.gasUsed)}`);
      if (!good) throw new Error('anchor() reverted on chain');
      // ⛔ The floor does NOT move yet. src/anchor.js only counts an anchor once
      //    ETH_CONFIRMATIONS Ethereum blocks sit on top of it, and the nodes
      //    read anchors.json on their own 5-minute timer. Saying "the floor is
      //    now N" here would be asserting something not yet true.
      console.log(`\n✓ anchored ${height} at ${blockHash}`);
      console.log(`  It binds after 96 Ethereum confirmations (~19 min), once each node's`);
      console.log(`  molibra-anchors.timer has refreshed anchors.json. Check the finality`);
      console.log(`  block on /molibra rather than assuming.`);
      console.log(`  Next anchor is due around Molibra height ${height + BigInt(TARGET_ANCHOR_INTERVAL)}.`);
      return;
    }
    await new Promise((r2) => setTimeout(r2, 5000));
  }
  // ⛔ Not a failure - it is in the mempool with a nonce. Re-running before it
  //    mines would build the SAME nonce again at the same gas price and be
  //    rejected as a duplicate, which is the safe outcome, but say so plainly.
  throw new Error(`${hash} did not confirm in 5 minutes; it is still pending with nonce ${nonce}`);
}
