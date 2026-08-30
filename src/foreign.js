/**
 * Molibra - foreign assets: what an outside token becomes when it arrives here.
 *
 * The bridge built on 30 Aug runs one way: an Ethereum contract verifies a
 * Molibra transaction. This file is the first piece of the other direction -
 * MOLI, ETH, WSRO and any other network token, in and out - and it is
 * deliberately the piece with **no custodian in it**. Nothing here locks,
 * mints, releases or holds anything. It answers two questions only:
 *
 *   1. What is the Molibra identity of a token that lives somewhere else?
 *   2. Is this thing allowed to cross at all?
 *
 * ⛔⛔ The second question is the one that matters, and it is the mirror of
 * `mayCrossABridge` in src/proof.js. That function guards the way OUT: GIZ, and
 * any `social`/`purchase`/`electoral` token, never leaves. Without the mirror
 * below, the rule would be trivially defeated from the other side - mint a
 * "question" on Ethereum, bridge it in, and the purpose taxonomy that the whole
 * TSE position rests on has been walked around rather than broken.
 *
 * So: **an arriving token can only ever become an `asset`.** A question is
 * never imported. Molibra's questions are created on Molibra, under Molibra's
 * rules, by somebody who signed for them here.
 */

import { keccak256, toHex, fromHex, concatBytes, normalizeAddress } from './crypto.js';

/** Tokens that live on another chain are addressed by (chain, contract). */
const FOREIGN_TAG = 'molibra:foreign:v1';

/**
 * The native coin of a chain has no contract address. Ethereum's ETH is the
 * case in point: it is not an ERC-20 and has no address, so bridging it needs a
 * reserved slot rather than a pretend contract. The zero address is the
 * convention everywhere else and is used here for the same reason - one fewer
 * thing for a bridge author to invent.
 */
export const NATIVE_CONTRACT = '0x0000000000000000000000000000000000000000';

/**
 * Deterministic Molibra id for a foreign token.
 *
 * Derived from the origin, exactly as `tokenId` derives a native token's id
 * from its creator - so it **cannot be squatted**. Whoever bridges USDC first
 * does not get to own the name; the same (chain, contract) always produces the
 * same id, for everyone, forever. Two people bridging the same asset converge
 * on one token instead of forking it into two incompatible ones.
 */
export function foreignTokenId(originChainId, contract) {
  const chain = BigInt(originChainId);
  if (chain <= 0n) throw new Error('origin chain id must be positive');
  return toHex(keccak256(concatBytes(
    new TextEncoder().encode(FOREIGN_TAG),
    new TextEncoder().encode(chain.toString()),
    fromHex(normalizeAddress(contract)),
  )));
}

/**
 * ⛔⛔ May this arrive on Molibra at all?
 *
 * The mirror of `mayCrossABridge`. Read them together; a change to one that is
 * not made to the other opens the door it closed.
 *
 * What is refused, and why it is refused rather than merely discouraged:
 *
 *   - **Anything that is not an asset.** A question does not get imported. If
 *     an arriving record carries options, a vote mode or an expression cost, it
 *     is claiming to be a ballot minted under somebody else's rules, and
 *     Molibra has no way to know what those were.
 *   - **Any `social`, `purchase` or `electoral` purpose.** Same rule as the way
 *     out, from the other side. A transferable claim on electoral subject
 *     matter is exactly what Res.-TSE 23.610/2019 art. 29 §8º attaches to, and
 *     minting one here on the strength of a foreign record would be defeating
 *     the rule by importing around it.
 *   - **A non-transferable arrival.** Chalk that cannot move here must not move
 *     there either; a bridged claim on it would manufacture the market its
 *     design denies. This is the GIZ rule, stated inbound.
 */
export function mayEnterFromABridge(record) {
  if (!record) return { ok: false, reason: 'unknown token' };

  if (record.kind && record.kind !== 'asset') {
    return {
      ok: false,
      reason: `only an asset may arrive over a bridge; ${record.kind} is created here, `
        + 'under this chain\'s rules, by somebody who signed for it here',
    };
  }
  if (Array.isArray(record.options) && record.options.length) {
    return { ok: false, reason: 'an arriving token carrying options is a question, not an asset' };
  }
  if (record.voteMode) {
    return { ok: false, reason: 'an arriving token carrying a vote mode is a question, not an asset' };
  }
  if (record.expressionCost && BigInt(record.expressionCost) > 0n) {
    return {
      ok: false,
      reason: 'an arriving token carrying an expression cost is a question, not an asset',
    };
  }
  if (['social', 'purchase', 'electoral'].includes(record.purpose)) {
    return {
      ok: false,
      reason: `${record.purpose} subject matter never crosses, in any wrapping - `
        + 'inbound is the same rule as outbound, from the other side',
    };
  }
  if (record.transferable === false) {
    return {
      ok: false,
      reason: 'a non-transferable token has no market and no price; a bridged claim '
        + 'on it would manufacture both',
    };
  }
  return { ok: true, reason: null };
}

/**
 * Build the Molibra record for a token that lives on another chain.
 *
 * The result is an ordinary `asset` record plus an `origin`, and it is an
 * asset **always**: see `mayEnterFromABridge`. The origin is not decoration -
 * it is what stops a bridged token from being mistaken for a native one, in a
 * wallet, in an explorer, or by a person deciding whether to trust it.
 *
 * ⚠ This function does not decide that the token really exists on that chain,
 * that anybody locked anything, or that the symbol is honest. Nothing here has
 * seen the other chain. Those are the bridge's job, and the bridge does not
 * exist yet.
 */
export function foreignAssetRecord({
  originChainId, contract, symbol, name, decimals = 18,
}) {
  const chain = BigInt(originChainId);
  const address = normalizeAddress(contract);
  const record = {
    kind: 'asset',
    symbol: String(symbol ?? '').trim().toUpperCase(),
    title: String(name ?? '').trim() || `${symbol} (bridged)`,
    decimals: Number(decimals),
    initialSupply: '0',   // nothing exists until something is proved locked
    maxSupply: '0',       // the ceiling is whatever is locked, not a number here
    issuable: true,
    transferable: true,
    purpose: 'market',
    origin: {
      chainId: chain.toString(),
      contract: address,
      native: address === NATIVE_CONTRACT,
    },
  };

  const verdict = mayEnterFromABridge(record);
  if (!verdict.ok) throw new Error(`refused at the door: ${verdict.reason}`);

  return { id: foreignTokenId(chain, address), ...record };
}
