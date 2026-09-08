/**
 * Sweep MOLI from the airdrop wallet to the operator's wallet.
 *
 *   node sweep-airdrop.mjs            pre-flight only, signs and sends nothing
 *   node sweep-airdrop.mjs --send     sign and broadcast
 *
 * ⛔ The key is read from Desktop\Server Ops\CREDENTIALS.md and used to sign
 *    LOCALLY. Only the signed transaction goes to the node - the key never
 *    leaves this machine, and is never printed.
 *
 * Uses the chain's own tx code (src/tx.js) rather than a second implementation,
 * so what is signed here is exactly what this chain validates.
 */
import { readFileSync } from 'node:fs';
import { signTransaction, decodeTransaction } from './src/tx.js';
import { privateToAddress, toChecksumAddress, toHex } from './src/crypto.js';

const RPC = 'https://molibra.org';
const CHAIN_ID = 20226n;
const FROM = '0x5851cc5884313f7a66697dE3Bb772466dD5895c7';   // airdrop wallet
const TO = '0xf51ac8FD4112bF1d45fD5C38D5aBfe0c61Ec3F5a';     // the operator
const AMOUNT = 40000n * 10n ** 18n;                          // 40,000 MOLI
const CRED = 'C:/Users/Administrator/Desktop/Server Ops/CREDENTIALS.md';

const rpc = async (method, params) => {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
};
const moli = (w) => (Number(w) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 });

// --- the key, found by derivation rather than by trusting a label -----------
const text = readFileSync(CRED, 'utf8');
let KEY = null;
for (const c of new Set(text.match(/\b(?:0x)?[0-9a-fA-F]{64}\b/g) ?? [])) {
  try {
    if (toChecksumAddress(privateToAddress(c.replace(/^0x/, ''))).toLowerCase() === FROM.toLowerCase()) {
      KEY = c.replace(/^0x/, '');
    }
  } catch { /* not a key */ }
}
if (!KEY) throw new Error('no key in CREDENTIALS.md derives ' + FROM);
console.log('key            : found, derives the from-address (never printed)');

// --- state ------------------------------------------------------------------
const balance = BigInt(await rpc('eth_getBalance', [FROM, 'latest']));
const nonce = BigInt(await rpc('eth_getTransactionCount', [FROM, 'pending']));
const gasPrice = BigInt(await rpc('eth_gasPrice', []));
const gasLimit = 21000n;
const fee = gasPrice * gasLimit;

console.log(`from           : ${FROM}`);
console.log(`to             : ${TO}`);
console.log(`balance        : ${moli(balance)} MOLI`);
console.log(`sending        : ${moli(AMOUNT)} MOLI`);
console.log(`nonce          : ${nonce}`);
console.log(`gas            : ${gasLimit} @ ${gasPrice} wei  = ${moli(fee)} MOLI`);
console.log(`left behind    : ${moli(balance - AMOUNT - fee)} MOLI  (the airdrop pool)`);

if (balance < AMOUNT + fee) throw new Error('balance does not cover amount + fee');

const tx = { nonce, gasPrice, gasLimit, to: TO, value: AMOUNT, data: '0x' };
const raw = signTransaction(tx, KEY, CHAIN_ID);

// ⛔ Decode what was actually signed and check it against intent. A typo in a
//    recipient is unrecoverable, so the signed bytes get read back rather than
//    the inputs re-printed.
const back = decodeTransaction(raw, Number(CHAIN_ID));
const sender = (back.from ?? '').toLowerCase();
const recip = (back.to ?? '').toLowerCase();
console.log('\nsigned bytes decode back to:');
console.log(`  from  ${sender}  ${sender === FROM.toLowerCase() ? '✓' : '⛔ MISMATCH'}`);
console.log(`  to    ${recip}   ${recip === TO.toLowerCase() ? '✓' : '⛔ MISMATCH'}`);
console.log(`  value ${moli(back.value)} MOLI  ${BigInt(back.value) === AMOUNT ? '✓' : '⛔ MISMATCH'}`);
if (sender !== FROM.toLowerCase() || recip !== TO.toLowerCase() || BigInt(back.value) !== AMOUNT) {
  throw new Error('the signed transaction does not match intent - refusing');
}

if (!process.argv.includes('--send')) {
  console.log('\nPRE-FLIGHT ONLY - nothing signed away, nothing sent. Re-run with --send.');
  process.exit(0);
}

const hash = await rpc('eth_sendRawTransaction', [toHex(raw)]);
console.log(`\nbroadcast: ${hash}`);
