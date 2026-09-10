/**
 * Deploy BridgedMoli to Ethereum mainnet.
 *
 *   node deploy-bridgedmoli.mjs            pre-flight; signs nothing, sends nothing
 *   node deploy-bridgedmoli.mjs --send     do it
 *
 * ## Why a redeploy
 *
 * The live bMOLI at 0x5a60f4de… can only mint against a burn whose OWN block
 * was anchored, and anchors are sparse and strictly increasing - so anchoring
 * past a burn stranded it forever. This build adds `claimVia`, which proves the
 * burn's block is an ancestor of any LATER anchored block, so the publisher
 * cannot gate a claim by choosing what to anchor.
 *
 * ⛔ The old contract is immutable and holds ZERO supply, so nothing is
 * migrated and nothing is lost. It simply stops being the one referenced.
 *
 * ⛔ The constructor arguments must match the old deployment exactly - the same
 * anchor contract and the same challenge window - or the new token is a
 * different instrument wearing the same name. They are asserted below against
 * the live values read back from the OLD contract, not from documentation.
 *
 * ⛔ The key is read from CREDENTIALS.md, matched by DERIVING the address
 * rather than trusting a label, used to sign locally, and never printed.
 */
import { readFileSync } from 'node:fs';
import { signTransaction, decodeTransaction } from './src/tx.js';
import { privateToAddress, toChecksumAddress, toHex, keccak256 } from './src/crypto.js';

const RPC = 'https://ethereum-rpc.publicnode.com';
const CHAIN_ID = 1n;
const PUBLISHER = '0x8D1F2713EB83e4D55FBEDA47b26fd08eC9170e14';
const ANCHOR = '0x2beba454d810eac41c6778e351f81d37a07ae03b';
const OLD_BMOLI = '0x5a60f4de4effd2282e271aeee52acdeae0b2d809';
const CRED = 'C:/Users/Administrator/Desktop/Server Ops/CREDENTIALS.md';

const sel = (s) => toHex(keccak256(new TextEncoder().encode(s))).slice(0, 10);
const pad = (h) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const n32 = (v) => pad(BigInt(v).toString(16));
const eth = (w) => (Number(w) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 8 });

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}
const callOld = (data) => rpc('eth_call', [{ to: OLD_BMOLI, data }, 'latest']);

const artifact = JSON.parse(readFileSync(new URL('./bridge/artifacts/BridgedMoli.json', import.meta.url)));
if (!JSON.stringify(artifact.abi).includes('claimVia')) {
  throw new Error('this artifact has no claimVia - recompile with bridge/bridgedmoli-build-and-test.mjs');
}

// --- the key, found by derivation, never by label ---------------------------
let KEY = null;
for (const c of new Set(readFileSync(CRED, 'utf8').match(/\b[0-9a-fA-F]{64}\b/g) ?? [])) {
  try {
    if (toChecksumAddress(privateToAddress(c)).toLowerCase() === PUBLISHER.toLowerCase()) KEY = c;
  } catch { /* not a key */ }
}
if (!KEY) throw new Error(`no key in CREDENTIALS.md derives ${PUBLISHER}`);
console.log('key            : found, derives the publisher (never printed)');

// --- match the OLD contract's parameters, read from chain -------------------
const oldAnchor = '0x' + (await callOld(sel('anchorContract()'))).slice(-40);
const oldWindow = BigInt(await callOld(sel('challengeBlocks()')));
const oldSupply = BigInt(await callOld(sel('totalSupply()')));
console.log(`old bMOLI      : ${OLD_BMOLI}`);
console.log(`  anchor       : ${oldAnchor}`);
console.log(`  challenge    : ${oldWindow} blocks`);
console.log(`  totalSupply  : ${oldSupply}`);

if (oldAnchor.toLowerCase() !== ANCHOR.toLowerCase()) {
  throw new Error(`the old contract points at ${oldAnchor}, not ${ANCHOR} - refusing to guess`);
}
// ⛔ A redeploy while the old token has holders would strand them: there is no
//    migration path and no owner to add one. Zero supply is what makes this safe.
if (oldSupply !== 0n) {
  throw new Error(`the old bMOLI has a supply of ${oldSupply} - holders would be stranded, refusing`);
}

const args = pad(ANCHOR) + n32(oldWindow);
const data = artifact.bytecode + args;

const [gasBal, gasPrice, nonce] = await Promise.all([
  rpc('eth_getBalance', [PUBLISHER, 'latest']).then(BigInt),
  rpc('eth_gasPrice', []).then(BigInt),
  rpc('eth_getTransactionCount', [PUBLISHER, 'pending']).then(BigInt),
]);

// ⛔ Estimate against the real chain rather than guessing a limit. A creation
//    that reverts costs the same gas as one that succeeds.
const gasLimit = BigInt(await rpc('eth_estimateGas', [{ from: PUBLISHER, data }])) * 12n / 10n;
const cost = gasPrice * gasLimit;

console.log(`\npublisher      : ${PUBLISHER}`);
console.log(`  ETH          : ${eth(gasBal)}`);
console.log(`  gas price    : ${(Number(gasPrice) / 1e9).toFixed(4)} gwei`);
console.log(`  gas limit    : ${gasLimit}   cost ≤ ${eth(cost)} ETH`);
if (gasBal < cost) throw new Error(`holds ${eth(gasBal)} ETH, needs ${eth(cost)}`);

const raw = signTransaction({ nonce, gasPrice, gasLimit, to: null, value: 0n, data }, KEY, CHAIN_ID);
// ⛔ Decode the signed bytes and check them against intent. A contract creation
//    with a stray `to` becomes a call to somebody else's address with 11KB of
//    payload, and re-printing the inputs would not have noticed.
const back = decodeTransaction(raw, Number(CHAIN_ID));
const ok = (back.from ?? '').toLowerCase() === PUBLISHER.toLowerCase()
  && (back.to === null || back.to === undefined || back.to === '0x')
  && BigInt(back.value) === 0n
  && (back.data ?? '').toLowerCase() === data.toLowerCase();
console.log(`\ncreate BridgedMoli(${ANCHOR}, ${oldWindow})`);
console.log(`  to     ${back.to ?? 'null (contract creation)'}  ${ok ? '✓' : '⛔ MISMATCH'}`);
console.log(`  from   ${back.from}`);
console.log(`  nonce  ${nonce}`);
if (!ok) throw new Error('signed transaction does not match intent — refusing');

if (!process.argv.includes('--send')) {
  console.log('\nPRE-FLIGHT ONLY — nothing sent. Re-run with --send.');
  process.exit(0);
}

const hash = await rpc('eth_sendRawTransaction', [toHex(raw)]);
console.log(`  sent   ${hash}`);
for (let i = 0; i < 120; i++) {
  const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
  if (r) {
    if (BigInt(r.status) !== 1n) throw new Error('the deployment reverted');
    const address = r.contractAddress;
    console.log(`  mined  block ${BigInt(r.blockNumber)}  gas used ${BigInt(r.gasUsed)}`);
    console.log(`\n✓ BridgedMoli deployed at ${address}`);
    // ⛔ Read the new contract back and check it is what was intended. A
    //    deployment that succeeded is not the same as one that is correct.
    const check = (d) => rpc('eth_call', [{ to: address, data: d }, 'latest']);
    const newAnchor = '0x' + (await check(sel('anchorContract()'))).slice(-40);
    const newWindow = BigInt(await check(sel('challengeBlocks()')));
    const newSupply = BigInt(await check(sel('totalSupply()')));
    console.log(`  anchorContract ${newAnchor}  ${newAnchor.toLowerCase() === ANCHOR.toLowerCase() ? '✓' : '⛔'}`);
    console.log(`  challengeBlocks ${newWindow}  ${newWindow === oldWindow ? '✓' : '⛔'}`);
    console.log(`  totalSupply     ${newSupply}  ${newSupply === 0n ? '✓' : '⛔'}`);
    console.log('\n⛔ Now update every reference to the old address: src/web/bridgedmoli.html,');
    console.log('   ADDRESS-INVENTORY.md, the handoffs, and any wallet-watch button.');
    process.exit(0);
  }
  await new Promise((r2) => setTimeout(r2, 5000));
}
console.warn(`\n⚠ ${hash} has not confirmed yet. It is in the mempool with nonce ${nonce};`);
console.warn('  find the address on a receipt rather than re-sending.');
