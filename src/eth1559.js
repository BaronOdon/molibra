/**
 * Ethereum type-2 (EIP-1559) transactions, signed locally. CLIENT-SIDE ONLY.
 *
 * Molibra's own transactions are legacy (src/tx.js). Ethereum claims are sent
 * as type 2 so the tip is set EXPLICITLY - `maxPriorityFeePerGas` - rather than
 * folded into a legacy gasPrice, where every wei above the base fee is tip.
 * ⛔ The bridge bot uses 0.05 gwei, never a wallet's default 2 gwei.
 *
 *   signing hash = keccak256(0x02 || rlp([chainId, nonce, maxPriorityFeePerGas,
 *                  maxFeePerGas, gasLimit, to, value, data, accessList]))
 *   raw          = 0x02 || rlp([...those, yParity, r, s])
 *
 * `decodeEip1559` re-derives the sender from the raw bytes, so a caller can
 * read back what it signed before anything leaves the machine.
 */
import { RLP } from '@ethereumjs/rlp';
import {
  keccak256, toHex, fromHex, bigToBytes, bytesToBig, sign, recoverAddress, normalizeAddress,
  concatBytes,
} from './crypto.js';

const fields = (tx) => [
  bigToBytes(tx.chainId),
  bigToBytes(tx.nonce),
  bigToBytes(tx.maxPriorityFeePerGas),
  bigToBytes(tx.maxFeePerGas),
  bigToBytes(tx.gasLimit),
  tx.to ? fromHex(tx.to) : new Uint8Array(0),
  bigToBytes(tx.value ?? 0n),
  tx.data ? fromHex(tx.data) : new Uint8Array(0),
  [],
];

export function eip1559SigningHash(tx) {
  return keccak256(concatBytes(new Uint8Array([2]), RLP.encode(fields(tx))));
}

/** Sign; returns the raw transaction as 0x hex. */
export function signEip1559(tx, privateKey) {
  if (BigInt(tx.maxPriorityFeePerGas) > BigInt(tx.maxFeePerGas)) {
    throw new Error('maxPriorityFeePerGas above maxFeePerGas');
  }
  const { r, s, recovery } = sign(eip1559SigningHash(tx), privateKey);
  const body = RLP.encode([...fields(tx), bigToBytes(BigInt(recovery)), bigToBytes(r), bigToBytes(s)]);
  return toHex(concatBytes(new Uint8Array([2]), body));
}

/** Decode a type-2 raw transaction and recover its sender. */
export function decodeEip1559(raw) {
  const bytes = fromHex(raw);
  if (bytes[0] !== 2) throw new Error('not a type-2 transaction');
  const d = RLP.decode(bytes.slice(1));
  if (!Array.isArray(d) || d.length !== 12) throw new Error('malformed type-2 transaction');
  const tx = {
    chainId: bytesToBig(d[0]),
    nonce: bytesToBig(d[1]),
    maxPriorityFeePerGas: bytesToBig(d[2]),
    maxFeePerGas: bytesToBig(d[3]),
    gasLimit: bytesToBig(d[4]),
    to: d[5].length ? normalizeAddress(toHex(d[5])) : null,
    value: bytesToBig(d[6]),
    data: toHex(d[7]),
  };
  const from = recoverAddress(eip1559SigningHash(tx), bytesToBig(d[10]), bytesToBig(d[11]), Number(bytesToBig(d[9])));
  return { ...tx, from, hash: toHex(keccak256(bytes)) };
}
