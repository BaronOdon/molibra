/**
 * Molibra - the outbound side of a bridge instruction.
 *
 * A bridge-out is an ordinary signed transaction whose data says where value
 * should go on the other side:
 *
 *   BRIDGE_OUT ‖ recipient(20) ‖ amount(32)
 *
 * It moves nothing on Molibra. It is a statement the sender signed, and the
 * transaction hash commits to that signature - which is exactly why the
 * contract on the far side can take its instruction FROM the proved
 * transaction instead of from whoever submits the proof. A bridge that lets the
 * submitter name the recipient has made the proof decoration.
 *
 * ⛔ What may cross is decided by `mayCrossABridge` in src/proof.js, not here.
 * MOLI is an ordinary coin and an ordinary question; GIZ never crosses.
 */

import { keccak256, toHex, fromHex, concatBytes, normalizeAddress } from './crypto.js';

export const BRIDGE_OUT_TAG =
  toHex(keccak256(new TextEncoder().encode('bridgeOut(address,uint256)'))).slice(0, 10);

/** Build the `data` for a bridge-out instruction. */
export function encodeBridgeOut(recipient, amount) {
  const value = BigInt(amount);
  if (value <= 0n) throw new Error('a bridge-out must be positive');
  const hex = value.toString(16).padStart(64, '0');
  if (hex.length !== 64) throw new Error('amount does not fit in 32 bytes');
  return toHex(concatBytes(
    fromHex(BRIDGE_OUT_TAG),
    fromHex(normalizeAddress(recipient)),
    fromHex('0x' + hex),
  ));
}

/** null when the data is not a bridge-out; throws when tagged but malformed. */
export function decodeBridgeOut(data) {
  if (!data || !String(data).toLowerCase().startsWith(BRIDGE_OUT_TAG)) return null;
  const hex = String(data).toLowerCase();
  if (hex.length !== 2 + 8 + 40 + 64) {
    throw new Error('malformed bridge-out: expected tag + recipient + amount');
  }
  return {
    recipient: '0x' + hex.slice(10, 50),
    amount: BigInt('0x' + hex.slice(50, 114)),
  };
}
