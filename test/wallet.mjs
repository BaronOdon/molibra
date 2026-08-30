/**
 * The browser wallet, checked against the node's own primitives.
 *
 * `src/web/wallet.js` is the file the page loads. It runs unmodified here
 * because its imports are bare specifiers that Node resolves from
 * node_modules and the browser resolves through the page's import map - so
 * this tests the shipped code, not a copy of it.
 *
 * The bar: a key generated in a browser must be a REAL key. Its address must
 * match what the node derives, and a transaction it signs must be one the node
 * accepts, mines, and attributes to that address. Anything less is an app
 * account wearing a wallet's clothes.
 */

import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RLP } from '@ethereumjs/rlp';

import * as wallet from '../src/web/wallet.js';
import { Chain } from '../src/chain.js';
import { decodeTransaction } from '../src/tx.js';
import { privateToAddress, toHex, fromHex } from '../src/crypto.js';
import { encodeExpress, encodeTokenCreate, encodeIssue, tokenId } from '../src/token.js';
import { toPollId } from '../src/vote.js';
import { signTransaction as nodeSign } from '../src/tx.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENESIS = join(ROOT, 'genesis.json');
const dirs = [];
const scratch = (n) => { const d = mkdtempSync(join(tmpdir(), `molibra-wallet-${n}-`)); dirs.push(d); return d; };

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('browser wallet (src/web/wallet.js)\n');

// --- a real key, and an address the node agrees with ----------------------
let agreed = 0;
for (let i = 0; i < 50; i++) {
  const key = wallet.generatePrivateKey();
  if (wallet.addressFor(key) === privateToAddress(key)) agreed++;
}
check('a key generated in the page derives the address the NODE derives',
  agreed === 50, `${agreed}/50`);

const k = wallet.generatePrivateKey();
check('the key is 32 bytes from the platform CSPRNG, not a placeholder',
  k.length === 32 && k.some((b) => b !== 0));

// --- RLP, checked rather than trusted -------------------------------------
let rlpMatches = 0;
for (let i = 0; i < 200; i++) {
  const items = [];
  for (let j = 0; j < 1 + Math.floor(Math.random() * 6); j++) {
    const len = Math.floor(Math.random() * 80);
    const bytes = new Uint8Array(len);
    globalThis.crypto.getRandomValues(bytes);
    items.push(bytes);
  }
  if (toHex(wallet.rlpEncode(items)) === toHex(RLP.encode(items))) rlpMatches++;
}
check('the page\'s minimal RLP encoder matches @ethereumjs/rlp on 200 random inputs',
  rlpMatches === 200, `${rlpMatches}/200`);

// --- a signed transaction the node accepts --------------------------------
const chain = new Chain(Chain.loadGenesis(GENESIS), scratch('chain')).init();
const MINER = privateToAddress(fromHex('0x' + '01'.repeat(32)));
for (let i = 0; i < 4; i++) chain.mine(MINER);

const userKey = wallet.generatePrivateKey();
const userAddress = wallet.addressFor(userKey);
const raw = wallet.signTransaction(
  { nonce: 0n, gasPrice: 1000000000n, gasLimit: 21000n, to: MINER, value: 0n, data: '0x' },
  userKey, chain.chainId,
);
const decoded = decodeTransaction(raw, chain.chainId);
check('a transaction signed in the page decodes on the node', decoded.from === userAddress,
  decoded.from.slice(0, 12));
check('and its signature is low-s, which the node now requires',
  decoded.s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n,
  'EIP-2: a high-s signature would be refused outright');

// The same transaction, byte for byte, from the node's own signer.
const fromNode = toHex(nodeSign(
  { nonce: 0n, gasPrice: 1000000000n, gasLimit: 21000n, to: MINER, value: 0n, data: '0x' },
  userKey, chain.chainId,
));
check('page-signed and node-signed bytes are identical for the same input',
  raw === fromNode, 'not merely compatible - the same transaction');

// --- and it actually works end to end -------------------------------------
// The full path the operator described: a person with no wallet gets a key,
// is issued chalk, and speaks with it. No funding by hand at any point.
const COST = 10n ** 15n;
const record = {
  title: 'Chalk (GIZ) for the wallet test', options: ['a', 'b'], voteMode: 'quantum',
  initialSupply: '0', maxSupply: '0', expressionCost: COST.toString(),
  issuable: true, purpose: 'purchase', transferable: false,
};
const MINER_KEY = fromHex('0x' + '01'.repeat(32));
const createHash = chain.submitRaw(toHex(nodeSign(
  { nonce: 0n, gasPrice: 1000000000n, gasLimit: 300000n, to: MINER, value: 0n,
    data: encodeTokenCreate(record) }, MINER_KEY, chain.chainId)));
chain.mine(MINER);
const GIZ = tokenId(MINER, record.title, BigInt(chain.txIndex.get(createHash).blockNumber));

// The publisher issues chalk AND the fare to the freshly generated address.
chain.submitRaw(toHex(nodeSign(
  { nonce: 1n, gasPrice: 1000000000n, gasLimit: 120000n, to: userAddress, value: 0n,
    data: encodeIssue(GIZ, COST * 20n) }, MINER_KEY, chain.chainId)));
chain.submitRaw(toHex(nodeSign(
  { nonce: 2n, gasPrice: 1000000000n, gasLimit: 21000n, to: userAddress,
    value: 10n ** 16n, data: '0x' }, MINER_KEY, chain.chainId)));
chain.mine(MINER);
check('the freshly generated address received chalk and the fare',
  chain.state.tokenBalanceOf(GIZ, userAddress) === COST * 20n
  && chain.state.balanceOf(userAddress) === 10n ** 16n);

const spoke = chain.submitRaw(wallet.signTransaction(
  { nonce: 0n, gasPrice: 1000000000n, gasLimit: 300000n, to: userAddress, value: 0n,
    data: encodeExpress(GIZ, toPollId('wallet-test-question'), '0x' + '11'.repeat(32), COST) },
  userKey, chain.chainId,
));
chain.mine(MINER);
check('a key created in a browser can EXPRESS, signed in the page',
  chain.receiptFor(spoke).status === 1
  && chain.state.tokenBalanceOf(GIZ, userAddress) === COST * 19n,
  'the person never touched a seed phrase, a faucet or an exchange');

// --- sealing at rest ------------------------------------------------------
const vault = await wallet.seal(userKey, 'correct horse battery staple');
const serialized = JSON.stringify(vault);
check('what goes to storage contains neither the key nor the address',
  !serialized.includes(toHex(userKey).slice(2))
  && !serialized.toLowerCase().includes(userAddress.slice(2).toLowerCase()),
  'the address is sealed WITH the key - it is a permanent handle on somebody');
check('the sealing parameters are declared in the record itself',
  vault.cipher === 'AES-256-GCM' && vault.kdf === 'PBKDF2-SHA256'
  && vault.iterations === wallet.PBKDF2_ITERATIONS,
  `${wallet.PBKDF2_ITERATIONS.toLocaleString()} iterations`);

const opened = await wallet.open(vault, 'correct horse battery staple');
check('the right passphrase returns exactly what was sealed',
  toHex(opened.privateKey) === toHex(userKey) && opened.address === userAddress);

let wrong = false;
try { await wallet.open(vault, 'correct horse battery stapl'); }
catch (e) { wrong = /wrong passphrase/.test(e.message); }
check('a wrong passphrase is refused by the cipher, not by a comparison', wrong,
  'AES-GCM authenticates; there is nothing to guess against');

const second = await wallet.seal(userKey, 'correct horse battery staple');
check('sealing the same key twice produces different ciphertext',
  second.data !== vault.data && second.salt !== vault.salt && second.iv !== vault.iv,
  'fresh salt and IV every time');

// --- the proof the app trusts --------------------------------------------
// The person is returned to the app with PROOF of control, not a bare address
// somebody could have typed. The node's own verifier is the judge of that.
const { Node } = await import('../src/node.js');
const { verifyLinkingProof } = await import('../src/rpc.js');
const proofNode = new Node({ genesisPath: GENESIS, dataDir: scratch('proof') });
const nonce = '0x' + '7f'.repeat(16);
const expires = new Date(Date.now() + 600000).toISOString();
proofNode.challenges.set(nonce, Date.parse(expires));

const code = wallet.linkingCode({
  chainId: proofNode.chain.chainId,
  address: userAddress,
  appAccount: 'app-account-42',
  challenge: { nonce, expires },
  privateKey: userKey,
});
const verified = verifyLinkingProof(proofNode, code);
check('a linking proof signed IN THE PAGE verifies on the node',
  verified.address === userAddress && verified.appAccount === 'app-account-42',
  'the app learns the address without ever seeing the key');

let replayed = false;
try { verifyLinkingProof(proofNode, code); }
catch (e) { replayed = /already-used|unknown/.test(e.message); }
check('and the challenge is single-use, so the code cannot be replayed', replayed);

console.log(`\n${pass} passed, ${fail} failed`);
for (const d of dirs) rmSync(d, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
