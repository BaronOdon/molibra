/**
 * Compile the Solidity verifier and RUN IT, against a real Molibra proof,
 * inside a local EVM — before anybody spends ETH on a real network.
 *
 * The point is not that the contract compiles. It is that the exact bytes an
 * Ethereum node would execute accept a proof produced by the exact code a
 * Molibra node runs. Two independent implementations of the same rules -
 * JavaScript on one side, EVM bytecode on the other - have to agree, and the
 * only way to know they do is to run both.
 *
 * Toolchain lives outside the repo (solc and an EVM are dev-only, and Molibra
 * deliberately ships two dependencies). Point TOOLS at it:
 *
 *   node bridge/build-and-test.mjs [pathToNodeModulesWithSolcAndEthers]
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// The ethereumjs packages renamed these between majors, and which one is
// resolved depends on where node_modules happens to sit. Adapt rather than
// pin: this is a dev harness, and a version mismatch here should not read as
// a bridge failure.
const makeCommon = () => (commonPkg.Mainnet
  ? new commonPkg.Common({ chain: commonPkg.Mainnet })
  : new commonPkg.Common({ chain: commonPkg.Chain.Mainnet }));
const addressFrom = (hex) => (utilPkg.createAddressFromString
  ? utilPkg.createAddressFromString(hex)
  : utilPkg.Address.fromString(hex));

import { Chain } from '../src/chain.js';
import { signTransaction } from '../src/tx.js';
import { transactionProof, verifyTransactionProof } from '../src/proof.js';
import { privateToAddress, fromHex, toHex } from '../src/crypto.js';
import { serializeBlock } from '../src/block.js';

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('Molibra -> Ethereum bridge: compile, then execute\n');

/* ------------------------------------------------------------- compile */
const source = readFileSync(join(HERE, 'MolibraProver.sol'), 'utf8');
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: {
    'MolibraProver.sol': { content: source },
    'MolibraRelay.sol': { content: readFileSync(join(HERE, 'MolibraRelay.sol'), 'utf8') },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // Target Paris, not the compiler's default.
    //
    // solc 0.8.26 emits PUSH0 and MCOPY for Cancun, and a network that has not
    // reached that hardfork treats them as INVALID - the contract deploys and
    // then every call dies with "invalid opcode" and no revert reason, which
    // reads exactly like a broken verifier rather than a wrong target. Paris
    // runs everywhere that matters and costs a little gas.
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
})));

const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
check('the contract compiles', errors.length === 0,
  errors.map((e) => e.formattedMessage).join('\n') || 'solc ' + solc.version().split('+')[0]);
if (errors.length) process.exit(1);

const artifacts = {
  ...out.contracts['MolibraProver.sol'],
  ...out.contracts['MolibraRelay.sol'],
};
mkdirSync(join(HERE, 'artifacts'), { recursive: true });
for (const [name, c] of Object.entries(artifacts)) {
  writeFileSync(join(HERE, 'artifacts', `${name}.json`),
    JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2));
}
console.log(`  built ${Object.keys(artifacts).join(', ')}\n`);

/* ------------------------------------------- a real proof from a real chain */
const dirs = [];
const scratch = (n) => { const d = mkdtempSync(join(tmpdir(), `molibra-bridge-${n}-`)); dirs.push(d); return d; };

const ALICE_KEY = fromHex('0x' + '01'.repeat(32));
const ALICE = privateToAddress(ALICE_KEY);
const BOB = privateToAddress(fromHex('0x' + '02'.repeat(32)));
const chain = new Chain(Chain.loadGenesis(join(ROOT, 'genesis.json')), scratch('chain')).init();
for (let i = 0; i < 4; i++) chain.mine(ALICE);

// Three transactions: an odd count, so the promotion rule is exercised.
const hashes = [];
for (let i = 0; i < 3; i++) {
  hashes.push(chain.submitRaw(toHex(signTransaction(
    { nonce: BigInt(i), gasPrice: 1000000000n, gasLimit: 21000n, to: BOB, value: 1n, data: '0x' },
    ALICE_KEY, chain.chainId))));
}
chain.mine(ALICE);
const proof = transactionProof(chain, hashes[1]);
check('molibra produced a proof its own verifier accepts',
  verifyTransactionProof(proof).ok, `block ${proof.blockNumber}, index ${proof.index}`);

/**
 * The header, RLP-encoded exactly as `blockHash` does it. The contract is
 * handed these bytes and re-derives the hash itself, so if this encoding were
 * wrong the contract would reject it rather than silently agree.
 */
import { RLP } from '@ethereumjs/rlp';
const big = (v) => {
  const n = BigInt(v);
  if (n === 0n) return new Uint8Array(0);
  const hex = n.toString(16);
  return hexToBytes('0x' + (hex.length % 2 ? '0' + hex : hex));
};
const h = proof.header;
const headerRlp = bytesToHex(RLP.encode([
  big(h.number), hexToBytes(h.parentHash), big(h.timestamp), hexToBytes(h.miner),
  hexToBytes(h.stateRoot), hexToBytes(h.txRoot), big(h.difficulty), big(h.gasLimit),
  big(h.gasUsed), hexToBytes(h.extraData === '0x' ? '0x' : h.extraData), big(h.nonce),
]));
check('the header RLP hashes to the block hash molibra recorded',
  ethers.keccak256(headerRlp) === proof.blockHash, proof.blockHash.slice(0, 14));

/* ------------------------------------------------------------ run the EVM */
const common = makeCommon();
const evm = await EVM.create({ common });

const proverArtifact = JSON.parse(readFileSync(join(HERE, 'artifacts', 'MolibraProver.json'), 'utf8'));
const proverIface = new ethers.Interface(proverArtifact.abi);

const deploy = await evm.runCall({
  data: hexToBytes(proverArtifact.bytecode),
  gasLimit: 10_000_000n,
});
check('the prover deploys in an EVM', !deploy.execResult.exceptionError,
  deploy.execResult.exceptionError?.error ?? `${deploy.execResult.executionGasUsed} gas`);
const proverAddress = deploy.createdAddress;

async function callProver(fn, args) {
  const res = await evm.runCall({
    to: proverAddress,
    data: hexToBytes(proverIface.encodeFunctionData(fn, args)),
    gasLimit: 30_000_000n,
  });
  if (res.execResult.exceptionError) {
    let reason = res.execResult.exceptionError.error;
    try {
      const rv = bytesToHex(res.execResult.returnValue);
      if (rv.length > 10) reason = ethers.AbiCoder.defaultAbiCoder()
        .decode(['string'], '0x' + rv.slice(10))[0];
    } catch { /* not a string revert */ }
    return { ok: false, reason, gas: res.execResult.executionGasUsed };
  }
  return {
    ok: true,
    value: proverIface.decodeFunctionResult(fn, bytesToHex(res.execResult.returnValue)),
    gas: res.execResult.executionGasUsed,
  };
}

const siblings = proof.siblings.map((s) => s.hash);
const onRight = proof.siblings.map((s) => s.side === 'right');

const verified = await callProver('verifyTransaction', [headerRlp, proof.txHash, siblings, onRight]);
check('THE CONTRACT VERIFIES A REAL MOLIBRA TRANSACTION', verified.ok,
  verified.ok ? `${verified.gas} gas` : verified.reason);
if (verified.ok) {
  const header = verified.value[0];
  check('and re-derived the same block hash, root and difficulty',
    header.blockHash === proof.blockHash
    && header.txRoot === proof.header.txRoot
    && header.difficulty === BigInt(proof.header.difficulty),
    `difficulty ${header.difficulty}`);
}

// Every transaction in the block, not just the convenient one.
let all = true;
for (const hash of hashes) {
  const p = transactionProof(chain, hash);
  const r = await callProver('verifyTransaction', [headerRlp, p.txHash,
    p.siblings.map((s) => s.hash), p.siblings.map((s) => s.side === 'right')]);
  if (!r.ok) all = false;
}
check('every transaction in an ODD-sized block verifies', all,
  '3 transactions - the promotion rule is exercised, not skipped');

/* --------------------------------------------------------- what must fail */
const forged = await callProver('verifyTransaction',
  [headerRlp, '0x' + 'ab'.repeat(32), siblings, onRight]);
check('a transaction that was not in the block is rejected',
  !forged.ok && /not in this block/.test(forged.reason ?? ''), forged.reason);

// Flip one bit of the state root: the header no longer hashes to anything with
// valid work, so the seal check catches it.
const tampered = headerRlp.slice(0, 80) + (headerRlp[80] === 'a' ? 'b' : 'a') + headerRlp.slice(81);
const tamperedResult = await callProver('verifyTransaction',
  [tampered, proof.txHash, siblings, onRight]);
check('a header edited after mining is rejected', !tamperedResult.ok, tamperedResult.reason);

const swapped = await callProver('verifyTransaction',
  [headerRlp, proof.txHash, siblings, onRight.map((b) => !b)]);
check('a path with its sides flipped is rejected', !swapped.ok, swapped.reason);

// The target arithmetic, which is where an off-by-one would hide.
const target = await callProver('targetFor', [BigInt(proof.header.difficulty)]);
const expected = (1n << 256n) / BigInt(proof.header.difficulty);
check('the difficulty target matches molibra\'s own arithmetic exactly',
  target.ok && target.value[0] === expected, `${expected.toString(16).slice(0, 12)}…`);
const powerOfTwo = await callProver('targetFor', [1024n]);
check('including for a power-of-two difficulty, where the two formulas differ',
  powerOfTwo.ok && powerOfTwo.value[0] === (1n << 256n) / 1024n);

/* ------------------------------------------------------- the test bridge */
const bridgeArtifact = JSON.parse(readFileSync(join(HERE, 'artifacts', 'MolibraTestBridge.json'), 'utf8'));
const bridgeIface = new ethers.Interface(bridgeArtifact.abi);
const OWNER = addressFrom('0x' + '11'.repeat(20));
const RECIPIENT = addressFrom('0x' + '22'.repeat(20));

const makeAccount = (balance) => (utilPkg.createAccount
  ? utilPkg.createAccount({ balance })
  : new utilPkg.Account(0n, balance));
await evm.stateManager.putAccount(OWNER, makeAccount(10n ** 19n));

const bridgeDeploy = await evm.runCall({
  caller: OWNER, origin: OWNER, value: 10n ** 18n,
  data: hexToBytes(bridgeArtifact.bytecode + ethers.AbiCoder.defaultAbiCoder()
    .encode(['address', 'uint256'], [proverAddress.toString(), 1000]).slice(2)),
  gasLimit: 10_000_000n,
});
check('the test bridge deploys and holds the funding',
  !bridgeDeploy.execResult.exceptionError,
  bridgeDeploy.execResult.exceptionError?.error ?? '1 ETH in');
const bridgeAddress = bridgeDeploy.createdAddress;

async function release(txHash, amount, caller = OWNER) {
  const res = await evm.runCall({
    caller, origin: caller, to: bridgeAddress,
    data: hexToBytes(bridgeIface.encodeFunctionData('release', [
      headerRlp, txHash, siblings, onRight, RECIPIENT.toString(), amount])),
    gasLimit: 30_000_000n,
  });
  return { ok: !res.execResult.exceptionError, res };
}

const before = (await evm.stateManager.getAccount(RECIPIENT))?.balance ?? 0n;
const released = await release(proof.txHash, 10n ** 17n);
const after = (await evm.stateManager.getAccount(RECIPIENT))?.balance ?? 0n;
check('ETH IS RELEASED against a proved molibra transaction',
  released.ok && after - before === 10n ** 17n,
  `${(Number(after - before) / 1e18).toFixed(2)} ETH moved`);

const again = await release(proof.txHash, 10n ** 17n);
check('the same molibra transaction cannot be claimed twice', !again.ok,
  'one release per transaction, ever');

// A proof for a real transaction, but from a chain nobody has to respect: this
// is the attack the test rig cannot stop, and the reason it is a test rig.
console.log('\n  NOTE  a single header with valid work is cheap to mine at low difficulty.');
console.log('        This rig is deliberately not safe for third-party funds; a real bridge');
console.log('        needs a header chain with accumulated difficulty and a confirmation depth.');

/* ------------------------------------------------- the relay: the real fix */
// One header proves one block of work. The relay makes a forger out-work the
// NETWORK: difficulty must follow molibra's own retarget rule from a
// checkpoint, chains are compared by accumulated work, and a transaction only
// counts once enough work is piled on top of it.
const relayArtifact = JSON.parse(readFileSync(join(HERE, 'artifacts', 'MolibraRelay.json'), 'utf8'));
const relayIface = new ethers.Interface(relayArtifact.abi);
const rlpOf = (blk) => {
  const bh = blk.header;
  return bytesToHex(RLP.encode([
    big(bh.number), hexToBytes(bh.parentHash), big(bh.timestamp), hexToBytes(bh.miner),
    hexToBytes(bh.stateRoot), hexToBytes(bh.txRoot), big(bh.difficulty), big(bh.gasLimit),
    big(bh.gasUsed), bh.extraData === '0x' ? new Uint8Array(0) : hexToBytes(bh.extraData),
    big(bh.nonce),
  ]));
};

const anchor = chain.blockByNumber(4);
const relayDeploy = await evm.runCall({
  caller: OWNER, origin: OWNER,
  data: hexToBytes(relayArtifact.bytecode + ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes32', 'uint64', 'uint64', 'uint128', 'bytes32', 'uint256', 'uint256'],
    [proverAddress.toString(), anchor.hash, anchor.header.number, anchor.header.timestamp,
      anchor.header.difficulty, anchor.header.txRoot,
      chain.genesis.targetBlockSeconds, chain.genesis.minimumDifficulty]).slice(2)),
  gasLimit: 20_000_000n,
});
check('the relay deploys, anchored to a checkpoint',
  !relayDeploy.execResult.exceptionError,
  relayDeploy.execResult.exceptionError?.error ?? `block ${anchor.header.number}`);
const relayAddress = relayDeploy.createdAddress;

async function callRelay(fn, args, caller = OWNER) {
  const r = await evm.runCall({
    caller, origin: caller, to: relayAddress,
    data: hexToBytes(relayIface.encodeFunctionData(fn, args)),
    gasLimit: 100_000_000n,
  });
  if (r.execResult.exceptionError) {
    let why = r.execResult.exceptionError.error;
    const rv = bytesToHex(r.execResult.returnValue);
    if (rv.length > 10) { try { why = relayIface.parseError(rv)?.name ?? why; } catch { /* not ours */ } }
    return { ok: false, why };
  }
  return { ok: true, value: relayIface.decodeFunctionResult(fn, bytesToHex(r.execResult.returnValue)) };
}

for (let i = 0; i < 6; i++) chain.mine(ALICE);
const run = [];
for (let n = 5; n <= Number(chain.height); n++) run.push(rlpOf(chain.blockByNumber(n)));
const submitted = await callRelay('submit', [run]);
check('THE RELAY ACCEPTS A REAL RUN OF MOLIBRA HEADERS', submitted.ok,
  submitted.ok ? `${run.length} headers, each checked against the retarget rule` : submitted.why);

const bestWork = await callRelay('bestWork', []);
const expectedWork = chain.canonical.slice(4)
  .reduce((sum, b) => sum + BigInt(b.header.difficulty), 0n);
check('and accumulates exactly the work molibra did',
  bestWork.ok && bestWork.value[0] === expectedWork, `${expectedWork} total difficulty`);

// The attack the test rig cannot see: a header that simply DECLARES an easy
// difficulty. The retarget rule refuses it.
const tip = chain.blockByNumber(Number(chain.height));
const forgedRlp = bytesToHex(RLP.encode([
  big(BigInt(tip.header.number) + 1n), hexToBytes(tip.hash),
  big(BigInt(tip.header.timestamp) + 1n), hexToBytes(tip.header.miner),
  hexToBytes(tip.header.stateRoot), hexToBytes(tip.header.txRoot),
  big(1000), big(tip.header.gasLimit), big(0), new Uint8Array(0), big(1),
]));
const forgedSubmit = await callRelay('submit', [[forgedRlp]]);
check('a header that simply DECLARES an easy difficulty is refused', !forgedSubmit.ok,
  `${forgedSubmit.why} — the attack a single-header bridge cannot see`);

const settledHigh = await callRelay('isSettled',
  [proof.blockHash, proof.txHash, siblings, onRight, expectedWork * 10n]);
const settledLow = await callRelay('isSettled',
  [proof.blockHash, proof.txHash, siblings, onRight, 1n]);
check('a transaction is NOT settled until enough work is piled on top',
  settledHigh.ok && settledHigh.value[0] === false);
check('and IS settled once it is buried', settledLow.ok && settledLow.value[0] === true,
  'confirmation measured in work, not in a count of blocks');

/* ------------------------------------ the instruction comes from the chain */
const b2Artifact = JSON.parse(readFileSync(join(HERE, 'artifacts', 'MolibraBridge.json'), 'utf8'));
const b2Iface = new ethers.Interface(b2Artifact.abi);
const { encodeBridgeOut } = await import('../src/bridge.js');
const rawBridgeTx = toHex(signTransaction(
  { nonce: 3n, gasPrice: 1000000000n, gasLimit: 60000n, to: ALICE, value: 0n,
    data: encodeBridgeOut('0x' + '22'.repeat(20), 10n ** 17n) },
  ALICE_KEY, chain.chainId));

const b2Deploy = await evm.runCall({
  caller: OWNER, origin: OWNER, value: 10n ** 18n,
  data: hexToBytes(b2Artifact.bytecode + ethers.AbiCoder.defaultAbiCoder()
    .encode(['address', 'uint256'], [relayAddress.toString(), 1]).slice(2)),
  gasLimit: 20_000_000n,
});
check('the relay-backed bridge deploys', !b2Deploy.execResult.exceptionError,
  b2Deploy.execResult.exceptionError?.error ?? '1 ETH in');

const decoded = await evm.runCall({
  to: b2Deploy.createdAddress,
  data: hexToBytes(b2Iface.encodeFunctionData('decodeBridgeOut', [rawBridgeTx])),
  gasLimit: 10_000_000n,
});
const readBack = decoded.execResult.exceptionError ? null
  : b2Iface.decodeFunctionResult('decodeBridgeOut', bytesToHex(decoded.execResult.returnValue));
check('THE CONTRACT READS THE INSTRUCTION OUT OF THE MOLIBRA TRANSACTION ITSELF',
  readBack !== null && readBack[0].toLowerCase() === '0x' + '22'.repeat(20)
  && readBack[1] === 10n ** 17n,
  readBack ? `${readBack[0]} <- ${(Number(readBack[1]) / 1e18).toFixed(2)} ETH`
    : decoded.execResult.exceptionError?.error);

console.log(`\n${pass} passed, ${fail} failed`);
for (const d of dirs) rmSync(d, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
