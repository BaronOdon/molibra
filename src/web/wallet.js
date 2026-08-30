/**
 * Molibra - the browser-side key, and what protects it.
 *
 * The operator's rule, 30 Aug 2026: a person who already has a wallet adds it
 * BEFORE earning, so the chalk lands where they want it; a person who does not
 * gets a real key generated for them, usable outside this page if they ever
 * want it. Either way **the key and the address belong to the person who
 * earned them, and nobody running the service can read either.**
 *
 * ## How that is achieved, and what it actually guarantees
 *
 * - The private key is generated **in the browser** with `crypto.getRandomValues`
 *   and never leaves it. Not in a request body, not in a log, not in an error.
 * - At rest it is sealed with **AES-256-GCM** under a key derived from the
 *   person's passphrase by **PBKDF2-SHA-256, 600,000 iterations** (the OWASP
 *   2023 figure), with a random 16-byte salt and a random 12-byte IV. What sits
 *   in `localStorage` is ciphertext; without the passphrase it is noise.
 * - The **address is sealed with it**, not stored beside it. An address in the
 *   clear is a permanent handle on somebody's expressions, and "nobody but the
 *   user has access to its address" was the requirement, not a nice-to-have.
 * - Signing happens here too, so the key is used without ever being sent.
 *
 * What this does NOT defend against, stated plainly rather than implied away:
 * whoever serves this page can serve a different one tomorrow. Client-side
 * encryption protects the person from the *stored data* being read - by an
 * administrator, a backup, a stolen laptop, a subpoena of the database - not
 * from a hostile version of the page itself. That is true of every in-browser
 * wallet ever written, and the honest mitigation is that this file is short,
 * open and served from a repository anybody can diff.
 *
 * Runs unmodified in Node (bare specifiers resolve from node_modules) and in
 * the browser (the page declares an import map for the same specifiers), which
 * is what lets `test/wallet.mjs` check the real shipped code rather than a
 * copy of it.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERATIONS = 600000;

const toHex = (bytes) => '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => {
  const h = String(hex).replace(/^0x/, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/* ------------------------------------------------------------------ keys */

/** A real key, from the platform CSPRNG. Not a toy and not a placeholder. */
export function generatePrivateKey() {
  for (;;) {
    const key = new Uint8Array(32);
    globalThis.crypto.getRandomValues(key);
    // Rejection-sample rather than reduce: reducing biases the low end, and a
    // biased key space is a smaller key space.
    const n = BigInt('0x' + Array.from(key, (b) => b.toString(16).padStart(2, '0')).join(''));
    if (n > 0n && n < secp256k1.CURVE.n) return key;
  }
}

/** The Ethereum-style address: last 20 bytes of keccak256 of the public key. */
export function addressFor(privateKey) {
  const pub = secp256k1.getPublicKey(privateKey, false).slice(1); // drop the 0x04 prefix
  return toHex(keccak_256(pub).slice(-20));
}

/* ------------------------------------------------------- sealing at rest */

async function deriveAesKey(passphrase, salt) {
  const material = await globalThis.crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Seal a key and its address under a passphrase. The returned object is what
 * goes to localStorage, and it contains nothing readable: no address, no hint,
 * no length that is not already public.
 */
export async function seal(privateKey, passphrase) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aes = await deriveAesKey(passphrase, salt);
  const plaintext = enc.encode(JSON.stringify({
    privateKey: toHex(privateKey),
    address: addressFor(privateKey),
  }));
  const sealed = new Uint8Array(
    await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, plaintext),
  );
  return {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    cipher: 'AES-256-GCM',
    salt: b64(salt),
    iv: b64(iv),
    data: b64(sealed),
  };
}

/** Open a sealed key. A wrong passphrase throws; AES-GCM will not be guessed. */
export async function open(vault, passphrase) {
  const aes = await deriveAesKey(passphrase, unb64(vault.salt));
  let plaintext;
  try {
    plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(vault.iv) }, aes, unb64(vault.data),
    );
  } catch {
    throw new Error('wrong passphrase');
  }
  const { privateKey, address } = JSON.parse(dec.decode(plaintext));
  return { privateKey: fromHex(privateKey), address };
}

/* -------------------------------------------------------------- signing */

/**
 * Minimal RLP encoder - enough for a legacy transaction, and no more.
 *
 * Vendoring a whole RLP library into the page to encode nine byte strings
 * would be more code to audit, not less. `test/wallet.mjs` checks this against
 * @ethereumjs/rlp over random inputs, so "minimal" does not get to mean
 * "unverified".
 */
function rlpLength(length, offset) {
  if (length < 56) return Uint8Array.of(offset + length);
  const hex = length.toString(16);
  const lenBytes = fromHex(hex.length % 2 ? '0' + hex : hex);
  return Uint8Array.of(offset + 55 + lenBytes.length, ...lenBytes);
}

export function rlpEncode(input) {
  if (Array.isArray(input)) {
    const body = input.map(rlpEncode);
    const total = body.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(0);
    const prefix = rlpLength(total, 0xc0);
    const joined = new Uint8Array(prefix.length + total);
    joined.set(prefix, 0);
    let at = prefix.length;
    for (const part of body) { joined.set(part, at); at += part.length; }
    return joined.length ? joined : out;
  }
  const bytes = input instanceof Uint8Array ? input : fromHex(input);
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  const prefix = rlpLength(bytes.length, 0x80);
  const out = new Uint8Array(prefix.length + bytes.length);
  out.set(prefix, 0);
  out.set(bytes, prefix.length);
  return out;
}

/** BigInt -> minimal big-endian bytes; zero is the empty string, as RLP wants. */
export function toMinimalBytes(value) {
  let n = BigInt(value);
  if (n === 0n) return new Uint8Array(0);
  const hex = n.toString(16);
  return fromHex(hex.length % 2 ? '0' + hex : hex);
}

/**
 * EIP-191 personal_sign, and the linking code the application already knows
 * how to verify (`POST /molibra/verify-proof`).
 *
 * This is what lets the app get an address it can TRUST without ever seeing a
 * key: the page signs a challenge the node issued, the app hands the code
 * back, and the node recovers the signer. The person is returned to the app
 * with proof of control instead of a bare address somebody could have typed.
 */
export function personalSign(message, privateKey) {
  const body = enc.encode(message);
  const prefix = enc.encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix, 0);
  joined.set(body, prefix.length);
  const signature = secp256k1.sign(keccak_256(joined), privateKey);
  const normalized = signature.hasHighS?.() ? signature.normalizeS() : signature;
  const out = new Uint8Array(65);
  out.set(fromHex(normalized.r.toString(16).padStart(64, '0')), 0);
  out.set(fromHex(normalized.s.toString(16).padStart(64, '0')), 32);
  out[64] = normalized.recovery + 27;
  return toHex(out);
}

export function linkingCode({ chainId, address, appAccount, challenge, privateKey }) {
  const message = [
    'Molibra linking proof',
    'chainId: ' + chainId,
    'address: ' + address,
    'app account: ' + appAccount,
    'nonce: ' + challenge.nonce,
    'expires: ' + challenge.expires,
    '',
    'Signing proves control of this address. It moves no funds.',
  ].join('\n');
  const signature = personalSign(message, privateKey);
  return btoa(JSON.stringify({ m: message, s: signature, a: address }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Sign a legacy EIP-155 transaction. The same shape src/tx.js produces, so a
 * transaction signed in the page is indistinguishable from one signed by a
 * desktop wallet - which is the point: this is a real key, not an app account.
 */
export function signTransaction(tx, privateKey, chainId) {
  const fields = [
    toMinimalBytes(tx.nonce),
    toMinimalBytes(tx.gasPrice),
    toMinimalBytes(tx.gasLimit),
    tx.to ? fromHex(tx.to) : new Uint8Array(0),
    toMinimalBytes(tx.value ?? 0n),
    tx.data && tx.data !== '0x' ? fromHex(tx.data) : new Uint8Array(0),
  ];
  const signingPayload = [...fields, toMinimalBytes(chainId), new Uint8Array(0), new Uint8Array(0)];
  const hash = keccak_256(rlpEncode(signingPayload));
  const signature = secp256k1.sign(hash, privateKey);
  // Low-s only. The node refuses the upper half of the curve order (EIP-2),
  // so producing it here would build a transaction this chain will not take.
  const normalized = signature.hasHighS?.() ? signature.normalizeS() : signature;
  const v = BigInt(normalized.recovery) + BigInt(chainId) * 2n + 35n;
  return toHex(rlpEncode([
    ...fields,
    toMinimalBytes(v),
    toMinimalBytes(normalized.r),
    toMinimalBytes(normalized.s),
  ]));
}
