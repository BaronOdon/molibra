/**
 * Compile the trust contracts (V4PositionLocker, TokenVesting) and their test
 * doubles for paris, and write:
 *
 *   contracts/artifacts/trust.json                       abi + bytecode, read by test/trust-contracts.mjs
 *   contracts/etherscan/V4PositionLocker.standard-input.json
 *   contracts/etherscan/TokenVesting.standard-input.json  the exact compiler input, for verification
 *
 * `npm test` runs the behaviour from the artifact and needs no compiler; only
 * this script does.
 *
 *   SOLC_DIR=<dir where `npm i solc@0.8.26` ran> node contracts/trust-build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOLC_DIR = process.env.SOLC_DIR;
if (!SOLC_DIR) { console.error('set SOLC_DIR to a directory with solc@0.8.26 installed'); process.exit(2); }
const solc = createRequire(join(SOLC_DIR, 'package.json'))('solc');
if (!solc.version().startsWith('0.8.26')) { console.error('need solc 0.8.26, got ' + solc.version()); process.exit(2); }

const settings = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'paris',   // ⛔ no PUSH0/MCOPY: one build runs on Molibra and Ethereum
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
};
const compile = (sources) => {
  const input = { language: 'Solidity', sources, settings };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  for (const e of out.errors ?? []) {
    if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
  }
  return { input, out };
};
const src = (p) => ({ content: readFileSync(join(HERE, '..', p), 'utf8') });

const art = {};
mkdirSync(join(HERE, 'etherscan'), { recursive: true });
for (const [key, name] of [['contracts/V4PositionLocker.sol', 'V4PositionLocker'], ['contracts/TokenVesting.sol', 'TokenVesting']]) {
  const { input, out } = compile({ [key]: src(key) });
  const c = out.contracts[key][name];
  art[name] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object };
  writeFileSync(join(HERE, 'etherscan', `${name}.standard-input.json`), JSON.stringify(input, null, 2) + '\n');
  console.log(`${name}: ${(c.evm.deployedBytecode.object.length) / 2} runtime bytes`);
}
{
  const key = 'contracts/test/TrustMocks.sol';
  const { out } = compile({ [key]: src(key) });
  for (const name of ['MockPositionManager', 'MockERC20']) {
    const c = out.contracts[key][name];
    art[name] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
  }
}
writeFileSync(join(HERE, 'artifacts', 'trust.json'), JSON.stringify({
  compiler: solc.version(), evmVersion: 'paris', optimizer: settings.optimizer, contracts: art,
}, null, 2) + '\n');
console.log('wrote contracts/artifacts/trust.json');
