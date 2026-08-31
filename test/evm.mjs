/**
 * Molibra - contract execution against Molibra's own state.
 *
 * Real solc output, not hand-written bytecode: test/fixtures/counter.json is
 * Counter.sol compiled by solc 0.8.36 for shanghai. A hand-assembled fixture
 * proves the wrapper accepts what the author expected; a compiled one proves
 * it accepts what a compiler actually emits, which is the thing that matters.
 *
 * The last section is the one to read. It is the check that contract bytecode
 * cannot reach the token registry or the vote keys - the wall the whole
 * electoral position depends on.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { State } from '../src/state.js';
import { runEvm, simulate, HARDFORK } from '../src/evm.js';
import { MolibraStateManager } from '../src/evmstate.js';
import { toHex, fromHex } from '../src/crypto.js';
import { encodeTokenCreate, tokenId } from '../src/token.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const { bytecode, selectors } = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'counter.json'), 'utf8'));

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
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

function funded() {
  const s = new State();
  s.credit(A, 10n ** 18n);
  return s;
}

/* ------------------------------------------------------------------ */
/* 1. Deployment.                                                      */
/* ------------------------------------------------------------------ */

const state = funded();
const rootBeforeAnything = state.root();

const deploy = await runEvm(state, { from: A, to: null, data: bytecode, gasLimit: 3_000_000n });
check('a solc-compiled contract deploys', !deploy.failed, deploy.error ?? `gas ${deploy.gasUsed}`);
check('it has an address', /^0x[0-9a-f]{40}$/.test(deploy.createdAddress ?? ''), deploy.createdAddress ?? '');
check('its runtime code is in the state', state.getCode(deploy.createdAddress).length > 0,
  `${state.getCode(deploy.createdAddress).length} bytes`);
check('the runtime code is shorter than the init code, as it must be',
  state.getCode(deploy.createdAddress).length < (bytecode.length - 2) / 2);
check('deploying moved the state root', state.root() !== rootBeforeAnything);
check('the deployer is now a contract, and an untouched address is not',
  state.hasCode(deploy.createdAddress) && !state.hasCode(A));

const C = deploy.createdAddress;

/* ------------------------------------------------------------------ */
/* 2. Calling it.                                                      */
/* ------------------------------------------------------------------ */

const set = await runEvm(state, {
  from: A, to: C, data: selectors['set(uint256)'] + word(42), gasLimit: 200_000n,
});
check('a state-changing call succeeds', !set.failed, set.error ?? `gas ${set.gasUsed}`);
check('and the write landed in Molibra storage, not somewhere else',
  BigInt(state.getStorage(C, 0)) === 42n);
check('the call cost gas', set.gasUsed > 0n, `${set.gasUsed}`);

check('it emitted one event', set.logs.length === 1);
check('the event came from the contract', set.logs[0]?.address === C);
check('with two topics - the signature and the indexed sender',
  set.logs[0]?.topics.length === 2);
check('and the indexed sender is the caller',
  set.logs[0]?.topics[1]?.endsWith(A.slice(2)), set.logs[0]?.topics[1] ?? '');

/* ------------------------------------------------------------------ */
/* 3. Reading it, without touching it.                                 */
/* ------------------------------------------------------------------ */

const rootBeforeRead = state.root();
const read = await simulate(state, { from: A, to: C, data: selectors['value()'], gasLimit: 100_000n });
check('a read returns the stored value', BigInt(toHex(read.returnValue)) === 42n);
check('⛔ and a simulated call cannot change the real state',
  state.root() === rootBeforeRead, 'eth_call must never be a write');

const simulatedWrite = await simulate(state, {
  from: A, to: C, data: selectors['set(uint256)'] + word(999), gasLimit: 200_000n,
});
check('even simulating a WRITE leaves the real state alone',
  !simulatedWrite.failed && BigInt(state.getStorage(C, 0)) === 42n,
  'the clone took the write, the chain did not');

/* ------------------------------------------------------------------ */
/* 4. Failure.                                                         */
/* ------------------------------------------------------------------ */

const rootBeforeRevert = state.root();
const boom = await runEvm(state, { from: A, to: C, data: selectors['boom()'], gasLimit: 100_000n });
check('a reverting call reports failure', boom.failed, boom.error ?? '');
check('⛔ and leaves NOTHING behind', state.root() === rootBeforeRevert,
  'a revert that half-applies is a chain split');
check('the stored value survived the revert', BigInt(state.getStorage(C, 0)) === 42n);

// 2,000 is EXECUTION gas, not the 21,000 intrinsic a transaction pays -
// runEvm never charges intrinsic, so 21,000 here is generous rather than
// starving. An SSTORE alone cannot fit in 2,000.
const starved = await runEvm(state, {
  from: A, to: C, data: selectors['set(uint256)'] + word(7), gasLimit: 2_000n,
});
check('a call that runs out of gas fails', starved.failed, starved.error ?? '');
check('and changes nothing', BigInt(state.getStorage(C, 0)) === 42n);

/* ------------------------------------------------------------------ */
/* 4b. ⛔ The sender's nonce belongs to the validator, not the EVM.     */
/*                                                                     */
/* runCall() bumps the caller's nonce itself, OUTSIDE its own          */
/* checkpoint - so it survived a revert and moved the state root. That */
/* is a chain split waiting to happen, and it is why the revert check  */
/* above once failed. applyTransaction is the one place an externally  */
/* owned account's nonce may move.                                     */
/* ------------------------------------------------------------------ */

const nonceState = funded();
const n0 = nonceState.nonceOf(A);
const d2 = await runEvm(nonceState, { from: A, to: null, data: bytecode, gasLimit: 3_000_000n });
check('⛔ deploying does not move the sender\'s nonce', nonceState.nonceOf(A) === n0,
  `${n0} -> ${nonceState.nonceOf(A)}`);

await runEvm(nonceState, {
  from: A, to: d2.createdAddress, data: selectors['set(uint256)'] + word(1), gasLimit: 200_000n,
});
check('⛔ nor does a successful call', nonceState.nonceOf(A) === n0);

const nonceRoot = nonceState.root();
const reverted = await runEvm(nonceState, {
  from: A, to: d2.createdAddress, data: selectors['boom()'], gasLimit: 100_000n,
});
check('⛔ nor a reverting one - which is the bug that broke the revert check',
  reverted.failed && nonceState.nonceOf(A) === n0 && nonceState.root() === nonceRoot);

/* ------------------------------------------------------------------ */
/* 5. Isolation between candidate blocks.                              */
/* ------------------------------------------------------------------ */

const parent = funded();
const parentRoot = parent.root();
const candidate = parent.clone();
await runEvm(candidate, { from: A, to: null, data: bytecode, gasLimit: 3_000_000n });
check('⛔ deploying inside a candidate block does not touch its parent',
  parent.root() === parentRoot, 'a rejected block must leave no contract behind');

/* ------------------------------------------------------------------ */
/* 6. ⛔⛔ THE WALL. Bytecode cannot reach the electoral registry.      */
/* ------------------------------------------------------------------ */

const walled = funded();
walled.putToken({
  id: '0xfeed', kind: 'chalk', symbol: 'GIZ', decimals: 0, voteMode: 'single',
  purpose: 'social', cap: 0, maxSupply: 0, minted: 0n, burned: 0n, expressions: 0n,
  expressionCost: 1n, transferable: false, electoral: true, issuable: true,
  creator: A, createdAt: 0n, initialSupply: 0,
});
walled.setTokenBalance('0xfeed', A, 5n);
walled.recordVoteKey('0xdeadbeef');
const registryBefore = JSON.stringify([...walled.tokens], (k, v) => typeof v === 'bigint' ? v.toString() : v);
const balancesBefore = JSON.stringify([...walled.tokenBalances], (k, v) => typeof v === 'bigint' ? v.toString() : v);
const votesBefore = JSON.stringify([...walled.voteKeys]);

const manager = new MolibraStateManager(walled);
const surface = new Set();
for (let o = manager; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
  for (const name of Object.getOwnPropertyNames(o)) surface.add(name);
}
const forbidden = ['getToken', 'putToken', 'mintToken', 'burnToken', 'moveToken',
  'setTokenBalance', 'tokenBalanceOf', 'recordVoteKey', 'hasVoteKey',
  'bumpExpressionCount', 'expressionCount'];
const leaked = forbidden.filter((name) => surface.has(name));
check('⛔⛔ the EVM\'s view of state exposes NO token-registry method',
  leaked.length === 0, leaked.length ? `LEAKED: ${leaked.join(', ')}` : `${forbidden.length} checked`);
check('⛔⛔ and no vote-key method',
  !surface.has('recordVoteKey') && !surface.has('hasVoteKey'));

const c2 = await runEvm(walled, { from: A, to: null, data: bytecode, gasLimit: 3_000_000n });
await runEvm(walled, {
  from: A, to: c2.createdAddress, data: selectors['set(uint256)'] + word(1), gasLimit: 200_000n,
});
check('⛔⛔ running a contract leaves the token registry byte-identical',
  JSON.stringify([...walled.tokens], (k, v) => typeof v === 'bigint' ? v.toString() : v) === registryBefore);
check('⛔⛔ leaves every token balance byte-identical',
  JSON.stringify([...walled.tokenBalances], (k, v) => typeof v === 'bigint' ? v.toString() : v) === balancesBefore);
check('⛔⛔ and cannot forge an expression of will',
  JSON.stringify([...walled.voteKeys]) === votesBefore,
  'the electoral rules stay in the validator, where consensus can read them');

/* ------------------------------------------------------------------ */
/* 7. The hardfork is a decision, not a default.                       */
/* ------------------------------------------------------------------ */

check('the EVM targets shanghai, so PUSH0 from solc >= 0.8.20 is not an invalid opcode',
  HARDFORK === 'shanghai', HARDFORK);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
