/**
 * Molibra - known foreign assets.
 *
 * A short, deliberately boring list: the assets whose (chain, contract) pair is
 * known, so nobody has to retype a contract address. A wrong address in a
 * bridge is not a bug you notice - it is funds sent somewhere nobody holds the
 * key. Typing it once, here, with its provenance next to it, is the whole point.
 *
 * ⛔ Being in this list is NOT an endorsement, a price, or a promise that
 * anything is liquid. It is an identity, nothing more. `mayEnterFromABridge`
 * still decides what may arrive, and it does not consult this file.
 */

import { foreignAssetRecord, foreignTokenId, NATIVE_CONTRACT } from './foreign.js';

export const ETHEREUM_MAINNET = 1n;

/**
 * Ether itself. Not an ERC-20 - it has no contract - so it takes the reserved
 * native slot rather than a pretend address.
 */
export const ETH = foreignAssetRecord({
  originChainId: ETHEREUM_MAINNET,
  contract: NATIVE_CONTRACT,
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
});

/**
 * WSRO - "Coinspirit". Verified on Ethereum mainnet 30 Aug 2026 by reading the
 * contract, not by being told:
 *
 *   name "Coinspirit" · symbol WSRO · 18 decimals · totalSupply 21,000,000
 *
 * ⚠ Two facts recorded here because a bridge author will otherwise assume
 * their opposites:
 *
 *   - **The supply is not a ceiling.** The contract has `mint` and `burn`, its
 *     `owner()` is a live EOA, and ownership is not renounced. Whatever a
 *     Molibra-side balance is worth depends on that owner's restraint, not on
 *     arithmetic. Any bridge minting WSRO here must track what was actually
 *     burned there, never a supply constant.
 *   - **There is no market.** Its only pool (SushiSwap V3, 0.01%) held 144,000
 *     WSRO against 0 WETH with zero liquidity when this was written. A bridged
 *     WSRO has no price to inherit, and nothing here should imply it does.
 */
export const WSRO = foreignAssetRecord({
  originChainId: ETHEREUM_MAINNET,
  contract: '0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8',
  symbol: 'WSRO',
  name: 'Coinspirit',
  decimals: 18,
});

/** Everything known, by derived Molibra id. */
export const KNOWN_FOREIGN = new Map([ETH, WSRO].map((a) => [a.id, a]));

/** Look one up by where it lives, which is the only name that cannot be faked. */
export function knownForeign(originChainId, contract) {
  return KNOWN_FOREIGN.get(foreignTokenId(originChainId, contract)) ?? null;
}
