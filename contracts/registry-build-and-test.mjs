/**
 * Compile DocumentRegistry, RUN it in a local EVM, and stamp the bytecode into
 * src/web/documents.html.
 *
 * The checks that matter:
 *
 *   1. records are numbered from 1 in registration order - "the first document
 *      ever registered" is hashAt(1), so the numbering must be exact;
 *   2. only a NAMED signer can sign or revoke, once each;
 *   3. a revoked record is kept, and cannot be signed afterwards;
 *   4. the page deploys exactly the bytecode compiled here, and every selector
 *      the page hard-codes is the keccak of its signature.
 *
 *   node contracts/registry-build-and-test.mjs [--no-stamp]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PAGE = join(ROOT, 'src/web/documents.html');
const req = createRequire(join(ROOT, 'package.json'));

const solc = req('solc');
const { ethers } = req('ethers');
const evmPkg = req('@ethereumjs/evm');
// v10 exports createEVM; the older bridge/* harnesses were written against EVM.create.
const newEVM = (opts) => (evmPkg.createEVM ? evmPkg.createEVM(opts) : evmPkg.EVM.create(opts));
const commonPkg = req('@ethereumjs/common');
const utilPkg = req('@ethereumjs/util');
const { hexToBytes, bytesToHex } = utilPkg;

const makeCommon = () => (commonPkg.Mainnet
  ? new commonPkg.Common({ chain: commonPkg.Mainnet })
  : new commonPkg.Common({ chain: commonPkg.Chain.Mainnet }));
const addressFrom = (hex) => (utilPkg.createAddressFromString
  ? utilPkg.createAddressFromString(hex)
  : utilPkg.Address.fromString(hex));

let pass = 0; let fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('DocumentRegistry: compile, then execute\n');

/* ------------------------------------------------------------- compile */
check('compiler is 0.8.26, like bridge/*', solc.version().startsWith('0.8.26'), solc.version());

const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'DocumentRegistry.sol': { content: readFileSync(join(HERE, 'DocumentRegistry.sol'), 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // Paris: PUSH0/MCOPY from a Cancun target deploy fine and then halt on an
    // invalid instruction, with no revert reason.
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
})));
for (const e of out.errors ?? []) {
  if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
}
check('contract compiles for paris', true);

const art = out.contracts['DocumentRegistry.sol'].DocumentRegistry;
const bytecode = '0x' + art.evm.bytecode.object;
const runtime = art.evm.deployedBytecode.object;

/* --------------------------------------------------------------- EVM setup */
const evm = await newEVM({ common: makeCommon() });
const OPERATOR = '0xf51ac8FD4112bF1d45fD5C38D5aBfe0c61Ec3F5a';
const COSIGNER = '0x4444444444444444444444444444444444444444';
const STRANGER = '0x3333333333333333333333333333333333333333';
const op = addressFrom(OPERATOR.toLowerCase());
const cosigner = addressFrom(COSIGNER.toLowerCase());
const stranger = addressFrom(STRANGER);

// A bare EVM runs every call at block.timestamp 0. Molibra never does, and the
// signed/revoked times are timestamps, so the calls run on a real clock - and
// one check below deliberately runs at 0 to prove existence does not depend on it.
let clock = 1_758_800_000n;
const blockAt = (ts) => ({
  header: {
    number: 1n, coinbase: addressFrom('0x0000000000000000000000000000000000000000'),
    timestamp: ts, difficulty: 0n, prevRandao: new Uint8Array(32), gasLimit: 30_000_000n,
    baseFeePerGas: undefined, slotNumber: 0n, getBlobGasPrice: () => undefined,
  },
});
async function run(to, data, caller = op, ts = (clock += 13n)) {
  const r = await evm.runCall({ caller, to, data: hexToBytes(data), gasLimit: 10_000_000n, block: blockAt(ts) });
  return {
    ok: !r.execResult.exceptionError,
    ret: bytesToHex(r.execResult.returnValue),
    gas: r.execResult.executionGasUsed,
    logs: r.execResult.logs ?? [],
    created: r.createdAddress,
  };
}
const iface = new ethers.Interface(art.abi);
const errName = (ret) => { try { return iface.parseError(ret)?.name ?? ret; } catch { return ret; } };

const dep = await run(undefined, bytecode);
check('DocumentRegistry deploys', dep.ok && !!dep.created, `${dep.gas} gas`);
const reg = dep.created;
const tx = (fn, args, caller) => run(reg, iface.encodeFunctionData(fn, args), caller);
const view = async (fn, args = []) => iface.decodeFunctionResult(fn, (await tx(fn, args)).ret);

const H1 = '0x' + 'a44b27358c2c36f760e24c8b7855283def1c463e9991f0a61620423e19ed4ddf';
const H2 = '0x' + '11'.repeat(32);
const H3 = '0x' + '22'.repeat(32);

/* ------------------------------------------------------ 1. numbering */
check('an empty registry has count 0', (await view('count'))[0] === 0n);
check('hashAt(1) is empty before anything is registered', (await view('hashAt', [1n]))[0] === ethers.ZeroHash);

const r1 = await tx('register', [H1, 'Manifesto às Nações Unidas', [OPERATOR]]);
check('the first record registers', r1.ok, `${r1.gas} gas`);
check('it is number 1', (await view('numberOf', [H1]))[0] === 1n);
check('hashAt(1) is that hash', (await view('hashAt', [1n]))[0] === H1);
{
  const log = r1.logs[0];
  const parsed = iface.parseLog({ topics: log[1].map((t) => bytesToHex(t)), data: bytesToHex(log[2]) });
  check('Registered carries the number, indexed', parsed.name === 'Registered' && parsed.args.number === 1n
    && parsed.args.hash === H1 && parsed.args.label === 'Manifesto às Nações Unidas',
  `label "${parsed.args.label}"`);
}

const dup = await tx('register', [H1, 'again', [OPERATOR]]);
check('the same hash cannot be registered twice', !dup.ok && errName(dup.ret) === 'AlreadyRegistered', errName(dup.ret));
{
  // Regression: existence used to be registeredAt != 0, so at timestamp 0 a
  // record looked unregistered and could be registered over. It is the number now.
  const Z = '0x' + '5a'.repeat(32);
  const zfirst = await run(reg, iface.encodeFunctionData('register', [Z, 'at clock zero', [OPERATOR]]), op, 0n);
  const zdup = await run(reg, iface.encodeFunctionData('register', [Z, 'over it', [OPERATOR]]), op, 0n);
  check('even at block.timestamp 0 a record cannot be registered over',
    zfirst.ok && !zdup.ok && errName(zdup.ret) === 'AlreadyRegistered', errName(zdup.ret));
  // That record is number 2; the rest of the test counts from here.
}
check('and a failed register does not consume a number', (await view('count'))[0] === 2n);

const empty = await tx('register', [ethers.ZeroHash, 'x', [OPERATOR]]);
check('an empty hash is refused', !empty.ok && errName(empty.ret) === 'EmptyHash');

const r2 = await tx('register', [H2, 'Consent form - co-signed', [COSIGNER, OPERATOR]], stranger);
check('anyone may register; the next record is number 3', r2.ok && (await view('numberOf', [H2]))[0] === 3n);
check('count is 3', (await view('count'))[0] === 3n);
check('an unregistered hash has number 0', (await view('numberOf', [H3]))[0] === 0n);

/* ------------------------------------------------------ 2. signing */
{
  let s = await view('status', [H1]);
  check('status before signing: not fully signed', s.fullySigned === false && s.signedTimes[0] === 0n);

  const bad = await tx('sign', [H1], stranger);
  check('a wallet not named cannot sign', !bad.ok && errName(bad.ret) === 'NotASigner');

  const good = await tx('sign', [H1], op);
  check('the named signer signs', good.ok, `${good.gas} gas`);
  const again = await tx('sign', [H1], op);
  check('and cannot sign twice', !again.ok && errName(again.ret) === 'AlreadySigned');

  s = await view('status', [H1]);
  check('status after signing: fully signed, registrant is the operator',
    s.fullySigned === true && s.registrant.toLowerCase() === OPERATOR.toLowerCase());

  const none = await tx('sign', [H3], op);
  check('signing an unregistered hash is refused', !none.ok && errName(none.ret) === 'NotRegistered');

  await tx('sign', [H2], cosigner);
  s = await view('status', [H2]);
  check('two signers: one signature is not "fully signed"', s.fullySigned === false);
  await tx('sign', [H2], op);
  s = await view('status', [H2]);
  check('both signatures make it fully signed', s.fullySigned === true);
}

/* ------------------------------------------------------ 3. revoking */
{
  const r3 = await tx('register', [H3, 'to revoke', [COSIGNER, OPERATOR]]);
  check('the next record is number 4', r3.ok && (await view('numberOf', [H3]))[0] === 4n);
  const bad = await tx('revoke', [H3], stranger);
  check('a stranger cannot revoke', !bad.ok && errName(bad.ret) === 'NotASigner');
  const ok = await tx('revoke', [H3], cosigner);
  check('a named signer revokes', ok.ok);
  const s = await view('status', [H3]);
  check('the record is kept, marked revoked, with who revoked it',
    s.revokedAt > 0n && s.revokedBy.toLowerCase() === COSIGNER.toLowerCase() && s.label === 'to revoke');
  const after = await tx('sign', [H3], op);
  check('a revoked record cannot be signed', !after.ok && errName(after.ret) === 'AlreadyRevoked');
  check('and it keeps its number', (await view('numberOf', [H3]))[0] === 4n);
  check('hashAt(1) is still the first record', (await view('hashAt', [1n]))[0] === H1);
}

/* ------------------------------------------------ 4. the page matches this build */
const SIGS = {
  register: 'register(bytes32,string,address[])',
  sign: 'sign(bytes32)',
  revoke: 'revoke(bytes32)',
  status: 'status(bytes32)',
  count: 'count()',
  numberOf: 'numberOf(bytes32)',
  hashAt: 'hashAt(uint256)',
};
for (const [k, sig] of Object.entries(SIGS)) {
  check(`ABI has ${sig}`, !!iface.getFunction(sig));
}

let page = readFileSync(PAGE, 'utf8');
const stamp = !process.argv.includes('--no-stamp');
const BC_RE = /const REGISTRY_BYTECODE = '[^']*';/;
check('the page has a REGISTRY_BYTECODE line to stamp', BC_RE.test(page));
if (stamp) {
  page = page.replace(BC_RE, `const REGISTRY_BYTECODE = '${bytecode}';`);
  writeFileSync(PAGE, page);
  writeFileSync(join(HERE, 'artifacts', 'DocumentRegistry.json'), JSON.stringify({
    contractName: 'DocumentRegistry', compiler: solc.version(), evmVersion: 'paris',
    optimizer: { enabled: true, runs: 200 }, abi: art.abi, bytecode, deployedBytecode: '0x' + runtime,
  }, null, 2) + '\n');
}
page = readFileSync(PAGE, 'utf8');
check('the page deploys exactly this bytecode', page.includes(`const REGISTRY_BYTECODE = '${bytecode}';`),
  'a page that deploys something nobody compiled is a page nobody has read');

for (const [k, sig] of Object.entries(SIGS)) {
  const m = page.match(new RegExp(`${k}:\\s*'(0x[0-9a-f]{8})'`));
  const want = ethers.id(sig).slice(0, 10);
  check(`page selector ${k} == keccak("${sig}")`, !!m && m[1] === want, m ? m[1] : 'missing');
}
{
  const m = page.match(/REGISTERED_TOPIC = '(0x[0-9a-f]{64})'/);
  const want = iface.getEvent('Registered').topicHash;
  check('page Registered topic == the event signature hash', !!m && m[1] === want, want);
}

/* ------------------------- 5. the page's own ABI code, run against the contract */
// The page encodes and decodes by hand (no ethers in the browser). Hand-rolled
// ABI code that is only read, never run, is where offsets go wrong silently -
// so the exact region the browser runs is executed here.
{
  const region = page.match(/\/\* ABI-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* ABI-END \*\//);
  check('the page has an ABI-BEGIN/ABI-END region', !!region);
  const SELP = Object.fromEntries(Object.keys(SIGS).map((k) =>
    [k, page.match(new RegExp(`${k}:\\s*'(0x[0-9a-f]{8})'`))[1]]));
  const word = (v) => BigInt(v).toString(16).padStart(64, '0');
  const addr32 = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const lib = new Function('SEL', 'word', 'addr32',
    region[1] + '\nreturn { encRegister, decStatus, words };')(SELP, word, addr32);

  const HP = '0x' + 'c3'.repeat(32);
  // Long, multi-byte, crossing several 32-byte words: the offsets have to be right.
  const label = 'Manifesto às Nações Unidas — 31/07/2025 · 宪法宣言 · البيان الدستوري · КОНСТИТУЦИОННЫЙ';
  const signers = [OPERATOR, COSIGNER, STRANGER];
  const mine = lib.encRegister(HP, label, signers);
  const theirs = iface.encodeFunctionData('register', [HP, label, signers]);
  check('page encRegister == ethers, byte for byte', mine === theirs.toLowerCase(),
    `${(mine.length - 10) / 64} words`);

  const r = await run(reg, mine, op);
  check('the page-encoded register executes', r.ok, `${r.gas} gas for a ${new TextEncoder().encode(label).length}-byte label`);
  await tx('sign', [HP], cosigner);

  const raw = (await tx('status', [HP])).ret;
  const p = lib.decStatus(raw);
  const e = iface.decodeFunctionResult('status', raw);
  check('page decStatus: label round-trips exactly', p.label === label && e.label === label);
  check('page decStatus: signers match ethers',
    p.signers.length === 3 && p.signers.every((a, i) => a.toLowerCase() === e.signers[i].toLowerCase()));
  check('page decStatus: signed times match (only the co-signer signed)',
    p.signedTimes.every((t, i) => t === e.signedTimes[i]) && p.signedTimes[1] > 0n && p.signedTimes[0] === 0n);
  check('page decStatus: registrant, times and flags match',
    p.registrant.toLowerCase() === e.registrant.toLowerCase() && p.registeredAt === e.registeredAt
    && p.fullySigned === e.fullySigned && p.revokedAt === e.revokedAt);
  const cnt = lib.words((await tx('count', [])).ret)[0];
  check('page words() reads count', BigInt('0x' + cnt) === (await view('count'))[0]);
}

/* ---------------- 6. the browser's hash is the hash on disk (the real manifesto) */
{
  const { sha256 } = req('@noble/hashes/sha256');
  const MANIFESTO = 'A:/molibra_registry/001_manifesto_onu_2025-07-31/Manifesto_Soberania_Espiritual_Brasil.pdf';
  let bytes = null;
  try { bytes = readFileSync(MANIFESTO); } catch { /* not on this machine */ }
  if (bytes) {
    const h = '0x' + Buffer.from(sha256(bytes)).toString('hex');
    check('noble sha256 (what the page runs) == the SHA-256 recorded at extraction', h === H1, h);
  } else {
    console.log('  SKIP  manifesto file not on this machine');
  }
  // Record #1 is the SENT EMAIL itself (operator's decision, option C, 25 Sep 2026).
  const EML = 'A:/molibra_registry/001_manifesto_onu_2025-07-31/sent_email_uid34618.eml';
  const RECORD_1 = '0x693c6837ba7c08020c9a211aa174a5768b90484a4a216245385f718d2184f6c2';
  let eml = null;
  try { eml = readFileSync(EML); } catch { /* not on this machine */ }
  if (eml) {
    const h = '0x' + Buffer.from(sha256(eml)).toString('hex');
    check('record #1: the sent email hashes to the published value', h === RECORD_1, `${eml.length} bytes`);
  } else {
    console.log('  SKIP  record #1 email not on this machine');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
