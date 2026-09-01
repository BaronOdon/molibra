/**
 * Deploy the BridgedAsset that will carry Coinspirit (WSRO) on Molibra.
 *
 * ⛔ Deploying confers NO authority. The only thing that matters here is the
 * constructor argument: the contract must trust `bridgeAuthority(tokenId)`,
 * a KEYLESS address derived from the asset's own id, or consensus refuses to
 * register it. Whoever pays the gas is irrelevant.
 *
 * ⛔⛔ Becoming the asset's HEADER AUTHORITY is a separate act - the
 * BRIDGE_REGISTER transaction - and it is permanent. That one must be signed
 * by whoever is prepared to stand behind the Ethereum headers this asset
 * rests on.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { signTransaction } from '../src/tx.js';
import { privateToAddress, normalizeAddress, fromHex, toHex, keccak256 } from '../src/crypto.js';
import { foreignTokenId } from '../src/foreign.js';
import { bridgeAuthority } from '../src/bridgemint.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = process.env.MOLIBRA_RPC ?? 'http://193.123.191.142:8545';
const CHAIN_ID = 20226n;
const WSRO = '0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8';

const ART = JSON.parse(readFileSync(join(HERE, '..', 'contracts', 'artifacts', 'pool.json'), 'utf8'));
const raw = readFileSync(join(HERE, '..', 'data', 'treasury.key'), 'utf8').trim();
const priv = fromHex(raw.startsWith('0x') ? raw : '0x' + raw);
const from = normalizeAddress(privateToAddress(priv));

const rpc = async (method, params = []) => {
  const r = await fetch(NODE, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};

const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const utf8hex = (s) => Buffer.from(s).toString('hex');

const tokenId = foreignTokenId(1n, WSRO);
const authority = bridgeAuthority(tokenId);

// constructor(string name_, string symbol_, address bridge_)
const NAME = 'Coinspirit';
const SYMBOL = 'WSRO';
const ctor = word(0x60) + word(0xa0) + authority.slice(2).padStart(64, '0')
  + word(NAME.length) + utf8hex(NAME).padEnd(64, '0')
  + word(SYMBOL.length) + utf8hex(SYMBOL).padEnd(64, '0');

console.log('Deploying BridgedAsset for Coinspirit (WSRO) on Molibra\n');
console.log('  origin       Ethereum chainId 1,', WSRO);
console.log('  token id    ', tokenId);
console.log('  ⛔ bridge_  ', authority, '(keyless — no signature reaches it)');
console.log('  deployer    ', from, '(pays gas only; confers no authority)');

const balance = BigInt(await rpc('eth_getBalance', [from, 'latest']));
console.log('  balance     ', (Number(balance) / 1e18).toFixed(4), 'MOLI\n');
if (balance === 0n) throw new Error('the deployer has no MOLI');

const nonce = BigInt(parseInt(await rpc('eth_getTransactionCount', [from, 'pending']), 16));
const gasPrice = BigInt(await rpc('eth_gasPrice'));
const signed = toHex(signTransaction(
  { nonce, gasPrice, gasLimit: 1_500_000n, to: null, value: 0n, data: ART.BridgedAsset.bytecode + ctor },
  priv, CHAIN_ID));

const hash = await rpc('eth_sendRawTransaction', [signed]);
console.log('submitted   ', hash);
process.stdout.write('waiting');
let r = null;
for (let i = 0; i < 60; i++) {
  await new Promise((s) => setTimeout(s, 5000));
  r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
  if (r) break;
  process.stdout.write('.');
}
console.log();
if (!r) throw new Error('not mined within 5 minutes');
if (r.status !== '0x1') throw new Error('the deploy reverted');

const asset = r.contractAddress;
console.log('⭐ deployed  ', asset, `(gas ${BigInt(r.gasUsed)})`);

// ⛔ Read it back. A deploy that succeeded is not a deploy that trusts the
// right address, and registration will refuse it if it does not.
const call = async (data) => rpc('eth_call', [{ to: asset, data }, 'latest']);
const sel = (s) => toHex(keccak256(new TextEncoder().encode(s))).slice(0, 10);
const trusts = normalizeAddress('0x' + (await call(sel('bridge()'))).slice(-40));
const symbolRaw = await call(sel('symbol()'));
const nameRaw = await call(sel('name()'));
const readStr = (h) => Buffer.from(h.slice(130, 130 + 2 * parseInt(h.slice(66, 130), 16)), 'hex').toString();

console.log('\nread back from the chain:');
console.log('  name       ', readStr(nameRaw));
console.log('  symbol     ', readStr(symbolRaw));
console.log('  bridge()   ', trusts);
console.log('  ⭐ trusts the keyless authority:', trusts === authority);
if (trusts !== authority) {
  console.error('\n⛔⛔ IT DOES NOT. Consensus will refuse to register this contract. Redeploy.');
  process.exit(1);
}
console.log('\nNext: BRIDGE_REGISTER, signed by whoever will be the header authority.');
console.log('      assetContract =', asset);
