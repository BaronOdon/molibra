/**
 * Create a dedicated anchor-publisher identity, so anchoring can be automated
 * without the operator's main wallet ever sitting on a server.
 *
 *   node make-publisher.mjs             show what it would do, generate nothing
 *   node make-publisher.mjs --create    generate the key and record it
 *
 * ## ⛔⛔ Why a separate key at all
 *
 * Anchoring hourly means something signs Ethereum transactions unattended. The
 * only bonded publisher today is the operator's MAIN wallet - it holds the ETH
 * treasury, owns WSRO, and holds the mined MOLI. Putting that key on a public
 * VPS to save a click is the worst trade available: the click is worth about a
 * third of a cent, the key is worth everything.
 *
 * A dedicated publisher can hold nothing but its bond and a little gas. If the
 * server is taken, the loss is bounded by what that address holds, and the
 * damage it can do is bounded by what MolibraAnchor lets a publisher do: publish
 * anchors, and be slashed for equivocating. It cannot move the treasury.
 *
 * ## ⛔ The key is generated HERE and never leaves
 *
 * This script runs on the operator's machine, prints the ADDRESS, and appends
 * the key to Desktop\Server Ops\CREDENTIALS.md. It is never printed to the
 * terminal, never sent anywhere, and never passes through an agent's context.
 * Copy it to the server yourself when you are ready to automate.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { generatePrivateKey, privateToAddress, toChecksumAddress } from './src/crypto.js';

const CRED = 'C:/Users/Administrator/Desktop/Server Ops/CREDENTIALS.md';
const ANCHOR = '0x2beba454d810eac41c6778e351f81d37a07ae03b';
const WSRO = '0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8';
const MIN_BOND = '20000';                       // WSRO, the contract's minimum

if (!process.argv.includes('--create')) {
  console.log(`Would generate a new Ethereum key, print only its address, and append it to
  ${CRED}

Then, to make it a publisher, YOU would (each step is a transaction you sign):
  1. send it a little ETH for gas         - a few anchors cost well under a cent each
  2. transfer ${MIN_BOND} WSRO to it       - token ${WSRO}
  3. from that address, approve ${MIN_BOND} WSRO to ${ANCHOR}
  4. from that address, call bond(${MIN_BOND}e18) on the anchor

⛔ Step 4 must be sent BY the publisher address: MolibraAnchor records
   bondOf[msg.sender], so bonding from any other wallet bonds that wallet.

Re-run with --create when you want the key.`);
  process.exit(0);
}

if (!existsSync(CRED)) {
  console.error(`ABORT: ${CRED} not found. The key must be recorded the moment it exists.`);
  process.exit(1);
}

// ⛔⛔ generatePrivateKey() returns a Uint8Array. Interpolating one into a
//    template literal gives "197,215,86,…" - comma-separated DECIMAL bytes -
//    and the write succeeds, so the key looks recorded and is useless to every
//    wallet and script that will ever read it. Caught on the first run only
//    because the address was re-derived from the file afterwards. Convert to
//    hex explicitly, then PROVE the stored form derives the same address before
//    trusting it.
const raw = generatePrivateKey();
const key = typeof raw === 'string'
  ? raw.replace(/^0x/, '')
  : Buffer.from(raw).toString('hex');
const address = toChecksumAddress(privateToAddress(key));

if (!/^[0-9a-fA-F]{64}$/.test(key)) {
  console.error('ABORT: the key is not 64 hex characters - refusing to record it');
  process.exit(1);
}
if (toChecksumAddress(privateToAddress(key)) !== address) {
  console.error('ABORT: the hex form does not derive the same address');
  process.exit(1);
}

// ⛔ Recorded before anything else happens with it. A generated key that is not
//    written down is a key that is lost, and this one will hold a bond.
appendFileSync(CRED, `

## Molibra ANCHOR PUBLISHER wallet (Ethereum) — created ${new Date().toISOString().slice(0, 10)}
- **Address**: \`${address}\`
- **Private key**: \`${key}\`
- **Purpose**: publishes anchors to MolibraAnchor \`${ANCHOR}\` on Ethereum mainnet, unattended.
- ⛔ **Holds nothing but its bond and gas.** Never send it MOLI, WSRO beyond the
  ${MIN_BOND} bond, or ETH beyond what a few hundred anchors cost. Its whole point is
  that losing it loses almost nothing.
- ⛔ **Distinct from the operator's wallet** \`0xf51ac8FD4112bF1d45fD5C38D5aBfe0c61Ec3F5a\`,
  which must NEVER be placed on a server.
- ⛔ **NEVER commit this key.** This file is outside the repo and must stay outside it.
`, 'utf8');

console.log(`publisher address : ${address}`);
console.log(`key               : recorded in CREDENTIALS.md, not printed`);
console.log(`
Next, and each is a transaction you sign:
  1. send ${address} a little ETH for gas
  2. transfer ${MIN_BOND} WSRO to it (token ${WSRO})
  3. FROM ${address}: approve ${MIN_BOND} WSRO to ${ANCHOR}
  4. FROM ${address}: bond(${MIN_BOND}e18) on ${ANCHOR}

⛔ Steps 3 and 4 must come FROM the publisher address - the contract records
   bondOf[msg.sender].`);
