/**
 * Molibra - the wire between a proved burn and a minted unit.
 *
 * Three files existed before this one and none of them touched each other:
 *
 *   burnproof.js   decides whether the burn HAPPENED     (cryptography)
 *   inbound.js     decides whether paying it is ALLOWED  (accounting)
 *   BridgedAsset   holds the units people actually trade (a contract)
 *
 * Each was tested. Nothing called them in sequence, so the invariant they
 * exist to enforce -
 *
 *     minted here == sum(proved burns there) - sum(returns)
 *
 * - was a sentence in a comment rather than a property of the system. This
 * file is the sequence, and it is consensus code: every node re-runs it, so
 * every node reaches the same verdict about what may exist here.
 *
 * ## The rule this file exists to make true
 *
 * `BridgedAsset.mint` is callable only by the address fixed at construction.
 * That is necessary and it is not sufficient: if that address is an ordinary
 * wallet, then whoever holds its key mints whatever they like, and the
 * invariant above describes their intentions rather than the system's rules.
 * A bridge whose supply depends on an operator's restraint is a custodian
 * with extra steps.
 *
 * So the address the contract trusts is derived, by `bridgeAuthority` below,
 * from the asset's own id:
 *
 *     authority = last20( keccak256("molibra:bridge-authority:v1" || tokenId) )
 *
 * Nobody has the private key for that address, and nobody can get one. It is
 * the image of a hash, not the image of a public key. No signature recovers to
 * it, so no transaction can ever be sent FROM it - which means the only way
 * bytes are executed with that address as `msg.sender` is the path in
 * `applyTransaction` that runs `proveBurn` first. The address gate and the
 * proof gate are then the same gate.
 *
 * `assertNotAuthority` states that as a rule rather than leaving it to the
 * arithmetic, because a rule nobody wrote down is a rule nobody can check.
 *
 * ## What is still trusted, said plainly
 *
 * A receipt proof is checked against a `receiptsRoot`, and that root arrives by
 * HEADER_COMMIT from the address that registered the asset. So:
 *
 *     trustless  - that the burn is in a block with the committed root, that
 *                  it burned THIS contract's units, and that it is paid once
 *     trusted    - that a block with that root is canonical Ethereum
 *
 * The trusted half is not a promise, it is a falsifiable public claim. Every
 * committed root is in the chain, named and attributed; anyone with an
 * Ethereum node can compare it against the real block and show it is false. A
 * registrant who commits a fabricated root does not get away with it quietly -
 * they publish the evidence against themselves, permanently, and
 * `InboundLedger.conservation` is the arithmetic that catches the result.
 *
 * Registration is permissionless and the id is DERIVED from (chain, contract),
 * so an asset cannot be squatted into two incompatible versions - but whoever
 * registers first is that asset's declared header authority forever. That is a
 * real limitation and it is why the authority is shown in every report: a
 * reader who does not trust the registrant of an asset should not treat its
 * units as backed. The remedy is to read the record, not to believe this file.
 */

import { RLP } from '@ethereumjs/rlp';
import {
  keccak256, toHex, fromHex, concatBytes, normalizeAddress,
} from './crypto.js';

const utf8 = (s) => new TextEncoder().encode(s);

/** Four-byte payload tags, derived the same way every other Molibra payload is. */
export const BRIDGE_REGISTER_TAG =
  toHex(keccak256(utf8('bridgeRegister(uint256,address,address,uint256,string)'))).slice(0, 10);
export const HEADER_COMMIT_TAG =
  toHex(keccak256(utf8('commitHeader(uint256,uint256,bytes32)'))).slice(0, 10);
export const BRIDGE_CLAIM_TAG =
  toHex(keccak256(utf8('bridgeClaim(bytes32,uint256,uint256,address,bytes32,bytes)'))).slice(0, 10);
export const BRIDGE_RELEASE_TAG =
  toHex(keccak256(utf8('bridgeRelease(bytes32,uint256)'))).slice(0, 10);

/** `mint(address,uint256)`, `burn(uint256)` and the getters on BridgedAsset. */
export const MINT_SELECTOR = toHex(keccak256(utf8('mint(address,uint256)'))).slice(0, 10);
export const BURN_SELECTOR = toHex(keccak256(utf8('burn(uint256)'))).slice(0, 10);
export const BRIDGE_GETTER = toHex(keccak256(utf8('bridge()'))).slice(0, 10);
export const TOTAL_SUPPLY_GETTER = toHex(keccak256(utf8('totalSupply()'))).slice(0, 10);

const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const bare = (hex) => String(hex).toLowerCase().replace(/^0x/, '');
const asHex = (data) => bare(data instanceof Uint8Array ? toHex(data) : data);

/**
 * The address a bridged asset's contract must trust, derived from the asset id.
 *
 * There is no key for this address and there cannot be one. That is the entire
 * security argument: see the header of this file before changing the
 * derivation, because changing it orphans every contract already deployed
 * against the old one - their `bridge` is immutable.
 */
export function bridgeAuthority(tokenId) {
  const id = bare(tokenId);
  if (id.length !== 64) throw new Error('a token id is 32 bytes');
  const digest = keccak256(concatBytes(utf8('molibra:bridge-authority:v1'), fromHex('0x' + id)));
  return normalizeAddress('0x' + toHex(digest).slice(-40));
}

/* ------------------------------------------------------------- register */

/** BRIDGE_REGISTER + chainId(32) + contract(20) + asset(20) + cap(32) + symbol */
export function encodeBridgeRegister({ originChainId, contract, assetContract, cap, symbol }) {
  const ceiling = BigInt(cap);
  if (ceiling <= 0n) throw new Error('a bridge cap must be positive');
  const name = String(symbol ?? '').trim().toUpperCase();
  if (!name || name.length > 32) throw new Error('a symbol is 1 to 32 characters');
  return toHex(concatBytes(
    fromHex(BRIDGE_REGISTER_TAG),
    fromHex('0x' + word(originChainId)),
    fromHex(normalizeAddress(contract)),
    fromHex(normalizeAddress(assetContract)),
    fromHex('0x' + word(ceiling)),
    utf8(name),
  ));
}

export function decodeBridgeRegister(data) {
  if (!data) return null;
  const hex = asHex(data);
  if ('0x' + hex.slice(0, 8) !== BRIDGE_REGISTER_TAG) return null;
  const fixed = 8 + 64 + 40 + 40 + 64;
  if (hex.length <= fixed) throw new Error('malformed bridge registration: no symbol');
  return {
    originChainId: BigInt('0x' + hex.slice(8, 72)),
    contract: normalizeAddress('0x' + hex.slice(72, 112)),
    assetContract: normalizeAddress('0x' + hex.slice(112, 152)),
    cap: BigInt('0x' + hex.slice(152, 216)),
    symbol: new TextDecoder().decode(fromHex('0x' + hex.slice(fixed))),
  };
}

/* --------------------------------------------------------------- header */

/** HEADER_COMMIT + chainId(32) + blockNumber(32) + receiptsRoot(32) */
export function encodeHeaderCommit({ originChainId, blockNumber, receiptsRoot }) {
  if (bare(receiptsRoot).length !== 64) throw new Error('a receipts root is 32 bytes');
  return toHex(concatBytes(
    fromHex(HEADER_COMMIT_TAG),
    fromHex('0x' + word(originChainId)),
    fromHex('0x' + word(blockNumber)),
    fromHex('0x' + bare(receiptsRoot)),
  ));
}

export function decodeHeaderCommit(data) {
  if (!data) return null;
  const hex = asHex(data);
  if ('0x' + hex.slice(0, 8) !== HEADER_COMMIT_TAG) return null;
  if (hex.length !== 8 + 64 * 3) throw new Error('malformed header commit');
  return {
    originChainId: BigInt('0x' + hex.slice(8, 72)),
    blockNumber: BigInt('0x' + hex.slice(72, 136)),
    receiptsRoot: '0x' + hex.slice(136, 200),
  };
}

/* ---------------------------------------------------------------- claim */

/**
 * BRIDGE_CLAIM + tokenId(32) + blockNumber(32) + txIndex(32) + recipient(20)
 *              + ethTxHash(32) + rlp([...proof nodes])
 *
 * The proof travels IN the transaction, in full, because every node verifies
 * it independently. A claim that asked nodes to fetch the proof from somewhere
 * would be asking them to agree about the internet.
 */
export function encodeBridgeClaim({ tokenId, blockNumber, txIndex, recipient, ethTxHash, proof }) {
  if (!Array.isArray(proof) || proof.length === 0) {
    throw new Error('a claim carries its proof; an empty proof proves nothing');
  }
  const nodes = proof.map((n) => (n instanceof Uint8Array ? n : fromHex(n)));
  return toHex(concatBytes(
    fromHex(BRIDGE_CLAIM_TAG),
    fromHex('0x' + bare(tokenId).padStart(64, '0')),
    fromHex('0x' + word(blockNumber)),
    fromHex('0x' + word(txIndex)),
    fromHex(normalizeAddress(recipient)),
    fromHex('0x' + bare(ethTxHash).padStart(64, '0')),
    RLP.encode(nodes),
  ));
}

export function decodeBridgeClaim(data) {
  if (!data) return null;
  const hex = asHex(data);
  if ('0x' + hex.slice(0, 8) !== BRIDGE_CLAIM_TAG) return null;
  const fixed = 8 + 64 + 64 + 64 + 40 + 64;
  if (hex.length <= fixed) throw new Error('malformed bridge claim: no proof');
  const nodes = RLP.decode(fromHex('0x' + hex.slice(fixed)));
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('malformed bridge claim: the proof is not a list of nodes');
  }
  return {
    tokenId: '0x' + hex.slice(8, 72),
    blockNumber: BigInt('0x' + hex.slice(72, 136)),
    txIndex: Number(BigInt('0x' + hex.slice(136, 200))),
    recipient: normalizeAddress('0x' + hex.slice(200, 240)),
    ethTxHash: '0x' + hex.slice(240, 304),
    proof: nodes,
  };
}

/* -------------------------------------------------------------- release */

/** BRIDGE_RELEASE + tokenId(32) + amount(32) - the return leg. */
export function encodeBridgeRelease({ tokenId, amount }) {
  const value = BigInt(amount);
  if (value <= 0n) throw new Error('a release must be positive');
  return toHex(concatBytes(
    fromHex(BRIDGE_RELEASE_TAG),
    fromHex('0x' + bare(tokenId).padStart(64, '0')),
    fromHex('0x' + word(value)),
  ));
}

export function decodeBridgeRelease(data) {
  if (!data) return null;
  const hex = asHex(data);
  if ('0x' + hex.slice(0, 8) !== BRIDGE_RELEASE_TAG) return null;
  if (hex.length !== 8 + 128) throw new Error('malformed bridge release');
  return {
    tokenId: '0x' + hex.slice(8, 72),
    amount: BigInt('0x' + hex.slice(72, 136)),
  };
}

/* ------------------------------------------------------------- calldata */

export const mintCall = (to, amount) =>
  MINT_SELECTOR + normalizeAddress(to).slice(2).padStart(64, '0') + word(amount);

export const burnCall = (amount) => BURN_SELECTOR + word(amount);

/** True when calldata is a direct `burn(uint256)`. */
export function isBurnCall(data) {
  if (!data) return false;
  return '0x' + asHex(data).slice(0, 8) === BURN_SELECTOR;
}
