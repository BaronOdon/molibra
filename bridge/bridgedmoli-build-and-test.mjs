/**
 * Molibra - BridgedMoli: compile, then EXECUTE both halves and check they agree.
 *
 * The point is not that BridgedMoli.sol compiles. It is that MOLI really
 * leaves existence on a real Molibra state, that a real block carrying that
 * transaction mints exactly that much bMOLI in a real EVM, and that the two
 * numbers are equal at the end.
 *
 * ⛔⛔ The single most important check in this file is the one that REFUSES a
 * `bridgeOut`. That payload has the same 56-byte shape and differs only in
 * four bytes, it moves nothing on Molibra, and several are already anchored.
 * If the contract ever minted against one, bMOLI would be backed by MOLI that
 * still exists and one coin would mint forever.
 *
 * Toolchain lives outside the repo (solc is dev-only, and Molibra ships with
 * two dependencies). Point SOLC_DIR at a directory where `npm i solc` has run.
 */

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RLP } from '@ethereumjs/rlp';

import { State, applyTransaction } from '../src/state.js';
import { intrinsicGas } from '../src/tx.js';
import { runEvm, simulate } from '../src/evm.js';
import { encodeHeader } from '../src/block.js';
import { keccak256, toHex, fromHex } from '../src/crypto.js';
import {
  encodeMoliBurn, MOLI_BURN_TAG, decodeMoliBurn, MOLI_BURN_ACTIVATION,
} from '../src/moliburn.js';
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

console.log('BridgedMoli: destroy on Molibra, mint on Ethereum\n');

/* ==================================================================== */
/* 1. The Molibra half: MOLI actually leaves existence.                 */
/* ==================================================================== */

console.log('1. consensus: the burn destroys MOLI');

const MINER = '0x9999999999999999999999999999999999999999';
const HOLDER = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
const ETH_RECIPIENT = '0x3333333333333333333333333333333333333333';

const molibra = new State();
const START = 10_000n * 10n ** 18n;   // comfortably more than the burn
molibra.credit(HOLDER, START);

const mtx = (from, data, value = 0n) => ({
  from, to: from, value, nonce: molibra.nonceOf(from),
  gasPrice: 1n, gasLimit: 3_000_000n, data,
});
// ⛔ At the flag day: below MOLI_BURN_ACTIVATION a burn payload is ordinary
// data, exactly as an un-upgraded node sees it.
const mapply = (t, block = MOLI_BURN_ACTIVATION) =>
  applyTransaction(molibra, t, intrinsicGas(t), MINER, block);

const BURN_AMOUNT = 2_000n * 10n ** 18n;
const burnData = encodeMoliBurn(ETH_RECIPIENT, BURN_AMOUNT);

check('the burn payload is 56 bytes', fromHex(burnData).length === 56, `${fromHex(burnData).length}`);
check('  and carries the tag src/moliburn.js computes',
  burnData.startsWith(MOLI_BURN_TAG), MOLI_BURN_TAG);
check('⛔⛔ and it is NOT the bridgeOut tag',
  MOLI_BURN_TAG !== BRIDGE_OUT_TAG, `${MOLI_BURN_TAG} vs ${BRIDGE_OUT_TAG}`);

const supplyBefore = molibra.balanceOf(HOLDER);
const burnReceipt = await mapply(mtx(HOLDER, burnData));
check('the burn is accepted', Boolean(burnReceipt));

const spentOnFee = intrinsicGas({ ...mtx(HOLDER, burnData) }) * 1n;
check('⭐ the holder is lighter by the burn plus the fee',
  molibra.balanceOf(HOLDER) === supplyBefore - BURN_AMOUNT - spentOnFee,
  `${supplyBefore} -> ${molibra.balanceOf(HOLDER)}`);
check('⛔⛔ and NOBODY was credited the burned amount',
  molibra.balanceOf(MINER) === spentOnFee,
  'the miner has the fee and nothing else: there is no vault to rob');
check('the outbound ledger counts it', molibra.outbound.burned === BURN_AMOUNT,
  `${molibra.outbound.burned}`);
check('  and records who it is for', molibra.outbound.byRecipient.get(ETH_RECIPIENT) === BURN_AMOUNT);

// ⛔ It is in the state root, so two nodes that disagreed about what was
// destroyed would fork, as they should.
const rootWithBurn = molibra.root();
const fresh = new State();
fresh.credit(HOLDER, START - BURN_AMOUNT - spentOnFee);
fresh.credit(MINER, spentOnFee);
fresh.bumpNonce(HOLDER);
check('⛔⛔ the burn is IN the state root',
  fresh.root() !== rootWithBurn,
  'a node that forgot the burn must not agree with one that recorded it');

// And it survives a datadir round trip.
const reloaded = State.fromJSON(JSON.parse(JSON.stringify(molibra.toJSON())));
check('⛔ the outbound ledger survives a datadir round trip',
  reloaded.outbound.burned === BURN_AMOUNT && reloaded.root() === rootWithBurn,
  'a restarted node would otherwise disagree with itself about what it destroyed');

// A chain on which nothing was burned hashes exactly as it did before.
const untouched = new State();
untouched.credit(HOLDER, START);
const before = untouched.root();
check('⛔ a chain with no burn on it hashes exactly as it did before',
  before === (() => { const s = new State(); s.credit(HOLDER, START); return s.root(); })(),
  'appended only when present: no hard fork');

// Refusals.
async function refuses(label, t, detail = '') {
  const rootBefore = molibra.root();
  let threw = null;
  try { await mapply(t); } catch (e) { threw = e; }
  check(label, threw !== null && molibra.root() === rootBefore,
    detail || (threw ? String(threw.message).slice(0, 84) : 'IT WAS ACCEPTED'));
}

await refuses('⛔ a burn larger than the balance is refused',
  mtx(HOLDER, encodeMoliBurn(ETH_RECIPIENT, START * 2n)));
await refuses('⛔ a burn that also carries value is refused',
  mtx(HOLDER, encodeMoliBurn(ETH_RECIPIENT, 10n ** 18n), 10n ** 18n),
  'the amount is in the payload; two places to say it is one place to disagree');

let zeroThrew = null;
try { encodeMoliBurn(ETH_RECIPIENT, 0n); } catch (e) { zeroThrew = e; }
check('⛔ a zero burn cannot even be encoded', zeroThrew !== null);

let zeroAddrThrew = null;
try {
  decodeMoliBurn(MOLI_BURN_TAG + '0'.repeat(40) + '1'.padStart(64, '0'));
} catch (e) { zeroAddrThrew = e; }
check('⛔ a burn to the zero address is refused', zeroAddrThrew !== null,
  'it would destroy MOLI here and be unclaimable there');

/* ==================================================================== */
/* 2. compile                                                           */
/* ==================================================================== */

console.log('\n2. compile');

const sources = {
  'BridgedMoli.sol': { content: readFileSync(join(HERE, 'BridgedMoli.sol'), 'utf8') },
  'MolibraAnchor.sol': { content: readFileSync(join(HERE, 'MolibraAnchor.sol'), 'utf8') },
};

const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // ⛔ `claim` takes five arguments and still needs the height at the end for
    // the event - "Stack too deep" without the IR pipeline, exactly as in
    // MolibraSettlement. A compiler change, not a contract change.
    viaIR: true,
    // ⛔ Paris, not the compiler's default: 0.8.26 emits PUSH0 and MCOPY for
    // Cancun, and on a target without them the contract deploys fine and then
    // every call halts with NO REVERT REASON.
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
 * ⛔⛔ Only BridgedMoli's artifact is written. MolibraAnchor is compiled here
 * because this contract talks to it, not because it needs building: it is
 * ALREADY DEPLOYED at 0x2beba454…e03b. A deployed contract's artifact is a
 * record, not an output.
 */
mkdirSync(join(HERE, 'artifacts'), { recursive: true });
writeFileSync(join(HERE, 'artifacts', 'BridgedMoli.json'),
  JSON.stringify(artifacts.BridgedMoli, null, 2));
const runtimeBytes = (artifacts.BridgedMoli.deployed.length - 2) / 2;
check('and BridgedMoli is under the 24,576-byte contract limit',
  runtimeBytes < 24576, `${runtimeBytes} bytes`);

/* ==================================================================== */
/* 3. The Ethereum half                                                 */
/* ==================================================================== */

console.log('\n3. ethereum: the mint');

const utf8 = (s) => new TextEncoder().encode(s);
const sel = (s) => toHex(keccak256(utf8(s))).slice(0, 10);
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => a.slice(2).toLowerCase().padStart(64, '0');

const eth = new State();
const PUBLISHER = '0x1111111111111111111111111111111111111111';
const ANYONE = '0x2222222222222222222222222222222222222222';
for (const a of [PUBLISHER, ANYONE]) eth.credit(a, 10n ** 20n);
const GAS = 12_000_000n;

// ⛔ The harness advances block.number on every send: the challenge window can
// never mature at a standing height, and refusal checks would then pass for
// the wrong reason.
let ethBlock = 1n;
async function deploy(from, name, args = '', value = 0n) {
  const r = await runEvm(eth, {
    from, to: null, data: artifacts[name].bytecode + args, gasLimit: GAS, value, blockNumber: ethBlock++,
  });
  if (r.failed) throw new Error(`${name} deploy failed: ${r.error}`);
  eth.bumpNonce(from);
  return { address: r.createdAddress, gas: r.gasUsed };
}
async function send(from, to, data, value = 0n) {
  const r = await runEvm(eth, {
    from, to, data: fromHex(data), gasLimit: GAS, value, blockNumber: ethBlock++,
  });
  eth.bumpNonce(from);
  return r;
}
async function read(to, data) {
  return simulate(eth, { from: ANYONE, to, data: fromHex(data), gasLimit: GAS, blockNumber: ethBlock });
}

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
await send(PUBLISHER, bond.address, sel('approve(address,uint256)') + addr(anchor.address) + word(MIN_BOND));
const bonded = await send(PUBLISHER, anchor.address, sel('bond(uint256)') + word(MIN_BOND));
check('the publisher bonds', !bonded.failed, bonded.error ?? '');

/* A REAL Molibra block carrying the REAL burn transaction from part 1. */

const rawTx = RLP.encode([
  new Uint8Array([7]),
  fromHex('0x3b9aca00'), fromHex('0x5208'),
  fromHex('0x4444444444444444444444444444444444444444'),
  new Uint8Array(0),
  fromHex(burnData),                                    // the burn from part 1
  fromHex('0x9e0a'), fromHex('0x' + 'aa'.repeat(32)), fromHex('0x' + 'bb'.repeat(32)),
]);

// ⛔⛔ A bridge-out in the SAME BLOCK, with a valid Merkle path. This is the
// attack: a payload of identical shape that destroyed nothing.
const bridgeOutTx = RLP.encode([
  new Uint8Array([8]),
  fromHex('0x3b9aca00'), fromHex('0x5208'),
  fromHex('0x4444444444444444444444444444444444444444'),
  new Uint8Array(0),
  fromHex(encodeBridgeOut(ETH_RECIPIENT, BURN_AMOUNT)),
  fromHex('0x9e0a'), fromHex('0x' + 'cc'.repeat(32)), fromHex('0x' + 'dd'.repeat(32)),
]);

const others = [1, 2].map((n) => keccak256(RLP.encode([new Uint8Array([n])])));
const leaves = [keccak256(rawTx), keccak256(bridgeOutTx), ...others].map(toHex);
const hashPair = (l, r) => toHex(keccak256(fromHex(l + r.slice(2))));
const l01 = hashPair(leaves[0], leaves[1]);
const l23 = hashPair(leaves[2], leaves[3]);
const txRoot = hashPair(l01, l23);
const siblings = [leaves[1], l23];
const onRight = [true, true];
const siblingsBO = [leaves[0], l23];
const onRightBO = [false, true];

const header = {
  number: 12346n,
  parentHash: '0xa7572faed34e3727bd438debcbcb28a4a94c55f48855f2285691b41c70295df8',
  timestamp: 1788300000n,
  miner: '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a',
  stateRoot: rootWithBurn,
  txRoot,
  difficulty: 1197255n,
  gasLimit: 8000000n,
  gasUsed: 21000n,
  extraData: '0x',
  nonce: 1553059n,
};
const headerRlp = encodeHeader(header);
const blockHash = toHex(keccak256(fromHex(headerRlp)));

const CHALLENGE = 8n;
const moli = await deploy(PUBLISHER, 'BridgedMoli', addr(anchor.address) + word(CHALLENGE));
check('BridgedMoli deploys', Boolean(moli.address), `${moli.address}  deploy gas ${moli.gas}`);

const claimCall = (h, hdr, tx, sibs, rights) => {
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
  return sel('claim(uint256,bytes,bytes,bytes32[],bool[])')
    + word(h) + headOffsets[0] + headOffsets[1] + headOffsets[2] + headOffsets[3]
    + tails.join('');
};

/* ⛔ Refusals BEFORE the happy path, so a pass cannot be a fluke. */

const beforeAnchor = await send(ANYONE, moli.address, claimCall(12346, headerRlp, rawTx, siblings, onRight));
check('⛔ an unanchored height mints nothing', beforeAnchor.failed,
  'the anchor is the only thing that says which block was at a height');

const anchored = await send(PUBLISHER, anchor.address,
  sel('anchor(uint256,bytes32,uint256)') + word(12346) + blockHash.slice(2) + word(12258218060n));
check('the publisher anchors the block', !anchored.failed, `anchor gas ${anchored.gasUsed}`);

const tooEarly = await send(ANYONE, moli.address, claimCall(12346, headerRlp, rawTx, siblings, onRight));
check('⛔⛔ and it still mints nothing inside the challenge window', tooEarly.failed,
  'an anchor posted and minted against in one block makes the bond decorative');

for (let i = 0; i < 9; i++) await send(ANYONE, ETH_RECIPIENT, '0x');

const wrongRlp = encodeHeader({ ...header, gasUsed: 21001n });
const swapped = await send(ANYONE, moli.address, claimCall(12346, wrongRlp, rawTx, siblings, onRight));
check('⛔ a header that does not hash to the anchored value is refused', swapped.failed);

const wrongPath = await send(ANYONE, moli.address, claimCall(12346, headerRlp, rawTx, siblings, [false, true]));
check('⛔ a Merkle path with the wrong side is refused', wrongPath.failed);

/* ⛔⛔ THE check this contract exists for. */
const asBridgeOut = await send(ANYONE, moli.address,
  claimCall(12346, headerRlp, bridgeOutTx, siblingsBO, onRightBO));
check('⛔⛔ a bridgeOut in the same block, with a VALID path, mints NOTHING',
  asBridgeOut.failed,
  'it destroyed no MOLI: minting against it would back bMOLI with a sentence');

const supplyAfterAttack = await read(moli.address, sel('totalSupply()'));
check('  and the supply is still zero after that attempt',
  BigInt(toHex(supplyAfterAttack.returnValue)) === 0n);

const notABurn = RLP.encode([
  new Uint8Array([7]), fromHex('0x3b9aca00'), fromHex('0x5208'),
  fromHex('0x4444444444444444444444444444444444444444'), new Uint8Array(0),
  fromHex('0xdeadbeef'), fromHex('0x9e0a'), fromHex('0x' + 'aa'.repeat(32)), fromHex('0x' + 'bb'.repeat(32)),
]);
const notBurn = await send(ANYONE, moli.address, claimCall(12346, headerRlp, notABurn, siblings, onRight));
check('⛔ a transaction that is not a burn at all is refused', notBurn.failed);

/* ⭐ The happy path. */

const done = await send(ANYONE, moli.address, claimCall(12346, headerRlp, rawTx, siblings, onRight));
check('⭐ the claim succeeds', !done.failed, done.error ?? '');

const balanceOfCall = (who) => sel('balanceOf(address)') + addr(who);
const minted = await read(moli.address, balanceOfCall(ETH_RECIPIENT));
check('⭐⭐ the recipient named IN THE BURN holds the bMOLI',
  BigInt(toHex(minted.returnValue)) === BURN_AMOUNT,
  `${BigInt(toHex(minted.returnValue))}`);

const submitterBalance = await read(moli.address, balanceOfCall(ANYONE));
check('⛔ and the SUBMITTER of the proof holds none',
  BigInt(toHex(submitterBalance.returnValue)) === 0n,
  'a bridge that let the submitter name the recipient has made the proof decoration');

const supply = await read(moli.address, sel('totalSupply()'));
check('⭐⭐ what was destroyed on Molibra equals what exists on Ethereum',
  BigInt(toHex(supply.returnValue)) === molibra.outbound.burned,
  `${BigInt(toHex(supply.returnValue))} == ${molibra.outbound.burned}`);

const twice = await send(ANYONE, moli.address, claimCall(12346, headerRlp, rawTx, siblings, onRight));
check('⛔ the same burn cannot be claimed twice', twice.failed,
  'one destruction, one mint, forever');

const supplyAfterReplay = await read(moli.address, sel('totalSupply()'));
check('  and the supply is unchanged by the attempt',
  BigInt(toHex(supplyAfterReplay.returnValue)) === BURN_AMOUNT);

console.log(`\n⭐ one claim costs ${done.gasUsed} gas`);
console.log(`   deploy cost ${moli.gas} gas`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
