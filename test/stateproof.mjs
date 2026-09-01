/**
 * Proving one fact about the state.
 *
 * The whitepaper said "light-client proofs do not exist here yet". This file is
 * the check that they now do — and, just as importantly, that turning them on
 * did not quietly change what every existing block hashes to.
 */

import { State, applyTransaction } from '../src/state.js';
import { intrinsicGas } from '../src/tx.js';
import { merkleRoot as txMerkleRoot } from '../src/block.js';
import { keccak256, toHex } from '../src/crypto.js';
import {
  stateRoot, proofFor, rootFromProof, verifyStateProof, leafOf, accountLine,
  STATE_MERKLE_ACTIVATION,
} from '../src/stateproof.js';

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('state proofs\n');

const ALICE = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
const BOB = '0x2b5ad5c4795c026514f8317c7a215e218dccd6cf';
const MINER = '0x9999999999999999999999999999999999999999';

const populated = () => {
  const s = new State();
  s.credit(ALICE, 10n ** 20n);
  s.credit(BOB, 5n * 10n ** 18n);
  s.credit(MINER, 7n);
  s.bumpNonce(ALICE);
  return s;
};

/* ------------------------------------------------- ⛔ no silent fork */

const s = populated();
check('⛔⛔ the DEFAULT root is still the old concatenation',
  s.root() === s.rootConcat(),
  'an omitted height argument must mean "no change", never "silent fork"');
check('⛔ and one block BEFORE activation is still the old form',
  s.root(STATE_MERKLE_ACTIVATION - 1n) === s.rootConcat());
check('⭐ AT the activation height it becomes the Merkle root',
  s.root(STATE_MERKLE_ACTIVATION) === s.rootMerkle(),
  `height ${STATE_MERKLE_ACTIVATION}`);
check('  and the two are genuinely different values',
  s.rootConcat() !== s.rootMerkle(),
  'same lines, different combination');

/* -------------------------------------------- the construction matches */

// ⭐ The whole point: a state proof must verify under the SAME construction
// that MolibraSettlement and BridgedMoli already run on Ethereum. If this
// diverges, a contract cannot check a Molibra state proof and the reuse
// argument evaporates.
const lines = s.rootLines();
check('⛔⛔ stateRoot is byte-identical to block.js merkleRoot over the same leaves',
  stateRoot(lines) === txMerkleRoot(lines.map((l) => toHex(leafOf(l)))),
  'one construction, two implementations that must agree forever');

/* --------------------------------------------------------- the proof */

check('the state has lines to prove', lines.length >= 3, `${lines.length} lines`);

const aLine = accountLine(s, ALICE);
check('an account contributes the line root() emits', lines.includes(aLine), aLine);

const proof = s.proofForLine(aLine);
check('a proof is produced for it', proof !== null);
check('  and it reproduces the Merkle root', rootFromProof(proof) === s.rootMerkle());
check('  and verifies against that root', verifyStateProof(proof, s.rootMerkle()));
check('  in log(n) hashes, not the whole state',
  proof.siblings.length <= Math.ceil(Math.log2(lines.length)) + 1,
  `${proof.siblings.length} sibling(s) for ${lines.length} lines`);
check('  carrying a side per level, not an index',
  proof.siblings.length === proof.siblingOnRight.length,
  'a verifier that hashes in one order accepts a proof for another position');

/* ---------------------------------------------------------- refusals */

check('⛔ a proof does NOT verify against the concatenation root',
  !verifyStateProof(proof, s.rootConcat()),
  'the two roots are different objects and must not be interchangeable');

const tampered = { ...proof, line: aLine.replace(/:[0-9a-f]+:/, ':ffffff:') };
check('⛔⛔ a proof for a TAMPERED balance does not verify',
  !verifyStateProof(tampered, s.rootMerkle()),
  'this is the only check that matters: you cannot prove a balance you do not have');

const flipped = { ...proof, siblingOnRight: proof.siblingOnRight.map((b) => !b) };
check('⛔ flipping the sides breaks the proof',
  proof.siblings.length === 0 || !verifyStateProof(flipped, s.rootMerkle()));

const truncated = { ...proof, siblings: proof.siblings.slice(0, -1) };
check('⛔ a short proof does not verify',
  proof.siblings.length === 0 || !verifyStateProof(truncated, s.rootMerkle()));

check('⛔ mismatched siblings and sides is malformed, not accepted',
  !verifyStateProof({ line: aLine, siblings: proof.siblings, siblingOnRight: [] }, s.rootMerkle())
  || proof.siblings.length === 0);

check('⛔ a line that is not in the state has no proof',
  s.proofForLine('0xdeadbeef:1:1') === null,
  'impossible rather than empty');

// An account with nothing contributes nothing - root() skips it.
const empty = new State();
check('⛔ an empty account contributes no line, so it cannot be proved',
  accountLine(empty, ALICE) === null,
  'root() skips it, so a proof would be proving something that is not there');

/* ------------------------------------------------- every line provable */

let allOk = true;
for (let i = 0; i < lines.length; i++) {
  const p = proofFor(lines, i);
  if (rootFromProof(p) !== stateRoot(lines)) { allOk = false; break; }
}
check('⭐ EVERY line in the state is provable, not just the convenient ones',
  allOk, `${lines.length}/${lines.length}`);

// ⛔ Odd counts are where naive Merkle code breaks: a promoted node was never
// hashed with anything, so it contributes no sibling at that level.
let oddOk = true;
for (const n of [1, 2, 3, 5, 7, 9, 33]) {
  const ls = Array.from({ length: n }, (_, i) => `line:${i}`);
  const r = stateRoot(ls);
  for (let i = 0; i < n; i++) {
    if (rootFromProof(proofFor(ls, i)) !== r) { oddOk = false; break; }
  }
  if (!oddOk) break;
}
check('⛔⛔ proofs hold at odd tree widths, where promoted nodes have no sibling',
  oddOk, 'sizes 1,2,3,5,7,9,33');

const single = stateRoot(['only:one']);
check('a one-line state roots to its own leaf', single === toHex(leafOf('only:one')));
check('an empty state roots to zero', stateRoot([]) === '0x' + '00'.repeat(32));

/* -------------------------------------------- it tracks real mutations */

const before = s.rootMerkle();
const t = { from: ALICE, to: BOB, value: 10n ** 18n, nonce: s.nonceOf(ALICE), gasPrice: 1n, gasLimit: 21000n, data: '0x' };
await applyTransaction(s, t, intrinsicGas(t), MINER, 1n);
check('a transfer moves the Merkle root', s.rootMerkle() !== before);
const after = s.proofForLine(accountLine(s, BOB));
check('  and the new balance is provable against the new root',
  verifyStateProof(after, s.rootMerkle()));
check('  while the OLD proof no longer verifies',
  !verifyStateProof(proof, s.rootMerkle()),
  'a stale proof must not pass, or the root proves nothing');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
