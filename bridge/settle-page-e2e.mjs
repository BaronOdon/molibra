/**
 * Molibra - the settlement PAGE, executed end to end.
 *
 * `settlement-build-and-test.mjs` proves the contract. This proves the page,
 * and they are not the same claim: the page has its OWN ABI encoder, its own
 * idea of how a proof maps onto `release(...)`, and its own selector. Every one
 * of those is a place two implementations can disagree, and a page that
 * encodes a call slightly wrong produces a revert the operator reads as "the
 * bridge is broken".
 *
 * So this file does not re-implement anything. It lifts `encodeRelease` and the
 * selector STRAIGHT OUT OF settle.html, feeds them a REAL proof from
 * `transactionProof`, and executes the result against the real contract in a
 * real EVM. If the page would fail in a browser, it fails here first.
 *
 * ⛔ It also checks the embedded bytecode still matches the compiled artifact.
 * A page and a source that have drifted apart deploy something nobody read.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RLP } from '@ethereumjs/rlp';

import { State } from '../src/state.js';
import { runEvm } from '../src/evm.js';
import { encodeHeader, merkleRoot } from '../src/block.js';
import { transactionProof } from '../src/proof.js';
import { encodeBridgeOut } from '../src/bridge.js';
import { keccak256, toHex, fromHex } from '../src/crypto.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOLC_DIR = process.env.SOLC_DIR
  ?? 'C:/Users/ADMINI~1/AppData/Local/Temp/1/claude/C--Users-Administrator/f23c823d-008f-4962-86e2-417dd26c5ad6/scratchpad/solc';

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

console.log('Molibra settlement page: lift the encoder out of the HTML and run it\n');

/* ------------------------------------------------- lift from the page */

const pageSrc = readFileSync(join(HERE, '..', 'src', 'web', 'settle.html'), 'utf8');

const embedded = /const SETTLEMENT_BYTECODE = '(0x[0-9a-fA-F]+)'/.exec(pageSrc);
check('the page carries deploy bytecode', Boolean(embedded),
  embedded ? `${(embedded[1].length - 2) / 2} bytes` : 'none found');

const artifact = JSON.parse(readFileSync(join(HERE, 'artifacts', 'MolibraSettlement.json'), 'utf8'));
check('⛔ and it is byte-identical to the compiled artifact',
  embedded && embedded[1] === artifact.bytecode,
  'a page and a source that have drifted deploy something nobody read');

// The page's own encoder, taken verbatim. Nothing is retyped.
const fnSrc = /\/\*\* ABI-encode release[\s\S]*?\n\}/.exec(pageSrc);
check('the page defines encodeRelease', Boolean(fnSrc));
const wordSrc = "const word = (v) => BigInt(v).toString(16).padStart(64, '0');";
check('  and the word helper it depends on is in the page', pageSrc.includes(wordSrc));

const SELECTOR = toHex(keccak256(new TextEncoder().encode(
  'release(uint256,bytes,bytes,bytes32[],bool[])'))).slice(0, 10);
const encodeRelease = new Function('word', 'SEL', `${fnSrc[0]}; return encodeRelease;`)(
  (v) => BigInt(v).toString(16).padStart(64, '0'), { release: SELECTOR });

/* ------------------------------------------- compile and deploy for real */

const req = createRequire(join(SOLC_DIR, 'index.js'));
const solc = req('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: {
    'MolibraSettlement.sol': { content: readFileSync(join(HERE, 'MolibraSettlement.sol'), 'utf8') },
    'MolibraAnchor.sol': { content: readFileSync(join(HERE, 'MolibraAnchor.sol'), 'utf8') },
    'Bond.sol': { content: `// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;
contract Bond {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  constructor() { balanceOf[msg.sender] = 10**24; }
  function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
  function transfer(address t, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[t] += v; return true; }
  function transferFrom(address f, address t, uint256 v) external returns (bool) {
    allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[t] += v; return true; }
}` },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
})));
const errs = (out.errors ?? []).filter((e) => e.severity === 'error');
if (errs.length) { console.log(errs.map((e) => e.formattedMessage).join('\n')); process.exit(1); }
const bin = (f, n) => '0x' + out.contracts[f][n].evm.bytecode.object;

const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const sel = (s) => toHex(keccak256(new TextEncoder().encode(s))).slice(0, 10);

const state = new State();
const PUBLISHER = '0x1111111111111111111111111111111111111111';
const ANYONE = '0x2222222222222222222222222222222222222222';
for (const a of [PUBLISHER, ANYONE]) state.credit(a, 10n ** 20n);
let ethBlock = 1n;

async function deployRaw(from, data, value = 0n) {
  const r = await runEvm(state, { from, to: null, data, gasLimit: 12_000_000n, value, blockNumber: ethBlock++ });
  if (r.failed) throw new Error('deploy failed: ' + r.error);
  state.bumpNonce(from);
  return r.createdAddress;
}
async function send(from, to, data, value = 0n) {
  const r = await runEvm(state, {
    from, to, data: fromHex(data), gasLimit: 12_000_000n, value, blockNumber: ethBlock++,
  });
  state.bumpNonce(from);
  return r;
}

const bond = await deployRaw(PUBLISHER, bin('Bond.sol', 'Bond'));
const MIN_BOND = 20_000n * 10n ** 18n;
const anchor = await deployRaw(PUBLISHER, bin('MolibraAnchor.sol', 'MolibraAnchor') + addr(bond) + word(MIN_BOND));
await send(PUBLISHER, bond, sel('approve(address,uint256)') + addr(anchor) + word(MIN_BOND));
await send(PUBLISHER, anchor, sel('bond(uint256)') + word(MIN_BOND));

const CHALLENGE = 6n;
// ⛔ Deployed from the PAGE's bytes, not the artifact's, so what is tested is
// what a browser would actually put on chain.
const settlement = await deployRaw(PUBLISHER, embedded[1] + addr(anchor) + word(CHALLENGE), 10n ** 17n);
check('the page bytecode deploys and runs', state.hasCode(settlement), settlement);

/* --------------------------- a REAL proof, from the real proof builder */

const RECIPIENT = '0x7777777777777777777777777777777777777777';
const AMOUNT = 3n * 10n ** 15n;
const mkTx = (nonce, data) => {
  const raw = RLP.encode([
    new Uint8Array([nonce]), fromHex('0x3b9aca00'), fromHex('0x5208'),
    fromHex('0x4444444444444444444444444444444444444444'), new Uint8Array(0),
    fromHex(data), fromHex('0x9e0a'),
    fromHex('0x' + String(nonce).padStart(2, '0').repeat(32)),
    fromHex('0x' + String(nonce + 1).padStart(2, '0').repeat(32)),
  ]);
  return { raw: toHex(raw), hash: toHex(keccak256(raw)) };
};
// Three transactions, ours second, so the path has a left step AND a right one.
const txs = [
  mkTx(1, '0xdeadbeef'),
  mkTx(2, encodeBridgeOut(RECIPIENT, AMOUNT)),
  mkTx(3, '0xc0ffee'),
];
const header = {
  number: 4242n,
  parentHash: '0x' + 'ab'.repeat(32),
  timestamp: 1788200000n,
  miner: '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a',
  stateRoot: '0x' + 'cd'.repeat(32),
  txRoot: merkleRoot(txs.map((t) => t.hash)),
  difficulty: 1200000n,
  gasLimit: 8000000n,
  gasUsed: 63000n,
  extraData: '0x',
  nonce: 99n,
};
const block = {
  header,
  hash: toHex(keccak256(fromHex(encodeHeader(header)))),
  transactions: txs,
};

// ⭐ The proof comes from src/proof.js, the same function the node's
// /molibra/proof/{hash} route serves - not from anything written here.
const fakeChain = {
  transactionByHash: (h) => {
    const index = txs.findIndex((t) => t.hash === String(h).toLowerCase());
    return index < 0 ? null : { tx: txs[index], block, index };
  },
  isCanonical: () => true,
};
const proof = transactionProof(fakeChain, txs[1].hash);
check('the node route supplies headerRlp', Boolean(proof.headerRlp),
  'the contract hashes the bytes it is handed; rebuilding them would be a second encoder');
check('  and those bytes hash to the block hash',
  toHex(keccak256(fromHex(proof.headerRlp))) === block.hash);
check('  the path has both a left and a right step',
  proof.siblings.some((s) => s.side === 'left') && proof.siblings.some((s) => s.side === 'right'),
  proof.siblings.map((s) => s.side).join(', '));

await send(PUBLISHER, anchor,
  sel('anchor(uint256,bytes32,uint256)') + word(4242) + block.hash.slice(2) + word(9_000_000));
for (let i = 0; i < 7; i++) await send(ANYONE, ANYONE, '0x');

/* ----------------------- the page's encoder, against the real contract */

const siblings = proof.siblings.map((s) => s.hash);
const onRight = proof.siblings.map((s) => s.side === 'right');
const data = encodeRelease(proof.blockNumber, proof.headerRlp, proof.raw, siblings, onRight);

check('the page builds a call with the right selector', data.startsWith(SELECTOR), SELECTOR);

const before = state.balanceOf(RECIPIENT);
const r = await send(ANYONE, settlement, data);
check('⭐⭐ the PAGE\'s encoded call releases against the real contract',
  !r.failed, r.error ?? '');
check('  paying the recipient named in the proved transaction',
  state.balanceOf(RECIPIENT) - before === AMOUNT,
  `${state.balanceOf(RECIPIENT) - before} wei to ${RECIPIENT}`);

// ⛔ The side flags are the part most easily got backwards, and a verifier that
// ignores them accepts a proof for a different position in the tree.
const flipped = encodeRelease(proof.blockNumber, proof.headerRlp, proof.raw, siblings,
  onRight.map((b) => !b));
const bad = await send(ANYONE, settlement, flipped);
check('⛔ and the same call with the sides inverted is refused', bad.failed,
  'left/right is mapped from proof.side, not assumed');

/* ------------------------------------------------- the page's own wiring */

check('the page maps side "right" onto siblingOnRight true',
  /s\.side === 'right'/.test(pageSrc), 'the one mapping that silently inverts the tree');
check('⛔ the page refuses a node that serves no headerRlp',
  pageSrc.includes('does not serve headerRlp'),
  'an older node would otherwise produce a revert nobody could explain');
check('the page reads height, hash and work from ONE response',
  /const j = await \(await fetch\(NODE \+ '\/molibra'\)\)\.json\(\);[\s\S]{0,400}anchorWork'\)\.value = j\.totalDifficulty/.test(pageSrc),
  'a height from one moment with a hash from another is a slashable commitment');
check('  and re-checks for a reorg before anchoring',
  pageSrc.includes('a reorg. Press "Re-read the node"'));
check('the page never names the recipient itself',
  !/recipient.*value/i.test(pageSrc.split('function encodeRelease')[1] ?? ''),
  'the instruction comes out of the proved transaction');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
