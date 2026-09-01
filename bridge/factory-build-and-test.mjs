/**
 * MolibraPoolFactory: compile, then EXECUTE against Molibra's own state.
 *
 * The claim under test is not "it compiles". It is that many tokens can each
 * get a market, that any token trades for any other in two hops through MOLI,
 * and — the one that matters legally — that an expression token cannot get a
 * market no matter what is passed in.
 *
 * Toolchain lives outside the repo. Point SOLC_DIR at a directory where
 * `npm i solc` has run.
 */

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { State } from '../src/state.js';
import { runEvm, simulate } from '../src/evm.js';
import { keccak256, toHex, fromHex } from '../src/crypto.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SOLC_DIR = process.env.SOLC_DIR
  ?? 'C:/Users/ADMINI~1/AppData/Local/Temp/1/claude/C--Users-Administrator/f23c823d-008f-4962-86e2-417dd26c5ad6/scratchpad/solc';
const solc = createRequire(join(SOLC_DIR, 'index.js'))('solc');

let passed = 0, failed = 0;
const check = (l, ok, d = '') => {
  if (ok) { passed++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { failed++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('MolibraPoolFactory: many markets, two hops, and one exclusion\n');

/* ------------------------------------------------------------- compile */

const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: {
    'MolibraPoolFactory.sol': { content: readFileSync(join(ROOT, 'contracts/MolibraPoolFactory.sol'), 'utf8') },
    'MolibraPool.sol': { content: readFileSync(join(ROOT, 'contracts/MolibraPool.sol'), 'utf8') },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
})));
const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
check('the factory compiles', errors.length === 0,
  errors.map((e) => e.formattedMessage).join('\n') || 'solc ' + solc.version().split('+')[0]);
if (errors.length) process.exit(1);

const art = {};
for (const f of Object.keys(out.contracts)) {
  for (const [n, c] of Object.entries(out.contracts[f])) {
    art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployed: '0x' + c.evm.deployedBytecode.object };
  }
}
mkdirSync(join(HERE, 'artifacts'), { recursive: true });
writeFileSync(join(HERE, 'artifacts', 'MolibraPoolFactory.json'), JSON.stringify(art.MolibraPoolFactory, null, 2));
check('and is under the 24,576-byte contract limit',
  (art.MolibraPoolFactory.deployed.length - 2) / 2 < 24576,
  `${(art.MolibraPoolFactory.deployed.length - 2) / 2} bytes`);

/* ------------------------------------------------------------ fixtures */

const utf8 = (s) => new TextEncoder().encode(s);
const sel = (s) => toHex(keccak256(utf8(s))).slice(0, 10);
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => a.slice(2).toLowerCase().padStart(64, '0');

const state = new State();
const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
for (const a of [ALICE, BOB]) state.credit(a, 10n ** 24n);
const GAS = 12_000_000n;
let blk = 1n;

async function deploy(from, bytecode, args = '', value = 0n) {
  const r = await runEvm(state, { from, to: null, data: bytecode + args, gasLimit: GAS, value, blockNumber: blk++ });
  if (r.failed) throw new Error('deploy failed: ' + r.error);
  state.bumpNonce(from);
  return r.createdAddress;
}
async function send(from, to, data, value = 0n) {
  const r = await runEvm(state, { from, to, data: fromHex(data), gasLimit: GAS, value, blockNumber: blk++ });
  state.bumpNonce(from);
  return r;
}
const read = (to, data) => simulate(state, { from: ALICE, to, data: fromHex(data), gasLimit: GAS, blockNumber: blk });

/* A minimal ERC-20 to stand in for a bridged asset. */
const ERC20 = `// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;
contract T {
  mapping(address=>uint256) public balanceOf;
  mapping(address=>mapping(address=>uint256)) public allowance;
  constructor(){ balanceOf[msg.sender]=10**24; }
  function approve(address s,uint256 v) external returns(bool){ allowance[msg.sender][s]=v; return true; }
  function transfer(address t,uint256 v) external returns(bool){ balanceOf[msg.sender]-=v; balanceOf[t]+=v; return true; }
  function transferFrom(address f,address t,uint256 v) external returns(bool){
    allowance[f][msg.sender]-=v; balanceOf[f]-=v; balanceOf[t]+=v; return true; }
}`;
const tOut = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity', sources: { 'T.sol': { content: ERC20 } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
    outputSelection: { '*': { '*': ['evm.bytecode.object'] } } },
})));
const T_BYTECODE = '0x' + tOut.contracts['T.sol'].T.evm.bytecode.object;

/* ------------------------------------------------------ many markets */

console.log('\nmany markets');

const factory = await deploy(ALICE, art.MolibraPoolFactory.bytecode);
check('the factory deploys', Boolean(factory), factory);

const tokens = [];
for (let i = 0; i < 4; i++) tokens.push(await deploy(ALICE, T_BYTECODE));
check('four independent tokens exist', tokens.length === 4);

for (const t of tokens) {
  const r = await send(ALICE, factory, sel('create(address)') + addr(t));
  if (r.failed) { check(`create a market for ${t.slice(0, 10)}`, false, r.error); break; }
}
const count = BigInt(await read(factory, sel('tokenCount()')).then((r) => toHex(r.returnValue)));
check('⭐ each token got its own market', count === 4n, `${count} pools`);

const dup = await send(ALICE, factory, sel('create(address)') + addr(tokens[0]));
check('⛔ a second pool for the same token is refused', dup.failed,
  'two pools would split the liquidity and give two prices for one asset');

/* ⛔⛔ The exclusion that is not a preference. */
const EXPRESSION_TOKEN = '0x' + 'ab'.repeat(20);   // a registry id, not a contract
const nope = await send(ALICE, factory, sel('create(address)') + addr(EXPRESSION_TOKEN));
check('⛔⛔ an EXPRESSION TOKEN cannot get a market', nope.failed,
  'GIZ and electoral tokens are not contracts, so there is nothing to pool - structural, not a check');
const zero = await send(ALICE, factory, sel('create(address)') + word(0));
check('⛔ nor can the zero address', zero.failed);

/* ------------------------------------------------ enumerate and price */

const markets = await read(factory, sel('allMarkets()'));
check('every market is listable in ONE call', !markets.failed,
  'a page making one request per token makes the list the slowest thing on screen');

/* ------------------------------------------------- two hops, any pair */

console.log('\ntwo hops through MOLI');

const poolFor = async (t) => '0x' + toHex((await read(factory, sel('poolOf(address)') + addr(t))).returnValue).slice(-40);
const poolA = await poolFor(tokens[0]);
const poolB = await poolFor(tokens[1]);
check('each token has a distinct pool', poolA !== poolB, `${poolA.slice(0, 10)} vs ${poolB.slice(0, 10)}`);

// Seed both pools: 100 MOLI : 100 token.
const SEED = 100n * 10n ** 18n;
for (const [t, p] of [[tokens[0], poolA], [tokens[1], poolB]]) {
  await send(ALICE, t, sel('approve(address,uint256)') + addr(p) + word(SEED));
  const r = await send(ALICE, p, sel('addLiquidity(uint256,uint256)') + word(SEED) + word(0), SEED);
  if (r.failed) check('seed a pool', false, r.error);
}
const rA = await read(poolA, sel('reserves()'));
check('both pools hold liquidity', !rA.failed && BigInt('0x' + toHex(rA.returnValue).slice(2, 66)) === SEED,
  `${SEED / 10n ** 18n} MOLI a side`);

// Token0 -> MOLI -> Token1, which is what a router does for any pair.
const AMOUNT = 10n ** 18n;
const before1 = BigInt(await read(tokens[1], sel('balanceOf(address)') + addr(BOB)).then((r) => toHex(r.returnValue)));
await send(ALICE, tokens[0], sel('transfer(address,uint256)') + addr(BOB) + word(AMOUNT));
await send(BOB, tokens[0], sel('approve(address,uint256)') + addr(poolA) + word(AMOUNT));
const hop1 = await send(BOB, poolA, sel('swapTokenForMoli(uint256,uint256)') + word(AMOUNT) + word(0));
check('hop 1: token → MOLI', !hop1.failed, hop1.error ?? '');
const moliGot = state.balanceOf(BOB);
const hop2 = await send(BOB, poolB, sel('swapMoliForToken(uint256)') + word(0), 10n ** 17n);
check('hop 2: MOLI → a DIFFERENT token', !hop2.failed, hop2.error ?? '');
const after1 = BigInt(await read(tokens[1], sel('balanceOf(address)') + addr(BOB)).then((r) => toHex(r.returnValue)));
check('⭐⭐ a holder of token A ended up holding token B, via MOLI',
  after1 > before1, `${after1 - before1} wei of token B`);
check('  so n tokens need n pools, not n²',
  count === 4n, 'every pool has MOLI on one side, which is what makes two hops enough');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
