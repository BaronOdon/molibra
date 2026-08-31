/**
 * Compile MolibraAnchor and RUN it in a local EVM.
 *
 * The check that matters is not that it compiles. It is that:
 *
 *   1. the Solidity `digest()` and the JavaScript `anchorDigest()` produce the
 *      SAME bytes - because if they differ, a publisher who equivocates cannot
 *      be slashed, and the bond is theatre;
 *   2. the monotonicity rules actually revert;
 *   3. an equivocation proof really does slash, and pays the prover.
 *
 *   node bridge/anchor-build-and-test.mjs [pathToNodeModulesWithSolcAndEthers]
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TOOLS = process.argv[2]
  ?? 'C:/Users/ADMINI~1/AppData/Local/Temp/1/claude/C--Users-Administrator/1f078fed-97de-4f03-b80f-50e27c3f93bd/scratchpad/solc-probe';
const req = createRequire(join(TOOLS, 'package.json'));

const solc = req('solc');
const { ethers } = req('ethers');
const { EVM } = req('@ethereumjs/evm');
const commonPkg = req('@ethereumjs/common');
const utilPkg = req('@ethereumjs/util');
const { hexToBytes, bytesToHex } = utilPkg;

const makeCommon = () => (commonPkg.Mainnet
  ? new commonPkg.Common({ chain: commonPkg.Mainnet })
  : new commonPkg.Common({ chain: commonPkg.Chain.Mainnet }));
const addressFrom = (hex) => (utilPkg.createAddressFromString
  ? utilPkg.createAddressFromString(hex)
  : utilPkg.Address.fromString(hex));

import { anchorDigest } from '../src/anchor.js';

let pass = 0; let fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('MolibraAnchor: compile, then execute\n');

/* ------------------------------------------------------------- compile */
// A minimal ERC-20 to bond with, so the test does not depend on any live token.
const MOCK = `
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;
contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor() { balanceOf[msg.sender] = 1e24; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v; return true; }
    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= v;
        balanceOf[f] -= v; balanceOf[t] += v; return true; }
}`;

const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: {
    'MolibraAnchor.sol': { content: readFileSync(join(HERE, 'MolibraAnchor.sol'), 'utf8') },
    'MockToken.sol': { content: MOCK },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // Paris, for the same reason as the prover: PUSH0/MCOPY from a Cancun
    // target deploy fine and then halt on an invalid instruction, with no
    // revert reason.
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
})));

for (const e of out.errors ?? []) {
  if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
}
check('contracts compile for paris', true);

const anchorArt = out.contracts['MolibraAnchor.sol'].MolibraAnchor;
const tokenArt = out.contracts['MockToken.sol'].MockToken;

/* --------------------------------------------------------------- EVM setup */
const common = makeCommon();
const evm = await EVM.create({ common });

const PUB = '0x1111111111111111111111111111111111111111';
const WATCHER = '0x2222222222222222222222222222222222222222';
const pubAddr = addressFrom(PUB);
const watcherAddr = addressFrom(WATCHER);

async function deploy(bytecode, caller = pubAddr) {
  const r = await evm.runCall({
    caller, to: undefined, data: hexToBytes('0x' + bytecode), gasLimit: 10_000_000n,
  });
  if (r.execResult.exceptionError) throw new Error(r.execResult.exceptionError.error);
  return r.createdAddress;
}
async function call(to, data, caller = pubAddr) {
  const r = await evm.runCall({
    caller, to, data: hexToBytes(data), gasLimit: 30_000_000n,
  });
  return {
    ok: !r.execResult.exceptionError,
    error: r.execResult.exceptionError?.error,
    ret: bytesToHex(r.execResult.returnValue),
    gas: r.execResult.executionGasUsed,
  };
}

const tokenAddr = await deploy(tokenArt.evm.bytecode.object);
const iface = new ethers.Interface(anchorArt.abi);
const tokenIface = new ethers.Interface(tokenArt.abi);

const MIN_BOND = 1000n;
const ctor = ethers.AbiCoder.defaultAbiCoder()
  .encode(['address', 'uint256'], [tokenAddr.toString(), MIN_BOND]).slice(2);
const anchorAddr = await deploy(anchorArt.evm.bytecode.object + ctor);
check('MolibraAnchor deploys', !!anchorAddr, anchorAddr.toString());

/* ------------------------------------------ 1. the digests must be identical */
{
  const height = 1234n;
  const blockHash = '0x' + 'ab'.repeat(32);
  const work = 987654321n;
  const onChain = await call(anchorAddr,
    iface.encodeFunctionData('digest', [height, blockHash, work]));
  const inJs = anchorDigest({ height, blockHash, cumulativeWork: work });
  check('Solidity digest() == JavaScript anchorDigest()', onChain.ret === inJs,
    'a mismatch here means an equivocating publisher could never be slashed');
}

/* ----------------------------------------------------- 2. bonding and anchoring */
await call(tokenAddr, tokenIface.encodeFunctionData('approve',
  [anchorAddr.toString(), ethers.MaxUint256]));

{
  const noBond = await call(anchorAddr,
    iface.encodeFunctionData('anchor', [100n, '0x' + '11'.repeat(32), 5000n]));
  check('anchoring without a bond is refused', !noBond.ok, noBond.error);
}

await call(anchorAddr, iface.encodeFunctionData('bond', [10_000n]));
{
  const first = await call(anchorAddr,
    iface.encodeFunctionData('anchor', [100n, '0x' + '11'.repeat(32), 5000n]));
  check('a bonded publisher can anchor', first.ok, `${first.gas} gas`);

  const same = await call(anchorAddr,
    iface.encodeFunctionData('anchor', [100n, '0x' + '99'.repeat(32), 6000n]));
  check('re-anchoring the SAME height is refused', !same.ok,
    'otherwise history could be re-attested after the fact');

  const lower = await call(anchorAddr,
    iface.encodeFunctionData('anchor', [50n, '0x' + '22'.repeat(32), 6000n]));
  check('anchoring a LOWER height is refused', !lower.ok, lower.error);

  const lessWork = await call(anchorAddr,
    iface.encodeFunctionData('anchor', [200n, '0x' + '33'.repeat(32), 4000n]));
  check('more height with LESS work is refused', !lessWork.ok,
    'a higher block cannot carry less accumulated work');

  const good = await call(anchorAddr,
    iface.encodeFunctionData('anchor', [200n, '0x' + '33'.repeat(32), 9000n]));
  check('a properly increasing anchor is accepted', good.ok, `${good.gas} gas`);

  const empty = await call(anchorAddr,
    iface.encodeFunctionData('anchor', [300n, ethers.ZeroHash, 10000n]));
  check('an empty block hash is refused', !empty.ok);

  const count = await call(anchorAddr, iface.encodeFunctionData('anchorCount', []));
  check('two anchors are recorded', BigInt(count.ret) === 2n);
}

/* ------------------------------------------------- 3. equivocation and slashing */
{
  // A real key, so the signatures are real and ecrecover has something to do.
  const wallet = new ethers.Wallet(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const signer = wallet.address;
  const signerAddr = addressFrom(signer);

  // Fund and bond the equivocator.
  await call(tokenAddr, tokenIface.encodeFunctionData('transfer', [signer, 50_000n]));
  await call(tokenAddr, tokenIface.encodeFunctionData('approve',
    [anchorAddr.toString(), ethers.MaxUint256]), signerAddr);
  await call(anchorAddr, iface.encodeFunctionData('bond', [20_000n]), signerAddr);

  const height = 777n;
  const hA = '0x' + 'aa'.repeat(32);
  const hB = '0x' + 'bb'.repeat(32);
  const work = 12345n;

  const sign = async (h, w) => wallet.signingKey
    .sign(anchorDigest({ height, blockHash: h, cumulativeWork: w })).serialized;

  const sigA = await sign(hA, work);
  const sigB = await sign(hB, work);

  const notEquiv = await call(anchorAddr, iface.encodeFunctionData('proveEquivocation',
    [height, hA, work, sigA, hA, work, sigA]), watcherAddr);
  check('the same attestation twice is NOT equivocation', !notEquiv.ok,
    'a retry is not a lie');

  const before = await call(anchorAddr, iface.encodeFunctionData('bondOf', [signer]));
  check('the equivocator is bonded before the proof', BigInt(before.ret) === 20_000n);

  const slash = await call(anchorAddr, iface.encodeFunctionData('proveEquivocation',
    [height, hA, work, sigA, hB, work, sigB]), watcherAddr);
  check('two signed attestations at one height slash the publisher', slash.ok,
    slash.ok ? `${slash.gas} gas` : slash.error);

  const after = await call(anchorAddr, iface.encodeFunctionData('bondOf', [signer]));
  check('the bond is gone', BigInt(after.ret) === 0n);

  const paid = await call(tokenAddr, tokenIface.encodeFunctionData('balanceOf', [WATCHER]));
  check('and it was paid to whoever proved it', BigInt(paid.ret) === 20_000n,
    'watching the chain has to be worth somebody\'s while');

  const again = await call(anchorAddr, iface.encodeFunctionData('proveEquivocation',
    [height, hA, work, sigA, hB, work, sigB]), watcherAddr);
  check('a slashed publisher cannot be slashed twice', !again.ok, again.error);

  const anchorAfter = await call(anchorAddr,
    iface.encodeFunctionData('anchor', [900n, '0x' + '44'.repeat(32), 99999n]), signerAddr);
  check('and can never anchor again', !anchorAfter.ok, anchorAfter.error);
}

/* ------------------------------------------------------ 4. reading the floor */
{
  // Nothing has 96 confirmations in a fresh EVM, so the floor must be empty.
  const fin = await call(anchorAddr, iface.encodeFunctionData('finalized', [96n, 64n]));
  const [h] = ethers.AbiCoder.defaultAbiCoder()
    .decode(['uint256', 'bytes32', 'uint256'], fin.ret);
  check('an unconfirmed anchor is not yet the floor', h === 0n,
    'an anchor inside a reorganisable Ethereum block is worth nothing');

  const now = await call(anchorAddr, iface.encodeFunctionData('finalized', [0n, 64n]));
  const [h2, , w2] = ethers.AbiCoder.defaultAbiCoder()
    .decode(['uint256', 'bytes32', 'uint256'], now.ret);
  check('with zero confirmations the tip is the floor', h2 === 200n && w2 === 9000n);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
