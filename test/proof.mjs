/**
 * Inclusion proofs — checked at every awkward tree size, not just the tidy one.
 *
 * Molibra's Merkle tree PROMOTES an odd trailing node rather than duplicating
 * it. Powers of two never exercise that path, so a proof implementation tested
 * only on 2, 4 and 8 leaves can be wholly wrong for 3, 5, 6, 7 and 9 and look
 * perfect. Every size from 1 to 12 is checked here, and every leaf within each.
 */

import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { Chain } from '../src/chain.js';
import { signTransaction } from '../src/tx.js';
import { merkleRoot } from '../src/block.js';
import { privateToAddress, fromHex, toHex } from '../src/crypto.js';
import {
  merkleProof, verifyMerkleProof, transactionProof, verifyTransactionProof,
} from '../src/proof.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENESIS = join(ROOT, 'genesis.json');
const dirs = [];
const scratch = (n) => { const d = mkdtempSync(join(tmpdir(), `molibra-proof-${n}-`)); dirs.push(d); return d; };

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('inclusion proofs\n');

// --- the tree, at every size that matters --------------------------------
let bad = [];
for (let size = 1; size <= 12; size++) {
  const leaves = Array.from({ length: size }, () => '0x' + randomBytes(32).toString('hex'));
  const root = merkleRoot(leaves);
  for (let i = 0; i < size; i++) {
    if (!verifyMerkleProof(leaves[i], merkleProof(leaves, i), root)) {
      bad.push(`${size}/${i}`);
    }
  }
}
check('every leaf of every tree from 1 to 12 proves against its own root',
  bad.length === 0, bad.length ? bad.join(', ') : '78 leaves across 12 trees');

// Odd sizes are where the promotion rule lives, so they get said out loud.
const odd = [3, 5, 7, 9, 11].every((size) => {
  const leaves = Array.from({ length: size }, () => '0x' + randomBytes(32).toString('hex'));
  const root = merkleRoot(leaves);
  return leaves.every((leaf, i) => verifyMerkleProof(leaf, merkleProof(leaves, i), root));
});
check('including the odd sizes, where a trailing node is PROMOTED not duplicated', odd,
  'a verifier written for the duplicate convention would reject all of these');

const single = ['0x' + randomBytes(32).toString('hex')];
check('a lone transaction has an empty path and is its own root',
  merkleProof(single, 0).length === 0 && merkleRoot(single) === single[0]);

// --- a proof must not be reusable elsewhere ------------------------------
const leaves = Array.from({ length: 7 }, () => '0x' + randomBytes(32).toString('hex'));
const root = merkleRoot(leaves);
const path = merkleProof(leaves, 2);
check('a valid path proves its own leaf', verifyMerkleProof(leaves[2], path, root));
check('and does not prove a different leaf', !verifyMerkleProof(leaves[3], path, root));
check('a tampered sibling breaks it',
  !verifyMerkleProof(leaves[2],
    path.map((s, i) => (i === 0 ? { ...s, hash: '0x' + 'ee'.repeat(32) } : s)), root));
check('a flipped side breaks it',
  !verifyMerkleProof(leaves[2],
    path.map((s, i) => (i === 0 ? { ...s, side: s.side === 'left' ? 'right' : 'left' } : s)), root));
check('a path from another tree does not verify',
  !verifyMerkleProof(leaves[2], merkleProof(
    Array.from({ length: 7 }, () => '0x' + randomBytes(32).toString('hex')), 2), root));

// --- against a real chain -------------------------------------------------
const ALICE_KEY = fromHex('0x' + '01'.repeat(32));
const ALICE = privateToAddress(ALICE_KEY);
const BOB = privateToAddress(fromHex('0x' + '02'.repeat(32)));
const chain = new Chain(Chain.loadGenesis(GENESIS), scratch('chain')).init();
for (let i = 0; i < 4; i++) chain.mine(ALICE);

// Five transactions in one block: an odd count, on purpose.
const hashes = [];
for (let i = 0; i < 5; i++) {
  hashes.push(chain.submitRaw(toHex(signTransaction(
    { nonce: BigInt(i), gasPrice: 1000000000n, gasLimit: 21000n, to: BOB, value: 1n, data: '0x' },
    ALICE_KEY, chain.chainId))));
}
chain.mine(ALICE);
const block = chain.blockByNumber(Number(chain.height));
check('five transactions went into one block', block.transactions.length === 5);

let chainBad = [];
for (const hash of hashes) {
  const proof = transactionProof(chain, hash);
  const verdict = verifyTransactionProof(proof);
  if (!verdict.ok) chainBad.push(`${hash.slice(0, 10)}: ${verdict.reasons.join('; ')}`);
}
check('every transaction in it proves, verified from the header alone',
  chainBad.length === 0, chainBad.join(' | ') || '5 of 5');

const proof = transactionProof(chain, hashes[3]);
check('the proof carries the whole header, not just a root',
  proof.header.parentHash && proof.header.nonce !== undefined && proof.header.difficulty);
check('and it says plainly what it does not prove',
  /does NOT\s+prove that block is canonical/.test(verifyTransactionProof(proof).note),
  'inclusion is not canonicity, and a bridge that confuses them loses money');

// --- what a forger would try ---------------------------------------------
const tamperedHeader = { ...proof, header: { ...proof.header, stateRoot: '0x' + 'ab'.repeat(32) } };
check('a header edited after the fact fails the block-hash check',
  !verifyTransactionProof(tamperedHeader).ok
  && verifyTransactionProof(tamperedHeader).reasons.some((r) => /does not hash/.test(r)));

const swappedRoot = {
  ...proof,
  header: { ...proof.header, txRoot: '0x' + 'cd'.repeat(32) },
  blockHash: proof.blockHash,
};
check('swapping the transaction root fails too', !verifyTransactionProof(swappedRoot).ok);

const foreign = { ...proof, txHash: '0x' + randomBytes(32).toString('hex') };
check('a proof cannot be re-pointed at a transaction that was not there',
  !verifyTransactionProof(foreign).ok
  && verifyTransactionProof(foreign).reasons.some((r) => /not in this block/.test(r)));

// A header with its proof of work stripped: the seal check is what makes the
// proof cost something to fabricate.
const unsealed = { ...proof, header: { ...proof.header, nonce: '0' } };
const unsealedVerdict = verifyTransactionProof(unsealed);
check('a header without valid work is refused', !unsealedVerdict.ok,
  unsealedVerdict.reasons.join('; '));

check('a transaction that was never mined has no proof',
  transactionProof(chain, '0x' + randomBytes(32).toString('hex')) === null);

console.log(`\n${pass} passed, ${fail} failed`);
for (const d of dirs) rmSync(d, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
