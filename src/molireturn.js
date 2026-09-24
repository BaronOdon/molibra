/**
 * Molibra - bringing MOLI back.
 *
 * `moliburn.js` is the way out: MOLI is destroyed here and bMOLI is minted on
 * Ethereum against the proved burn. This is the way back, and it is the mirror
 * image of that, with one deliberate difference.
 *
 * ## The return vault is an address nobody can spend from
 *
 * bMOLI has no `burn`, and it refuses transfers to the zero address, so a unit
 * of it cannot be destroyed on Ethereum. It does not need to be. A unit sent to
 * an address that NO KEY CONTROLS is out of circulation exactly as surely as a
 * destroyed one - and it is visible, countable, and permanent:
 *
 *     MOLI_RETURN_ADDRESS = last 20 bytes of keccak256("molibra:moli-return:v1")
 *
 * The same construction as every bridge authority in `bridgemint.js`: an
 * address that is a HASH image rather than a public-key image. Spending from it
 * would need a private key whose public key hashes to a value chosen by a
 * string - a 2^160 search. Nobody holds that key, and anybody can re-derive the
 * address from this line and check.
 *
 * So returning is ONE ordinary ERC-20 transfer in any wallet - no approve, no
 * contract to deploy, nothing to pay for up front - and on Ethereum:
 *
 *     circulating bMOLI = totalSupply - balanceOf(MOLI_RETURN_ADDRESS)
 *
 * ## ⛔ Who is paid here
 *
 * The SENDER of the transfer, at the same address on Molibra. A Transfer log
 * names who sent and who received; it names nobody on another chain, so the
 * only recipient consensus can read out of it without trusting the claimant is
 * the sender. Letting the claimant name the recipient is how a watcher steals a
 * return by submitting it first.
 *
 * ⚠ Consequence, stated where people will read it: send from a wallet whose key
 * you hold. A return sent from a contract - a swap router, a Safe - pays that
 * contract's address here, where it has no key.
 *
 * ## ⛔⛔ The bound that makes a wrong header survivable
 *
 *     returned  <=  burned
 *
 * Checked in consensus on every return. MOLI can come back only as MOLI that
 * went out, so even a fabricated Ethereum header can release no more than what
 * is outstanding across the bridge - 501 MOLI on the day this was written -
 * rather than an unbounded mint.
 *
 * ## The trusted half, named
 *
 * A receipt proof is trustless: it shows the transfer is in a block with a
 * given `receiptsRoot`. That the root belongs to a canonical Ethereum block is
 * the word of `ETH_HEADER_AUTHORITY`, committed publicly on this chain through
 * HEADER_COMMIT and refutable by anybody with an Ethereum node. The same trust
 * model as the WSRO leg, and bounded by the line above.
 */

import { RLP } from '@ethereumjs/rlp';
import { keccak256, toHex, fromHex, concatBytes, normalizeAddress } from './crypto.js';
import { verifyProof, decodeReceipt, TRANSFER_TOPIC } from './burnproof.js';

const utf8 = (s) => new TextEncoder().encode(s);
const word = (v) => BigInt(v).toString(16).padStart(64, '0');

/**
 * ⛔⛔ The flag day for the return leg AND for three fixes to the inbound
 * bridge that ship with it (see `state.js`). Below this height every rule here
 * is off and the payload is ordinary data - exactly what a node on the old
 * code does with it - so upgraded and un-upgraded nodes agree on all history.
 *
 * Divergence is triggered by a TRANSACTION, not by the height: a late node
 * agrees on every block until somebody actually submits a return, a header
 * commit from a non-authority, or a replayed WSRO claim above it.
 *
 * Set 24 Sep 2026 at tip ~110,400, ~2,800 blocks a day: about 2.7 days.
 * ⛔ Free to change until the first block at or above it is mined; frozen after.
 */
export const BRIDGE_V2_ACTIVATION = 118_000n;

/** Ethereum mainnet: the only origin chain whose headers this leg reads. */
export const ETH_CHAIN_ID = 1n;

/**
 * Whose committed Ethereum receipts roots count, from the flag day on.
 *
 * ⛔ Before it, ANY address that had registered an asset on chain 1 could
 * commit chain-1 headers, and a claim used whatever root was committed first -
 * so anybody could register a throwaway asset, commit a fabricated root, and
 * mint WSRO against it, or squat a real burn's block with junk and strand it.
 * One named authority closes both. It is the operator's wallet, which is
 * already WSRO's registrar and the committer of the only root on record.
 */
export const ETH_HEADER_AUTHORITY = '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a';

/** bMOLI on Ethereum. The only contract whose transfers count as a return. */
export const BMOLI_CONTRACT = '0xa302877efb74f567f3605851194b46f1d5746822';

/** The keyless return vault. Derived, never typed: see the header. */
export const MOLI_RETURN_ADDRESS = normalizeAddress(
  '0x' + toHex(keccak256(utf8('molibra:moli-return:v1'))).slice(-40));

export const MOLI_RETURN_TAG = toHex(keccak256(utf8('moliReturn(uint256,uint256,bytes)'))).slice(0, 10);

/**
 * A receipt is identified by WHERE IT IS - chain, block, index - because that
 * is what the proof proves. An Ethereum transaction hash supplied alongside a
 * proof is never checked by it (a receipt does not contain its own hash), so a
 * key built from one is a key the claimant chooses, and a replay is one new
 * hash away. Every key from the flag day on is positional.
 */
export function receiptPositionKey(namespace, chainId, blockNumber, txIndex) {
  return toHex(keccak256(concatBytes(
    utf8(`molibra:${namespace}:v1`),
    fromHex('0x' + word(chainId)),
    fromHex('0x' + word(blockNumber)),
    fromHex('0x' + word(txIndex)),
  )));
}

export const returnKey = (blockNumber, txIndex) =>
  receiptPositionKey('moli-return', ETH_CHAIN_ID, blockNumber, txIndex);

export const inboundPositionKey = (chainId, blockNumber, txIndex) =>
  receiptPositionKey('inbound-position', chainId, blockNumber, txIndex);

/**
 * WSRO claims honoured before positional keys existed, by position. Only one
 * was ever made (2,000 WSRO, Ethereum tx 0x1caebe63…ace8, verified 24 Sep
 * 2026 against the live receipt). Without this list that receipt could be
 * claimed a second time under an invented transaction hash.
 */
export const HISTORICAL_INBOUND_POSITIONS = new Set([
  inboundPositionKey(1n, 25_882_760n, 291n),
]);

/* ---------------------------------------------------------------- payload */

/** MOLI_RETURN + ethBlockNumber(32) + txIndex(32) + rlp([...proof nodes]) */
export function encodeMoliReturn({ blockNumber, txIndex, proof }) {
  if (!Array.isArray(proof) || proof.length === 0) {
    throw new Error('a return carries its proof; an empty proof proves nothing');
  }
  const nodes = proof.map((n) => (n instanceof Uint8Array ? n : fromHex(n)));
  return toHex(concatBytes(
    fromHex(MOLI_RETURN_TAG),
    fromHex('0x' + word(blockNumber)),
    fromHex('0x' + word(txIndex)),
    RLP.encode(nodes),
  ));
}

/** null when the data is not a return; throws when tagged but malformed. */
export function decodeMoliReturn(data) {
  if (!data) return null;
  const hex = String(data instanceof Uint8Array ? toHex(data) : data).toLowerCase().replace(/^0x/, '');
  if ('0x' + hex.slice(0, 8) !== MOLI_RETURN_TAG) return null;
  const fixed = 8 + 64 + 64;
  if (hex.length <= fixed) throw new Error('malformed MOLI return: no proof');
  const nodes = RLP.decode(fromHex('0x' + hex.slice(fixed)));
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.some((n) => !(n instanceof Uint8Array))) {
    throw new Error('malformed MOLI return: the proof is not a list of nodes');
  }
  return {
    blockNumber: BigInt('0x' + hex.slice(8, 72)),
    txIndex: BigInt('0x' + hex.slice(72, 136)),
    proof: nodes,
  };
}

/* ------------------------------------------------------------------ proof */

const topicToAddress = (topic) => normalizeAddress('0x' + String(topic).slice(-40));

/**
 * Every bMOLI transfer INTO the return vault in one receipt, summed per
 * sender. One receipt may hold several (a batching wallet); each is honoured,
 * and the receipt as a whole is claimable once.
 */
export function findReturns(receipt) {
  if (receipt.status !== 1) {
    throw new Error('the transaction failed: a reverted transfer returned nothing');
  }
  const bySender = new Map();
  for (const log of receipt.logs) {
    if (log.address !== BMOLI_CONTRACT) continue;
    if ((log.topics[0] ?? '').toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    if (topicToAddress(log.topics[2]) !== MOLI_RETURN_ADDRESS) continue;
    const amount = BigInt(log.data === '0x' ? '0x0' : log.data);
    if (amount <= 0n) continue;
    const from = topicToAddress(log.topics[1]);
    bySender.set(from, (bySender.get(from) ?? 0n) + amount);
  }
  if (bySender.size === 0) {
    throw new Error(`no bMOLI transfer to the return vault ${MOLI_RETURN_ADDRESS} in this receipt`);
  }
  let total = 0n;
  for (const v of bySender.values()) total += v;
  return { bySender, total };
}

/** Prove the receipt is in the block, then read the returns out of it. */
export function proveReturn({ receiptsRoot, txIndex, proof }) {
  const value = verifyProof(receiptsRoot, RLP.encode(Number(txIndex)), proof.map(
    (n) => (n instanceof Uint8Array ? n : fromHex(n))));
  return findReturns(decodeReceipt(value));
}
