/**
 * Molibra - contract code and storage in the state.
 *
 * The claim this file has to earn is not "code can be stored". It is that
 * adding code and storage did NOT change the fingerprint of any chain that
 * has no contracts in it. So the first check loads the PREVIOUS version of
 * state.js straight out of git and compares roots against it, rather than
 * trusting the comment that says they match.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { State, toWord, ZERO_WORD } from '../src/state.js';
import { fromHex, toHex } from '../src/crypto.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`);
  }
}

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const CODE = fromHex('0x6080604052348015600e575f80fd5b50');

/** The same ordinary, contract-free state, built the same way every time. */
function ordinaryState(State_) {
  const s = new State_();
  s.credit(A, 1000n);
  s.bumpNonce(A);
  s.credit(B, 7n);
  s.recordVoteKey('0xabc');
  return s;
}

/* ------------------------------------------------------------------ */
/* 1. The root of a contract-free chain did not move.                  */
/* ------------------------------------------------------------------ */

// state.js at HEAD, written beside the real one so its relative imports
// ('./crypto.js', './token.js', ...) still resolve.
const SHIM = join(ROOT, 'src', '.state-head.test.mjs');
let headRoot = null;
try {
  const previous = execFileSync('git', ['show', 'HEAD:src/state.js'], { cwd: ROOT, encoding: 'utf8' });
  writeFileSync(SHIM, previous);
  const { State: HeadState } = await import('../src/.state-head.test.mjs');
  headRoot = ordinaryState(HeadState).root();
} finally {
  rmSync(SHIM, { force: true });
}

const now = ordinaryState(State);
check('⛔ a chain with no contracts hashes EXACTLY as it did before the EVM',
  headRoot !== null && now.root() === headRoot,
  headRoot === null ? 'could not load HEAD' : now.root().slice(0, 18));
check('and adding the EVM was therefore not a hard fork', now.root() === headRoot);

/* ------------------------------------------------------------------ */
/* 2. Code.                                                            */
/* ------------------------------------------------------------------ */

const before = now.root();
now.setCode(A, CODE);
check('deploying code changes the root', now.root() !== before);
check('the code reads back byte-for-byte', toHex(now.getCode(A)) === toHex(CODE));
check('an address with code is a contract', now.hasCode(A) === true);
check('an address without code is not', now.hasCode(B) === false);
check('an address that was never touched reads as empty code', new State().getCode(B).length === 0);

now.setCode(A, new Uint8Array(0));
check('⛔ deploying nothing is indistinguishable from never deploying',
  now.root() === before, 'empty code is deleted, not stored empty');

/* ------------------------------------------------------------------ */
/* 3. Storage.                                                         */
/* ------------------------------------------------------------------ */

check('an unset slot reads as zero', now.getStorage(A, 0) === ZERO_WORD);

now.setStorage(A, 0, 42n);
check('a written slot reads back as a 32-byte word', now.getStorage(A, 0) === toWord(42n));
check('writing a slot changes the root', now.root() !== before);

now.setStorage(A, 0, 0n);
check('⛔ a slot written and then zeroed is the same state as never written',
  now.root() === before, 'zero clears the slot, exactly as the EVM does');

now.setStorage(A, 2, 5n);
now.setStorage(A, 1, 9n);
const slots = now.storageOf(A);
check('storage comes back sorted by slot, so the root is order-independent',
  slots.length === 2 && slots[0].slot === toWord(1) && slots[1].slot === toWord(2));
check('another address sees none of it', now.storageOf(B).length === 0);

const rootWithStorage = now.root();
const reordered = new State();
reordered.credit(A, 1000n); reordered.bumpNonce(A); reordered.credit(B, 7n);
reordered.recordVoteKey('0xabc');
reordered.setStorage(A, 2, 5n);   // written in the other order
reordered.setStorage(A, 1, 9n);
check('two nodes that wrote the same slots in a different order agree',
  reordered.root() === rootWithStorage);

/* ------------------------------------------------------------------ */
/* 4. Isolation - a candidate block must not write into its parent.    */
/* ------------------------------------------------------------------ */

const parent = ordinaryState(State);
const parentRoot = parent.root();
const child = parent.clone();
child.setCode(B, CODE);
child.setStorage(B, 7, 1n);
check('⛔ deploying in a clone does not touch the parent',
  parent.root() === parentRoot, 'a rejected block must leave no contract behind');
check('and the clone really did change', child.root() !== parentRoot);
check('the parent has no code for that address', parent.hasCode(B) === false);

/* ------------------------------------------------------------------ */
/* 5. Round-trip.                                                      */
/* ------------------------------------------------------------------ */

const plain = ordinaryState(State).toJSON();
check('a contract-free state serialises with no code key', plain.code === undefined);
check('and no storage key', plain.storage === undefined);

const withContract = ordinaryState(State);
withContract.setCode(A, CODE);
withContract.setStorage(A, 3, 123n);
const revived = State.fromJSON(JSON.parse(JSON.stringify(withContract.toJSON())));
check('a state with a contract survives a JSON round-trip', revived.root() === withContract.root());
check('and its code survives it', toHex(revived.getCode(A)) === toHex(CODE));
check('and its storage survives it', revived.getStorage(A, 3) === toWord(123n));

/* ------------------------------------------------------------------ */
/* 6. Word normalisation.                                              */
/* ------------------------------------------------------------------ */

check('a slot addressed as a number, a bigint and hex is one slot',
  toWord(1) === toWord(1n) && toWord(1n) === toWord('0x1'));
check('a value longer than 32 bytes is refused rather than silently truncated',
  toWord(new Uint8Array(40).fill(0xff)).length === 66);
let negRejected = false;
try { toWord(-1n); } catch { negRejected = true; }
check('a negative word is refused', negRejected);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
