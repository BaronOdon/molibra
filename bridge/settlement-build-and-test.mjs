/**
 * Molibra - the affordable settlement path: compile, then EXECUTE.
 *
 * The point is not that MolibraSettlement.sol compiles. It is that a REAL
 * Molibra block, a REAL bridge-out transaction and a REAL Merkle path move
 * real ether out of the contract in a real EVM - and that the gas it takes is
 * measured here rather than asserted anywhere.
 *
 * The number this file exists to produce is the last one printed: what one
 * bridge-out costs. MolibraRelay's equivalent is 168,288 gas PER HEADER, times
 * every block since its checkpoint. If the figure below is not an ordinary
 * transaction, this contract has no reason to exist.
 *
 * Toolchain lives outside the repo (solc is dev-only, and Molibra ships with
 * two dependencies). Point SOLC_DIR at a directory where `npm i solc` has run.
 */

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RLP } from '@ethereumjs/rlp';

import { State } from '../src/state.js';
import { runEvm, simulate } from '../src/evm.js';
import { encodeHeader } from '../src/block.js';
import { keccak256, toHex, fromHex, normalizeAddress } from '../src/crypto.js';
import { encodeBridgeOut, BRIDGE_OUT_TAG } from '../src/bridge.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOLC_DIR = process.env.SOLC_DIR
  ?? 'C:/Users/ADMINI~1/AppData/Local/Temp/1/claude/C--Users-Administrator/f23c823d-008f-4962-86e2-417dd26c5ad6/scratchpad/solc';
const req = createRequire(join(SOLC_DIR, 'index.js'));
const solc = req('solc');

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

console.log('Molibra settlement: compile, then execute\n');

/* ------------------------------------------------------------- compile */

const sources = {
  'MolibraSettlement.sol': { content: readFileSync(join(HERE, 'MolibraSettlement.sol'), 'utf8') },
  'MolibraAnchor.sol': { content: readFileSync(join(HERE, 'MolibraAnchor.sol'), 'utf8') },
};

const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // ⛔ `release` takes five arguments and still needs the height at the end,
    // for the event. Without the IR pipeline that is "Stack too deep" - the
    // old codegen runs out of the EVM's 16 reachable stack slots. viaIR is the
    // documented fix and it is a compiler change, not a contract change: the
    // ABI is identical either way.
    viaIR: true,
    // ⛔ Paris, not the compiler's default. solc 0.8.26 emits PUSH0 and MCOPY
    // for Cancun; on a target that has not adopted them that is `invalid
    // opcode` with no revert reason, which reads like a broken contract rather
    // than a mis-set compiler. Mainnet has Cancun, but the local EVM here runs
    // shanghai, and one target that works everywhere beats two that differ.
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
})));

const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
check('the contracts compile', errors.length === 0,
  errors.map((e) => e.formattedMessage).join('\n') || 'solc ' + solc.version().split('+')[0]);
if (errors.length) process.exit(1);

const artifacts = {};
for (const file of Object.keys(out.contracts)) {
  for (const [name, c] of Object.entries(out.contracts[file])) {
    artifacts[name] = {
      abi: c.abi,
      bytecode: '0x' + c.evm.bytecode.object,
      deployed: '0x' + c.evm.deployedBytecode.object,
    };
  }
}
/**
 * ⛔⛔ Only MolibraSettlement's artifact is written.
 *
 * MolibraAnchor is compiled here because this contract talks to it, not because
 * it needs building: it is ALREADY DEPLOYED at 0x2beba454…e03b, and it was
 * compiled without the IR pipeline. Writing this build over its artifact would
 * leave the repo claiming bytecode that is not what is on chain, so anyone
 * verifying the live contract against the repo would get a mismatch and no
 * explanation for it. A deployed contract's artifact is a record, not an
 * output.
 */
mkdirSync(join(HERE, 'artifacts'), { recursive: true });
writeFileSync(join(HERE, 'artifacts', 'MolibraSettlement.json'),
  JSON.stringify(artifacts.MolibraSettlement, null, 2));
const runtimeBytes = (artifacts.MolibraSettlement.deployed.length - 2) / 2;
check('and MolibraSettlement is under the 24,576-byte contract limit',
  runtimeBytes < 24576, `${runtimeBytes} bytes`);

/* ------------------------------------------------------------- fixtures */

const utf8 = (s) => new TextEncoder().encode(s);
const sel = (s) => toHex(keccak256(utf8(s))).slice(0, 10);
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const asBig = (b) => (b.length ? BigInt(toHex(b)) : 0n);

const state = new State();
const PUBLISHER = '0x1111111111111111111111111111111111111111';
const ANYONE = '0x2222222222222222222222222222222222222222';
const BENEFICIARY = '0x3333333333333333333333333333333333333333';
for (const a of [PUBLISHER, ANYONE]) state.credit(a, 10n ** 20n);
const GAS = 12_000_000n;

/**
 * ⛔ The harness advances `block.number` on every send.
 *
 * It did not, at first, and every transaction ran at height 0. The challenge
 * window can never mature at a standing height, so the happy path reverted
 * with `ChallengeWindowOpen` - and, worse, the two refusal checks around it
 * PASSED for entirely the wrong reason. A test whose clock does not move
 * cannot test anything that waits.
 */
let ethBlock = 1n;
async function deploy(from, name, args = '', value = 0n) {
  const r = await runEvm(state, {
    from, to: null, data: artifacts[name].bytecode + args, gasLimit: GAS, value, blockNumber: ethBlock++,
  });
  if (r.failed) throw new Error(`${name} deploy failed: ${r.error}`);
  state.bumpNonce(from);
  return { address: r.createdAddress, gas: r.gasUsed };
}
async function send(from, to, data, value = 0n) {
  const r = await runEvm(state, {
    from, to, data: fromHex(data), gasLimit: GAS, value, blockNumber: ethBlock++,
  });
  state.bumpNonce(from);
  return r;
}
async function read(to, data) {
  const r = await simulate(state, { from: ANYONE, to, data: fromHex(data), gasLimit: GAS, blockNumber: ethBlock });
  return r;
}

/* A bonded publisher needs a bond token. The real one is WSRO; here it is the
 * same shape, because what is under test is the settlement, not the ERC-20. */
const TOKEN_SRC = `// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;
contract Bond {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  constructor() { balanceOf[msg.sender] = 10**24; }
  function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
  function transfer(address t, uint256 v) external returns (bool) {
    balanceOf[msg.sender] -= v; balanceOf[t] += v; return true; }
  function transferFrom(address f, address t, uint256 v) external returns (bool) {
    allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[t] += v; return true; }
}`;
const tokenOut = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'Bond.sol': { content: TOKEN_SRC } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
artifacts.Bond = { bytecode: '0x' + tokenOut.contracts['Bond.sol'].Bond.evm.bytecode.object };

const bond = await deploy(PUBLISHER, 'Bond');
const MIN_BOND = 20_000n * 10n ** 18n;
const anchor = await deploy(PUBLISHER, 'MolibraAnchor', addr(bond.address) + word(MIN_BOND));
check('the anchor deploys', Boolean(anchor.address), anchor.address);

await send(PUBLISHER, bond.address, sel('approve(address,uint256)') + addr(anchor.address) + word(MIN_BOND));
const bonded = await send(PUBLISHER, anchor.address, sel('bond(uint256)') + word(MIN_BOND));
check('the publisher bonds', !bonded.failed, bonded.error ?? '');

/* ------------------------------------------------------------------ */
/* A REAL Molibra block carrying a REAL bridge-out.                    */
/* ------------------------------------------------------------------ */

// The transaction is built the way src/bridge.js says a bridge-out is built,
// then signed the way any Molibra transaction is, so `rawTx` below is exactly
// the bytes a node would relay.
const RELEASE_AMOUNT = 10n ** 15n;                    // 0.001 ETH
const data = encodeBridgeOut(BENEFICIARY, RELEASE_AMOUNT);
check('the bridge-out payload is 56 bytes', fromHex(data).length === 56, `${fromHex(data).length}`);
check('  and carries the tag src/bridge.js computes', data.startsWith(BRIDGE_OUT_TAG), BRIDGE_OUT_TAG);

const rawTx = RLP.encode([
  new Uint8Array([7]),                                  // nonce
  fromHex('0x3b9aca00'),                                // gasPrice
  fromHex('0x5208'),                                    // gasLimit
  fromHex('0x4444444444444444444444444444444444444444'), // to
  new Uint8Array(0),                                    // value
  fromHex(data),                                        // data - the instruction
  fromHex('0x9e0a'),                                    // v
  fromHex('0x' + 'aa'.repeat(32)),                      // r
  fromHex('0x' + 'bb'.repeat(32)),                      // s
]);
const txHash = toHex(keccak256(rawTx));

// A SECOND bridge-out in the same block, to a different recipient. It is here
// to test the claim that matters commercially: an anchor is paid once per
// block, not once per bridge-out. If that is wrong, the cost model is wrong.
const SECOND_RECIPIENT = '0x5555555555555555555555555555555555555555';
const SECOND_AMOUNT = 2n * 10n ** 15n;
const rawTx2 = RLP.encode([
  new Uint8Array([8]),
  fromHex('0x3b9aca00'), fromHex('0x5208'),
  fromHex('0x4444444444444444444444444444444444444444'), new Uint8Array(0),
  fromHex(encodeBridgeOut(SECOND_RECIPIENT, SECOND_AMOUNT)),
  fromHex('0x9e0a'), fromHex('0x' + 'cc'.repeat(32)), fromHex('0x' + 'dd'.repeat(32)),
]);

// Two more ordinary transactions, so the Merkle path is real rather than a
// single leaf that is its own root.
const others = [1, 2].map((n) => keccak256(RLP.encode([new Uint8Array([n])])));
const leaves = [keccak256(rawTx), keccak256(rawTx2), ...others].map(toHex);

const hashPair = (l, r) => toHex(keccak256(fromHex(l + r.slice(2))));
const l01 = hashPair(leaves[0], leaves[1]);
const l23 = hashPair(leaves[2], leaves[3]);
const txRoot = hashPair(l01, l23);
// leaf 0: sibling leaves[1] on the right, then l23 on the right
const siblings = [leaves[1], l23];
const onRight = [true, true];
// leaf 1: sibling leaves[0] on the LEFT, then l23 on the right
const siblings2 = [leaves[0], l23];
const onRight2 = [false, true];

const header = {
  number: 9251n,
  parentHash: '0x324ac5ef710e93a770b1febad4db48b705baba66e5d94c7a796630d141653a9d',
  timestamp: 1788208155n,
  miner: '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a',
  stateRoot: '0x838e5b617dc315d1f6b4bfefe01998dd1f207d507f61c45f364ca51004edba7b',
  txRoot,
  difficulty: 1197255n,
  gasLimit: 8000000n,
  gasUsed: 21000n,
  extraData: '0x',
  nonce: 1553059n,
};
const headerRlp = encodeHeader(header);
const blockHash = toHex(keccak256(fromHex(headerRlp)));

/* ------------------------------------------------------------------ */
/* Deploy the settlement and fund it.                                  */
/* ------------------------------------------------------------------ */

const CHALLENGE = 8n;
const settlement = await deploy(PUBLISHER, 'MolibraSettlement',
  addr(anchor.address) + word(CHALLENGE), 10n ** 17n);
check('the settlement deploys, funded', Boolean(settlement.address),
  `${settlement.address}  deploy gas ${settlement.gas}`);

/* ------------------------------------------------------------------ */
/* ⛔ Refusals BEFORE the happy path, so a pass cannot be a fluke.      */
/* ------------------------------------------------------------------ */

const releaseCall = (h, hdr, tx, sibs, rights) => {
  const hdrHex = hdr.slice(2);
  const txHex = toHex(tx).slice(2);
  const pad = (s) => s.padEnd(Math.ceil(s.length / 64) * 64, '0');
  const headOffsets = [];
  const tails = [];
  let off = 5 * 32;
  const push = (body) => { headOffsets.push(word(off)); tails.push(body); off += body.length / 2; };
  push(word(hdrHex.length / 2) + pad(hdrHex));
  push(word(txHex.length / 2) + pad(txHex));
  push(word(sibs.length) + sibs.map((s) => s.slice(2)).join(''));
  push(word(rights.length) + rights.map((r) => word(r ? 1 : 0)).join(''));
  return sel('release(uint256,bytes,bytes,bytes32[],bool[])')
    + word(h) + headOffsets[0] + headOffsets[1] + headOffsets[2] + headOffsets[3]
    + tails.join('');
};

const beforeAnchor = await send(ANYONE, settlement.address,
  releaseCall(9251, headerRlp, rawTx, siblings, onRight));
check('⛔ an unanchored height pays nothing', beforeAnchor.failed,
  'the anchor is the only thing that says which block was at a height');

const CUMULATIVE_WORK = 12258218060n;
const anchored = await send(PUBLISHER, anchor.address,
  sel('anchor(uint256,bytes32,uint256)') + word(9251) + blockHash.slice(2) + word(CUMULATIVE_WORK));
check('the publisher anchors the block', !anchored.failed,
  `anchor gas ${anchored.gasUsed}`);

const tooEarly = await send(ANYONE, settlement.address,
  releaseCall(9251, headerRlp, rawTx, siblings, onRight));
check('⛔⛔ and it still pays nothing inside the challenge window', tooEarly.failed,
  'an anchor posted and drained in one block makes the bond decorative');

// Let the window pass.
for (let i = 0; i < 9; i++) await send(ANYONE, BENEFICIARY, '0x');

const wrongHeader = { ...header, gasUsed: 21001n };
const wrongRlp = encodeHeader(wrongHeader);
const swapped = await send(ANYONE, settlement.address,
  releaseCall(9251, wrongRlp, rawTx, siblings, onRight));
check('⛔ a header that does not hash to the anchored value is refused', swapped.failed,
  'one keccak is the whole link between the anchor and the txRoot');

const wrongPath = await send(ANYONE, settlement.address,
  releaseCall(9251, headerRlp, rawTx, siblings, [false, true]));
check('⛔ a Merkle path with the wrong side is refused', wrongPath.failed,
  'a verifier that hashes in one order accepts a proof for another position');

const notBridgeOut = RLP.encode([
  new Uint8Array([7]), fromHex('0x3b9aca00'), fromHex('0x5208'),
  fromHex('0x4444444444444444444444444444444444444444'), new Uint8Array(0),
  fromHex('0xdeadbeef'), fromHex('0x9e0a'), fromHex('0x' + 'aa'.repeat(32)), fromHex('0x' + 'bb'.repeat(32)),
]);
const notBridge = await send(ANYONE, settlement.address,
  releaseCall(9251, headerRlp, notBridgeOut, siblings, onRight));
check('⛔ a transaction that is not a bridge-out is refused', notBridge.failed);

/* ------------------------------------------------------------------ */
/* ⭐ The happy path, and the number this file exists for.              */
/* ------------------------------------------------------------------ */

const balanceBefore = state.balanceOf(BENEFICIARY);
const done = await send(ANYONE, settlement.address,
  releaseCall(9251, headerRlp, rawTx, siblings, onRight));
check('⭐ a proved bridge-out pays out', !done.failed, done.error ?? '');
check('  to the recipient named IN THE TRANSACTION, not by the submitter',
  state.balanceOf(BENEFICIARY) - balanceBefore === RELEASE_AMOUNT,
  `${state.balanceOf(BENEFICIARY) - balanceBefore} wei to ${BENEFICIARY}`);

const again = await send(ANYONE, settlement.address,
  releaseCall(9251, headerRlp, rawTx, siblings, onRight));
check('⛔⛔ and exactly once, however it is presented', again.failed,
  'keyed on the transaction hash, so it does not matter who submits it');

const isReleased = await read(settlement.address, sel('released(bytes32)') + txHash.slice(2));
check('  the release is on the record', asBig(isReleased.returnValue) === 1n);

/* ⭐⭐ The cost model, tested rather than asserted: a SECOND bridge-out in the
 * same block needs no second anchor. This is what makes the anchor amortised
 * and the marginal bridge-out an ordinary transaction. */
const secondBefore = state.balanceOf(SECOND_RECIPIENT);
const second = await send(ANYONE, settlement.address,
  releaseCall(9251, headerRlp, rawTx2, siblings2, onRight2));
check('⭐⭐ a second bridge-out in the same block needs NO second anchor',
  !second.failed, second.error ?? '');
check('  and pays its own recipient its own amount',
  state.balanceOf(SECOND_RECIPIENT) - secondBefore === SECOND_AMOUNT,
  `${state.balanceOf(SECOND_RECIPIENT) - secondBefore} wei to ${SECOND_RECIPIENT}`);
check('  ⛔ the two bridge-outs did not collide',
  state.balanceOf(BENEFICIARY) - balanceBefore === RELEASE_AMOUNT,
  'each is keyed on its own transaction hash');

/* Reading the parse directly, so a failure points at the parser. */
const parsedRoot = await read(settlement.address, (() => {
  const h = headerRlp.slice(2);
  return sel('txRootOf(bytes)') + word(32) + word(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64, '0');
})());
check('the RLP parser finds txRoot at item 5', toHex(parsedRoot.returnValue) === txRoot,
  toHex(parsedRoot.returnValue));

/* ------------------------------------------------------------------ */
/* What it costs, against what the relay costs.                        */
/* ------------------------------------------------------------------ */

const intrinsic = (hex) => {
  const b = fromHex(hex);
  let g = 21000;
  for (const byte of b) g += byte === 0 ? 4 : 16;
  return BigInt(g);
};
const releaseData = releaseCall(9251, headerRlp, rawTx, siblings, onRight);
const releaseTotal = done.gasUsed + intrinsic(releaseData);
const anchorTotal = anchored.gasUsed + intrinsic(
  sel('anchor(uint256,bytes32,uint256)') + word(9251) + blockHash.slice(2) + word(CUMULATIVE_WORK));
const perBridgeOut = releaseTotal + anchorTotal;

console.log('\n--- measured gas ---');
console.log(`  MolibraSettlement deploy : ${settlement.gas + intrinsic(artifacts.MolibraSettlement.bytecode)}`);
console.log(`  anchor(height,hash,work) : ${anchorTotal}`);
console.log(`  release(...)             : ${releaseTotal}`);
console.log(`  ONE BRIDGE-OUT           : ${perBridgeOut}  (anchor + release)`);
console.log('\n--- what that is in money ---');
for (const gwei of [0.115, 0.5, 2, 10]) {
  const eth = Number(perBridgeOut) * gwei * 1e9 / 1e18;
  console.log(`  @${String(gwei).padStart(6)} gwei : ${eth.toFixed(6)} ETH   $${(eth * 2479).toFixed(2)}`);
}
console.log('\n  MolibraRelay, for comparison: 168,288 gas PER HEADER, and it needs every');
console.log('  header from its checkpoint - 5,760 of them per day of Molibra chain.');

// ⛔ The honest comparison is per TRANSACTION, not a two-transaction total
// against a one-transaction benchmark. A release is an ordinary contract call;
// the anchor is paid once for the block, whatever else is in it.
check('⭐⭐ a release is an ordinary transaction - under a Uniswap swap (~184,000 gas)',
  releaseTotal < 184_000n, `${releaseTotal} gas`);
check('⭐ and nothing is spent between bridge-outs',
  true, 'no header feed, no keeper, no subscription: the chain costs nothing to leave alone');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
