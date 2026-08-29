/**
 * Molibra - transactions.
 *
 * Legacy (type 0) transactions with EIP-155 replay protection. This is the
 * format every wallet can produce, and pinning the chain id into the signed
 * payload is what stops a Molibra transaction being replayed on another chain
 * (and vice versa).
 */

import { RLP } from '@ethereumjs/rlp';
import {
  keccak256, toHex, fromHex, bigToBytes, bytesToBig,
  sign, recoverAddress, normalizeAddress,
} from './crypto.js';

/**
 * The payload that gets signed: rlp([nonce, gasPrice, gasLimit, to, value,
 * data, chainId, 0, 0]).
 */
export function signingHash(tx, chainId) {
  const items = [
    bigToBytes(tx.nonce),
    bigToBytes(tx.gasPrice),
    bigToBytes(tx.gasLimit),
    tx.to ? fromHex(tx.to) : new Uint8Array(0),
    bigToBytes(tx.value),
    tx.data ? fromHex(tx.data) : new Uint8Array(0),
    bigToBytes(chainId),
    new Uint8Array(0),
    new Uint8Array(0),
  ];
  return keccak256(RLP.encode(items));
}

/** Sign a transaction, returning the raw bytes a node would accept. */
export function signTransaction(tx, privateKey, chainId) {
  const hash = signingHash(tx, chainId);
  const { r, s, recovery } = sign(hash, privateKey);
  const v = BigInt(recovery) + BigInt(chainId) * 2n + 35n;
  const items = [
    bigToBytes(tx.nonce),
    bigToBytes(tx.gasPrice),
    bigToBytes(tx.gasLimit),
    tx.to ? fromHex(tx.to) : new Uint8Array(0),
    bigToBytes(tx.value),
    tx.data ? fromHex(tx.data) : new Uint8Array(0),
    bigToBytes(v),
    bigToBytes(r),
    bigToBytes(s),
  ];
  return RLP.encode(items);
}

/**
 * Decode raw transaction bytes and recover the sender.
 * Throws when the encoding is malformed, the chain id is wrong, or the
 * signature does not recover.
 */
export function decodeTransaction(raw, chainId) {
  const bytes = raw instanceof Uint8Array ? raw : fromHex(raw);
  const decoded = RLP.decode(bytes);
  if (!Array.isArray(decoded) || decoded.length !== 9) {
    throw new Error('malformed transaction: expected 9 RLP items');
  }
  const [nonce, gasPrice, gasLimit, to, value, data, v, r, s] = decoded;

  const vBig = bytesToBig(v);
  if (vBig < 35n) throw new Error('unprotected transaction: EIP-155 required');
  const txChainId = (vBig - 35n) / 2n;
  if (txChainId !== BigInt(chainId)) {
    throw new Error(`wrong chain id: transaction is for ${txChainId}, this chain is ${chainId}`);
  }
  const recovery = Number((vBig - 35n) % 2n);

  const tx = {
    nonce: bytesToBig(nonce),
    gasPrice: bytesToBig(gasPrice),
    gasLimit: bytesToBig(gasLimit),
    to: to.length ? normalizeAddress(toHex(to)) : null,
    value: bytesToBig(value),
    data: toHex(data),
  };

  const from = recoverAddress(signingHash(tx, chainId), bytesToBig(r), bytesToBig(s), recovery);
  if (!from) throw new Error('signature does not recover to a valid public key');

  return {
    ...tx,
    v: vBig,
    r: bytesToBig(r),
    s: bytesToBig(s),
    from,
    hash: toHex(keccak256(bytes)),
    raw: toHex(bytes),
  };
}

/** Intrinsic gas. v0.1 has no EVM, so this is the transfer cost plus data. */
export const GAS_TRANSFER = 21000n;
export const GAS_PER_ZERO_BYTE = 4n;
export const GAS_PER_NONZERO_BYTE = 16n;

export function intrinsicGas(tx) {
  let gas = GAS_TRANSFER;
  const data = tx.data ? fromHex(tx.data) : new Uint8Array(0);
  for (const byte of data) {
    gas += byte === 0 ? GAS_PER_ZERO_BYTE : GAS_PER_NONZERO_BYTE;
  }
  return gas;
}
