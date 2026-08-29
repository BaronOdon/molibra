/**
 * Molibra - cryptographic primitives.
 *
 * Deliberately the same primitives Ethereum uses (secp256k1 + Keccak-256 +
 * 20-byte addresses), because that is what makes an off-the-shelf wallet able
 * to sign for this chain without a custom client.
 */

import { keccak256 as _keccak256 } from 'ethereum-cryptography/keccak.js';
import { secp256k1 } from 'ethereum-cryptography/secp256k1.js';
import { bytesToHex as _bytesToHex, hexToBytes as _hexToBytes } from 'ethereum-cryptography/utils.js';
import { randomBytes } from 'node:crypto';

export const keccak256 = (bytes) => _keccak256(bytes);

/** Bytes -> 0x-prefixed lowercase hex. */
export function toHex(bytes) {
  return '0x' + _bytesToHex(bytes);
}

/** 0x-prefixed (or bare) hex -> bytes. Odd-length input is left-padded. */
export function fromHex(hex) {
  let h = String(hex).startsWith('0x') ? String(hex).slice(2) : String(hex);
  if (h.length % 2 === 1) h = '0' + h;
  if (h.length === 0) return new Uint8Array(0);
  return _hexToBytes(h);
}

/** BigInt -> minimal big-endian bytes (empty for 0, as RLP expects). */
export function bigToBytes(value) {
  let v = BigInt(value);
  if (v < 0n) throw new Error('negative value');
  if (v === 0n) return new Uint8Array(0);
  let h = v.toString(16);
  if (h.length % 2 === 1) h = '0' + h;
  return _hexToBytes(h);
}

/** Big-endian bytes -> BigInt (empty is 0). */
export function bytesToBig(bytes) {
  if (!bytes || bytes.length === 0) return 0n;
  return BigInt('0x' + _bytesToHex(bytes));
}

/** BigInt -> 0x-prefixed minimal hex quantity, per the JSON-RPC convention. */
export function toQuantity(value) {
  return '0x' + BigInt(value).toString(16);
}

/** Concatenate byte arrays. */
export function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** A fresh 32-byte private key. */
export function generatePrivateKey() {
  return new Uint8Array(randomBytes(32));
}

/** Private key -> uncompressed public key without the 0x04 prefix (64 bytes). */
export function privateToPublic(privateKey) {
  return secp256k1.getPublicKey(privateKey, false).slice(1);
}

/** 64-byte public key -> 0x address (last 20 bytes of its Keccak-256). */
export function publicToAddress(publicKey) {
  return toHex(keccak256(publicKey).slice(-20));
}

export function privateToAddress(privateKey) {
  return publicToAddress(privateToPublic(privateKey));
}

/**
 * Sign a 32-byte hash. Returns { r, s, recovery } with r and s as BigInt.
 */
export function sign(msgHash, privateKey) {
  const sig = secp256k1.sign(msgHash, privateKey);
  return { r: sig.r, s: sig.s, recovery: sig.recovery };
}

/**
 * Recover the signer address from a 32-byte hash and signature components.
 * Returns null when the signature does not recover to a point on the curve.
 */
export function recoverAddress(msgHash, r, s, recovery) {
  try {
    const sig = new secp256k1.Signature(BigInt(r), BigInt(s)).addRecoveryBit(Number(recovery));
    const publicKey = sig.recoverPublicKey(msgHash).toRawBytes(false).slice(1);
    return publicToAddress(publicKey);
  } catch {
    return null;
  }
}

/** Normalise an address for comparison and storage. */
export function normalizeAddress(address) {
  if (address === null || address === undefined || address === '0x') return null;
  const hex = String(address).toLowerCase();
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length !== 40 || !/^[0-9a-f]{40}$/.test(body)) {
    throw new Error(`invalid address: ${address}`);
  }
  return '0x' + body;
}

/** EIP-55 mixed-case checksum form, for display. */
export function toChecksumAddress(address) {
  const body = normalizeAddress(address).slice(2);
  const hash = _bytesToHex(keccak256(new TextEncoder().encode(body)));
  let out = '0x';
  for (let i = 0; i < body.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? body[i].toUpperCase() : body[i];
  }
  return out;
}
