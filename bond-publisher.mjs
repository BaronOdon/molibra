/**
 * Steps 3 and 4: approve the bond, then bond it — signed BY the publisher.
 *
 *   node bond-publisher.mjs            pre-flight; signs nothing, sends nothing
 *   node bond-publisher.mjs --send     do it
 *
 * ⛔ Steps 1 and 2 (send it ETH, send it WSRO) come from the operator's wallet
 *    in a wallet app. This script only does the two that MUST be signed by the
 *    publisher itself: MolibraAnchor records `bondOf[msg.sender]`, so bonding
 *    from any other address bonds that address instead — which would defeat the
 *    entire point of having a separate publisher.
 *
 * ⛔ The key is read from CREDENTIALS.md, matched by DERIVING the address rather
 *    than trusting a label, used to sign locally, and never printed. Only signed
 *    transactions reach the network.
 */
import { readFileSync } from 'node:fs';
import { signTransaction, decodeTransaction } from './src/tx.js';
import { privateToAddress, toChecksumAddress, toHex, keccak256 } from './src/crypto.js';

const RPC = 'https://ethereum-rpc.publicnode.com';
const CHAIN_ID = 1n;                                   // Ethereum mainnet
const PUBLISHER = '0x8D1F2713EB83e4D55FBEDA47b26fd08eC9170e14';
const WSRO = '0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8';
const ANCHOR = '0x2beba454d810eac41c6778e351f81d37a07ae03b';
const BOND = 20000n * 10n ** 18n;
const CRED = 'C:/Users/Administrator/Desktop/Server Ops/CREDENTIALS.md';

// The repo's own keccak, not @noble directly: @noble/hashes does not export
// ./sha3.js as a subpath, and src/crypto.js already wraps it correctly.
const sel = (s) => toHex(keccak256(new TextEncoder().encode(s))).slice(0, 10);
const pad = (h) => h.replace(/^0x/, '').padStart(64, '0');
const n32 = (v) => pad(BigInt(v).toString(16));
const eth = (w) => (Number(w) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 });

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const call = (to, data) => rpc('eth_call', [{ to, data, from: PUBLISHER }, 'latest']);

// --- the key, found by derivation, never by label ---------------------------
let KEY = null;
for (const c of new Set(readFileSync(CRED, 'utf8').match(/\b[0-9a-fA-F]{64}\b/g) ?? [])) {
  try {
    if (toChecksumAddress(privateToAddress(c)).toLowerCase() === PUBLISHER.toLowerCase()) KEY = c;
  } catch { /* not a key */ }
}
if (!KEY) throw new Error(`no key in CREDENTIALS.md derives ${PUBLISHER}`);
console.log('key            : found, derives the publisher (never printed)');

// --- can it even do this? ---------------------------------------------------
const gasBal = BigInt(await rpc('eth_getBalance', [PUBLISHER, 'latest']));
const wsro = BigInt(await call(WSRO, sel('balanceOf(address)') + pad(PUBLISHER)));
const bonded = BigInt(await call(ANCHOR, sel('bondOf(address)') + pad(PUBLISHER)));
const minBond = BigInt(await call(ANCHOR, sel('minimumBond()')));
const gasPrice = BigInt(await rpc('eth_gasPrice', []));

console.log(`publisher      : ${PUBLISHER}`);
console.log(`  ETH for gas  : ${eth(gasBal)}`);
console.log(`  WSRO held    : ${eth(wsro)}`);
console.log(`  already bonded: ${eth(bonded)}  (minimum ${eth(minBond)})`);
console.log(`  gas price    : ${(Number(gasPrice) / 1e9).toFixed(3)} gwei`);

const problems = [];
if (wsro < BOND) problems.push(`needs ${eth(BOND)} WSRO, holds ${eth(wsro)} — do step 2 first`);
if (gasBal === 0n) problems.push('holds no ETH for gas — do step 1 first');
if (bonded >= minBond) problems.push(`already bonded ${eth(bonded)} — nothing to do`);
if (problems.length) {
  console.log('\nNot ready:');
  for (const p of problems) console.log('  ⛔ ' + p);
  process.exit(1);
}

// --- build, sign, and READ BACK what was signed -----------------------------
async function send(label, to, data, gasLimit, nonce) {
  const tx = { nonce, gasPrice, gasLimit, to, value: 0n, data };
  const raw = signTransaction(tx, KEY, CHAIN_ID);
  // ⛔ Decode the signed bytes and check them against intent. Re-printing the
  //    inputs proves nothing; a wrong `to` on mainnet is unrecoverable.
  const back = decodeTransaction(raw, Number(CHAIN_ID));
  const ok = (back.from ?? '').toLowerCase() === PUBLISHER.toLowerCase()
    && (back.to ?? '').toLowerCase() === to.toLowerCase()
    && BigInt(back.value) === 0n;
  console.log(`\n${label}`);
  console.log(`  to     ${back.to}  ${ok ? '✓' : '⛔ MISMATCH'}`);
  console.log(`  from   ${back.from}`);
  console.log(`  nonce  ${nonce}  gas ${gasLimit}  cost ≤ ${eth(gasPrice * gasLimit)} ETH`);
  if (!ok) throw new Error('signed transaction does not match intent — refusing');
  if (!process.argv.includes('--send')) return null;
  const hash = await rpc('eth_sendRawTransaction', [toHex(raw)]);
  console.log(`  sent   ${hash}`);
  // ⛔ bond() will revert if the approve is not mined yet, so wait for it.
  for (let i = 0; i < 60; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) {
      console.log(`  mined  block ${BigInt(r.blockNumber)}  status ${BigInt(r.status) === 1n ? 'OK' : 'FAILED'}`);
      if (BigInt(r.status) !== 1n) throw new Error(`${label} reverted on chain`);
      return hash;
    }
    await new Promise((r2) => setTimeout(r2, 5000));
  }
  throw new Error(`${label} did not confirm in 5 minutes`);
}

let nonce = BigInt(await rpc('eth_getTransactionCount', [PUBLISHER, 'pending']));
await send('3. approve', WSRO, sel('approve(address,uint256)') + pad(ANCHOR) + n32(BOND), 60000n, nonce);
nonce += 1n;
await send('4. bond', ANCHOR, sel('bond(uint256)') + n32(BOND), 150000n, nonce);

if (!process.argv.includes('--send')) {
  console.log('\nPRE-FLIGHT ONLY — nothing sent. Re-run with --send.');
} else {
  const now = BigInt(await call(ANCHOR, sel('bondOf(address)') + pad(PUBLISHER)));
  console.log(`\nbondOf(publisher) is now ${eth(now)} WSRO`);
  console.log(now >= minBond
    ? '✓ the publisher can now publish anchors'
    : '⛔ still below the minimum — check the transactions above');
}
