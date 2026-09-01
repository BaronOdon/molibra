/**
 * The anchor watcher: does it actually see the thing it exists to see?
 *
 * ⛔ A monitoring tool is the one kind of code where passing tests and silence
 * look identical from outside. So the checks here are mostly about the watcher
 * REPORTING - a pass that says "0 findings" has to be a pass because there was
 * nothing wrong, never because the watcher looked in the wrong place.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { keccak256, toHex } from '../src/crypto.js';
import {
  classifyAnchor, classifyLiveness, equivocationProofFor, review,
  ANCHORED_TOPIC, EQUIVOCATION_TOPIC,
} from '../src/watch.js';

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('the anchor watcher\n');

const utf8 = (s) => new TextEncoder().encode(s);
const topic = (s) => toHex(keccak256(utf8(s)));

const H = (n) => '0x' + String(n).padStart(64, 'a');
const REAL = H(1);
const FAKE = H(2);

/* ------------------------------------------------------------- topics */

check('⛔ the Anchored topic is DERIVED, not pasted',
  ANCHORED_TOPIC === topic('Anchored(uint256,bytes32,uint256,address)'),
  ANCHORED_TOPIC);
check('  and so is Equivocation',
  EQUIVOCATION_TOPIC === topic('Equivocation(address,uint256,bytes32,bytes32,uint256)'));
// ⛔ The reason this is checked at all: a wrong topic makes eth_getLogs return
// [] and the watcher report "all fine" forever. It fails SILENT, which for a
// monitor is the worst possible failure.
check('  a wrong topic would not throw — which is why it is checked here',
  ANCHORED_TOPIC !== topic('Anchored(uint256,bytes32,uint256)'),
  'an almost-right signature is a different topic and an empty log set');

/* --------------------------------------------------- the runner's getters */

// ⛔ The watcher reads anchors out of contract STATE, not from logs — an
// earlier version scanned eth_getLogs from block 0 and was refused with
// "Archive requests require a personal token", which would have made the
// watcher depend on a paid key it does not have. These selectors are what it
// calls instead, and a wrong one returns empty data rather than throwing.
const runner = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts-watch', 'watch.mjs'), 'utf8');
for (const [key, sig] of Object.entries({
  anchorCount: 'anchorCount()',
  heights: 'heights(uint256)',
  anchors: 'anchors(uint256)',
})) {
  const m = runner.match(new RegExp(`${key}:\\s*'(0x[0-9a-f]{8})'`));
  check(`the runner's ${key} selector is keccak of ${sig}`,
    Boolean(m) && m[1] === topic(sig).slice(0, 10),
    m ? `${m[1]} vs ${topic(sig).slice(0, 10)}` : 'not found');
}
check('⛔ and it does NOT scan logs from block 0',
  !runner.includes("fromBlock: '0x0'"),
  'a watcher that needs an archive node stops working when the key lapses');

/* -------------------------------------------------------- the mismatch */

const chain = new Map([[10n, REAL], [11n, H(3)]]);
const at = (h) => (chain.has(h) ? chain.get(h) : null);

const honest = classifyAnchor({ height: 10n, blockHash: REAL }, at);
check('an anchor matching the chain is ok', honest.severity === 'ok');

const lying = classifyAnchor({ height: 10n, blockHash: FAKE, publisher: '0x' + '11'.repeat(20) }, at);
check('⛔⛔ an anchor that does NOT match is a mismatch', lying.severity === 'mismatch');
check('  and it reports BOTH hashes, so a person can judge which is wrong',
  lying.anchored === FAKE && lying.mine === REAL);
check('  and names the publisher', lying.publisher === '0x' + '11'.repeat(20));
check('  and says not to accept anything minted against it',
  /do not accept/i.test(lying.message));

const unknown = classifyAnchor({ height: 99n, blockHash: FAKE }, at);
check('a height this node does not have is flagged, not silently passed',
  unknown.severity === 'unknown-height',
  'an unknown height is the shape a fork takes before it is obvious');
check('  and is NOT reported as agreement', unknown.severity !== 'ok');

// Case matters: an anchor arriving upper-case must not read as a mismatch.
const cased = classifyAnchor({ height: 10n, blockHash: REAL.toUpperCase() }, at);
check('⛔ hashes compare case-insensitively', cased.severity === 'ok',
  'otherwise every anchor from a different tool is a false alarm, and alarms that cry wolf get muted');

/* ----------------------------------------------------------- liveness */

check('a chain that advanced is fine',
  classifyLiveness({ height: 12n, previousHeight: 11n, secondsSince: 900 }).severity === 'ok');
check('⛔ a chain stuck past ten block-times is stale',
  classifyLiveness({ height: 11n, previousHeight: 11n, secondsSince: 300 }).severity === 'stale',
  'the published node once synced and froze while looking joined');
check('  but ordinary variance is not an alarm',
  classifyLiveness({ height: 11n, previousHeight: 11n, secondsSince: 60 }).severity === 'ok',
  'a monitor that pages on noise gets turned off');
check('  and the first pass, with no previous height, never alarms',
  classifyLiveness({ height: 11n, previousHeight: null, secondsSince: 99999 }).severity === 'ok');

/* ------------------------------------------------------ equivocation */

const a = { height: 10n, blockHash: REAL, cumulativeWork: 100n, signature: '0xaa' };
const b = { height: 10n, blockHash: FAKE, cumulativeWork: 101n, signature: '0xbb' };
const proof = equivocationProofFor(a, b);
check('two conflicting attestations produce a proof', proof !== null);
check('  carrying both hashes and both signatures',
  proof.hashA === REAL && proof.hashB === FAKE && proof.sigA === '0xaa' && proof.sigB === '0xbb');
check('  and both digests, so the submitter can check before paying gas',
  Boolean(proof.digestA) && Boolean(proof.digestB) && proof.digestA !== proof.digestB);
check('⛔ identical attestations are NOT a proof',
  equivocationProofFor(a, { ...a }) === null,
  'the contract refuses it; building one would only waste the submitter gas');
check('⛔ attestations for different heights are not a proof',
  equivocationProofFor(a, { ...b, height: 11n }) === null);

/* --------------------------------------------------------- the review */

const clean = review({
  anchors: [{ height: 10n, blockHash: REAL }],
  chainHashAt: at,
  liveness: { height: 12n, previousHeight: 11n, secondsSince: 20 },
});
check('a clean review has no findings', clean.findings.length === 0 && clean.worst === 'ok');
check('  and still reports how many it CHECKED',
  clean.checked === 1,
  '"nothing wrong" and "nothing looked at" must not print the same');

const dirty = review({
  anchors: [
    { height: 10n, blockHash: REAL },
    { height: 99n, blockHash: FAKE },
    { height: 10n, blockHash: FAKE },
  ],
  chainHashAt: at,
  liveness: { height: 11n, previousHeight: 11n, secondsSince: 900 },
});
check('a dirty review finds all of them', dirty.findings.length === 3, `${dirty.findings.length}`);
check('⛔⛔ and the MISMATCH sorts first, above stale and unknown',
  dirty.findings[0].severity === 'mismatch' && dirty.worst === 'mismatch',
  'the worst thing must be the first thing a person reads');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
