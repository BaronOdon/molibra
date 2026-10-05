/**
 * MemeToken: compile for paris, write the artifact, stamp the bytecode into
 * src/web/memes.html, and prove the page's hand-rolled ABI code against ethers.
 *
 * The behavioural tests (transfer / approve / transferFrom / edge cases, and
 * the full deploy -> pool -> seed -> buy -> sell flow) run on Molibra's own EVM
 * in test/memes.mjs, from the artifact this writes, so `npm test` needs no
 * compiler. This script is the only thing that needs solc.
 *
 *   SOLC_DIR=<dir where `npm i solc@0.8.26 ethers@6` ran> node contracts/memes-build-and-test.mjs [--no-stamp]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PAGE = join(ROOT, 'src/web/memes.html');
const SWAP = join(ROOT, 'src/web/swap.html');
const SOLC_DIR = process.env.SOLC_DIR;
if (!SOLC_DIR) { console.error('set SOLC_DIR to a directory with solc@0.8.26 and ethers@6 installed'); process.exit(2); }
const req = createRequire(join(SOLC_DIR, 'package.json'));
const solc = req('solc');
const { ethers } = req('ethers');

let pass = 0; let fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('MemeToken: compile, stamp, and check the page encoders\n');
check('compiler is 0.8.26, like bridge/* and contracts/*', solc.version().startsWith('0.8.26'), solc.version());

// ⛔ The source key is part of the metadata hash, so it is the repo path, and
// this exact input is written out as the Etherscan standard-JSON bundle: what
// Etherscan recompiles is byte-for-byte what was deployed.
const SOURCE_KEY = 'contracts/MemeToken.sol';
const input = {
  language: 'Solidity',
  sources: { [SOURCE_KEY]: { content: readFileSync(join(HERE, 'MemeToken.sol'), 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // ⛔ paris: a Cancun target emits PUSH0/MCOPY and dies "invalid opcode" on
    // Molibra. Paris bytecode runs unchanged on Ethereum mainnet, so ONE build
    // serves both chains and one verification bundle covers FAZOL.
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors ?? []) {
  if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
}
const art = out.contracts[SOURCE_KEY].MemeToken;
const bytecode = '0x' + art.evm.bytecode.object;
const runtime = '0x' + art.evm.deployedBytecode.object;
check('MemeToken compiles for paris', true, `${(runtime.length - 2) / 2} runtime bytes`);
check('  and contains no PUSH0 (0x5f) at an opcode position', !hasPush0(runtime));

const iface = new ethers.Interface(art.abi);
for (const sig of ['name()', 'symbol()', 'decimals()', 'totalSupply()', 'description()', 'balanceOf(address)',
  'allowance(address,address)', 'transfer(address,uint256)', 'approve(address,uint256)',
  'transferFrom(address,address,uint256)', 'burn(uint256)']) {
  check(`ABI has ${sig}`, !!iface.getFunction(sig));
}
for (const bad of ['mint', 'burnFrom', 'pause', 'owner', 'transferOwnership', 'blacklist', 'setFee', 'upgradeTo']) {
  check(`ABI has NO ${bad}()`, !art.abi.some((f) => f.type === 'function' && f.name === bad));
}

writeFileSync(join(HERE, 'artifacts', 'MemeToken.json'), JSON.stringify({
  contractName: 'MemeToken', compiler: solc.version(), evmVersion: 'paris',
  optimizer: { enabled: true, runs: 200 }, abi: art.abi, bytecode, deployedBytecode: runtime,
}, null, 2) + '\n');
mkdirSync(join(HERE, 'etherscan'), { recursive: true });
writeFileSync(join(HERE, 'etherscan', 'MemeToken.standard-input.json'), JSON.stringify(input, null, 2) + '\n');

/* --------------------------------------------------------------- stamp */
let page = readFileSync(PAGE, 'utf8');
const swap = readFileSync(SWAP, 'utf8');
const BC_RE = /const MEME_BYTECODE = '[^']*';/;
const FB_RE = /const FACTORY_BYTECODE = '[^']*';/;
check('memes.html has a MEME_BYTECODE line', BC_RE.test(page));
check('memes.html has a FACTORY_BYTECODE line', FB_RE.test(page));
// ⛔ The factory is the one swap.html already deploys - one build, one source.
// A second compilation with other settings would be a second factory nobody reviewed.
const swapFactory = swap.match(FB_RE)[0];
const BA_RE = /const BRIDGED_BYTECODE = '[^']*';/;
const bridgedBytecode = JSON.parse(readFileSync(join(HERE, 'artifacts', 'pool.json'), 'utf8')).BridgedAsset.bytecode;
check('memes.html has a BRIDGED_BYTECODE line', BA_RE.test(page));
if (!process.argv.includes('--no-stamp')) {
  page = page.replace(BC_RE, `const MEME_BYTECODE = '${bytecode}';`).replace(FB_RE, swapFactory)
    .replace(BA_RE, `const BRIDGED_BYTECODE = '${bridgedBytecode}';`);
  writeFileSync(PAGE, page);
}
page = readFileSync(PAGE, 'utf8');
check('memes.html deploys exactly this MemeToken bytecode', page.includes(`const MEME_BYTECODE = '${bytecode}';`));
check('memes.html deploys exactly swap.html\'s factory bytecode', page.includes(swapFactory));
check('memes.html deploys exactly the BridgedAsset from artifacts/pool.json (the one WSRO uses)',
  page.includes(`const BRIDGED_BYTECODE = '${bridgedBytecode}';`));

/* -------------------------- the page's own ABI code, against ethers */
{
  const region = page.match(/\/\* ABI-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* ABI-END \*\//);
  check('memes.html has an ABI-BEGIN/ABI-END region', !!region);
  const lib = new Function(region[1] + '\nreturn { encCtor, encBridgedCtor, abiEncode, word, addr32, decString, isqrt, v4Plan, encPermit2Approve };')();
  const OP = '0xf51ac8FD4112bF1d45fD5C38D5aBfe0c61Ec3F5a';
  const desc = 'meme não oficial, sem vínculo com Fulano — 宪法 · البيان · no promise of value';
  const args = ['Bolsonaro', 'BOLSO', desc, 10n ** 27n, OP];
  const mine = lib.encCtor(...args);
  const theirs = ethers.AbiCoder.defaultAbiCoder().encode(
    ['string', 'string', 'string', 'uint256', 'address'], args).slice(2);
  check('page encCtor == ethers ABI encoding, byte for byte', mine === theirs.toLowerCase(), `${mine.length / 64} words`);
  const enc = iface.encodeFunctionResult('description', [desc]);
  check('page decString round-trips a multi-byte string', lib.decString(enc) === desc);
  {
    const ab = ethers.AbiCoder.defaultAbiCoder();
    const mine2 = lib.encBridgedCtor('Faz o L', 'FAZOL', OP);
    check('page encBridgedCtor == ethers', mine2 === ab.encode(['string', 'string', 'address'], ['Faz o L', 'FAZOL', OP]).slice(2).toLowerCase());
    const TOK = '0x1234567890abcdef1234567890abcdef12345678';
    const v = lib.v4Plan({ token: TOK, ethUsdE18: 2724n * 10n ** 18n, tokenUsdE18: 102346n * 10n ** 12n,
      amount1: 10n ** 24n, owner: OP, deadline: 1800000000n });
    const KEY = 'tuple(address,address,uint24,int24,address)';
    const key = [ethers.ZeroAddress, TOK, 2500, 25, ethers.ZeroAddress];
    const pm = new ethers.Interface([
      `function initializePool(${KEY} key, uint160 sqrtPriceX96) returns (int24)`,
      'function modifyLiquidities(bytes unlockData, uint256 deadline)',
      'function multicall(bytes[] data) returns (bytes[])',
    ]);
    const initE = pm.encodeFunctionData('initializePool', [key, v.sqrtPriceX96]);
    const mintP = ab.encode([KEY, 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
      [key, v.tickLower, v.tickUpper, v.liquidity, 0n, 10n ** 24n, OP, '0x']);
    const settleP = ab.encode(['address', 'address'], [ethers.ZeroAddress, TOK]);
    const unlock = ab.encode(['bytes', 'bytes[]'], ['0x020d', [mintP, settleP]]);
    const modE = pm.encodeFunctionData('modifyLiquidities', [unlock, 1800000000n]);
    const mcE = pm.encodeFunctionData('multicall', [[initE, modE]]);
    check('page v4Plan initializePool == ethers', v.init === initE.toLowerCase());
    check('page v4Plan modifyLiquidities(MINT_POSITION, SETTLE_PAIR) == ethers', v.modify === modE.toLowerCase());
    check('page v4Plan multicall == ethers', v.data === mcE.toLowerCase(), `${(v.data.length - 2) / 2} bytes`);
    check('page v4Plan: tickUpper STRICTLY below the initial tick, asks only, multiples of 25',
      v.tickUpper < v.tick && v.tickLower < v.tickUpper && v.tickUpper % 25n === 0n && v.tickLower % 25n === 0n);
    check('page v4Plan never asks for more than amount1', v.needed <= 10n ** 24n, v.needed.toString());
    const p2 = new ethers.Interface(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
    check('page encPermit2Approve == ethers', lib.encPermit2Approve(TOK, OP, 10n ** 24n, 1800000000n)
      === p2.encodeFunctionData('approve', [TOK, OP, 10n ** 24n, 1800000000n]).toLowerCase());
  }
  check('page isqrt is floor sqrt', [0n, 1n, 3n, 4n, 10n ** 36n, 10n ** 36n + 1n, 2n ** 255n].every(
    (n) => { const r = lib.isqrt(n); return r * r <= n && (r + 1n) * (r + 1n) > n; }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/** Walk opcodes (skipping PUSH data) looking for 0x5f. Metadata tail is excluded. */
function hasPush0(hex) {
  const b = Buffer.from(hex.slice(2), 'hex');
  const metaLen = b.length >= 2 ? b.readUInt16BE(b.length - 2) + 2 : 0;
  const end = b.length - metaLen;
  for (let i = 0; i < end; i++) {
    const op = b[i];
    if (op === 0x5f) return true;
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return false;
}
