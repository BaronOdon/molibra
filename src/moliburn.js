/**
 * Molibra - destroying MOLI so it may exist somewhere else.
 *
 * ## ⛔⛔ Why this exists beside src/bridge.js
 *
 * `bridgeOut` MOVES NOTHING. Its own file says so: it is a statement the
 * sender signed, and `MolibraSettlement` on Ethereum pays ETH against it out
 * of a pot the operator funded and can withdraw. That is sound, because the
 * loss is capped at the pot: the operator is underwriting redemptions, and a
 * signer who bridges out the same MOLI twice drains a bounded pool.
 *
 * A MINT has no such cap. If a contract on Ethereum minted an ERC-20 against
 * a `bridgeOut`, the signer would still hold their MOLI here afterwards, and
 * could sign another at the next nonce - a different transaction, a different
 * hash, a different Merkle leaf, and another independently claimable mint. One
 * MOLI would mint forever. So a token that represents MOLI on another chain
 * cannot be backed by a statement. Something has to be DESTROYED.
 *
 * That is all this payload is:
 *
 *   MOLI_BURN ‖ recipient(20) ‖ amount(32)
 *
 * Consensus takes `amount` out of the sender's balance and credits nobody. The
 * MOLI is gone - not held by a vault, not held by the operator, not held by a
 * multisig, gone - and the transaction that destroyed it is in a block whose
 * hash is anchored on Ethereum. `BridgedMoli` mints against THAT.
 *
 * ⛔ The selector is deliberately NOT `bridgeOut`'s. Every bridge-out ever
 * signed is already on this chain, unbacked by anything, and several are
 * already anchored. If the two shared a tag, the contract could be handed a
 * historical statement and would mint against MOLI that still exists. A new
 * tag means no transaction written before this rule can ever reach the mint.
 *
 * ## What this does NOT do
 *
 * It does not bring MOLI back. Burning here mints there; returning requires
 * the reverse - a proved burn of the ERC-20 on Ethereum, honoured here by
 * releasing MOLI - and that is a separate instruction that does not exist yet.
 * ⛔ Until it does, crossing is ONE-WAY and must be labelled that way
 * everywhere a person can reach it. The same honesty the WSRO leg needed.
 */

import { keccak256, toHex, fromHex, concatBytes, normalizeAddress } from './crypto.js';

const utf8 = (s) => new TextEncoder().encode(s);

/**
 * Derived the same way every other Molibra payload tag is, and computed rather
 * than written down: a hand-copied selector is a typo away from a payload that
 * consensus ignores and the EVM happily executes.
 */
export const MOLI_BURN_TAG = toHex(keccak256(utf8('moliBurn(address,uint256)'))).slice(0, 10);

/**
 * ⛔⛔ The height from which consensus honours a burn. SET THIS BEFORE SHIPPING.
 *
 * This instruction changes what a block means. A node running the old code,
 * handed a `moliBurn` payload, sees a self-addressed transaction with data it
 * does not recognise, moves nothing, and computes one state root; an upgraded
 * node destroys the MOLI and computes a different one. Same block, two roots -
 * which is a chain split, not a disagreement.
 *
 * So below this height the payload is deliberately treated EXACTLY as an old
 * node treats it: ordinary data, nothing burned. That makes upgraded and
 * un-upgraded nodes agree on all existing history and on every block until the
 * flag day, and it means shipping the code is safe on its own - only passing
 * this height changes anything.
 *
 * ⛔ It must be far enough ahead that every node has upgraded first: the
 * public node at 193.123.191.142, the operator's miner, and anyone who joined
 * from the public repo. Molibra makes ~5,760 blocks a day.
 *
 * ⛔⛔ **This number is free to change now and FROZEN once the first burn is
 * mined.** Replay re-applies every historical transaction with the height of
 * its own block (src/chain.js) and this constant compiled in. So if a burn
 * landed at 61,000 under an activation of 60,000 and this were later raised,
 * replay would read that transaction as ordinary data, compute a different
 * state root, and the node would reject its own chain. The window in which
 * this is a one-line change is exactly "before anybody burns".
 *
 * ⚠ Mismatched values across nodes are not automatically a split: the
 * divergence is triggered by a TRANSACTION, not by a height. A node still on
 * an older value agrees on every block until a `moliBurn` actually appears
 * above the lower of the two. That is what the margin below buys - not
 * certainty that everyone upgraded, but a long stretch in which being late
 * costs nothing.
 *
 * Set to 60,000 on 1 Sep 2026, when the tip was 12,432: about eight days.
 */
export const MOLI_BURN_ACTIVATION = 60_000n;

/** Build the `data` for a burn-to-bridge instruction. */
export function encodeMoliBurn(recipient, amount) {
  const value = BigInt(amount);
  if (value <= 0n) throw new Error('a MOLI burn must be positive');
  const hex = value.toString(16).padStart(64, '0');
  if (hex.length !== 64) throw new Error('amount does not fit in 32 bytes');
  return toHex(concatBytes(
    fromHex(MOLI_BURN_TAG),
    fromHex(normalizeAddress(recipient)),
    fromHex('0x' + hex),
  ));
}

/** null when the data is not a MOLI burn; throws when tagged but malformed. */
export function decodeMoliBurn(data) {
  if (!data) return null;
  const hex = String(data instanceof Uint8Array ? toHex(data) : data).toLowerCase();
  if (!hex.startsWith(MOLI_BURN_TAG)) return null;
  if (hex.length !== 2 + 8 + 40 + 64) {
    throw new Error('malformed MOLI burn: expected tag + recipient + amount');
  }
  const recipient = '0x' + hex.slice(10, 50);
  const amount = BigInt('0x' + hex.slice(50, 114));
  if (amount <= 0n) throw new Error('a MOLI burn must be positive');
  // ⛔ The zero address is refused rather than treated as "burn to nobody".
  // On the far side it is the mint recipient, and OpenZeppelin-shaped ERC-20s
  // revert on a mint to zero - so this would destroy MOLI here and be
  // unclaimable there. Refusing it costs nothing; allowing it is a one-way
  // loss with a proof that can never be spent.
  if (/^0x0{40}$/.test(recipient)) {
    throw new Error('a MOLI burn to the zero address would be unclaimable on the far side');
  }
  return { recipient, amount };
}

/**
 * The running total of MOLI destroyed this way.
 *
 * It is STATE, not a statistic. Every node must agree on it, because it is the
 * number a reader checks the far side's `totalSupply` against: what was
 * destroyed here should equal what exists there, and a node that counted
 * differently would report a bridge as solvent or insolvent on its own
 * authority. Kept on the same appended-only-when-present terms as the inbound
 * ledger, so a chain on which nothing has ever been burned hashes to exactly
 * the root it already has.
 */
export class OutboundLedger {
  constructor(burned = 0n, byRecipient = new Map()) {
    this.burned = BigInt(burned);
    this.byRecipient = byRecipient;
  }

  burn(recipient, amount) {
    const value = BigInt(amount);
    if (value <= 0n) throw new Error('a MOLI burn must be positive');
    this.burned += value;
    const to = normalizeAddress(recipient);
    this.byRecipient.set(to, (this.byRecipient.get(to) ?? 0n) + value);
  }

  clone() {
    return new OutboundLedger(this.burned, new Map(this.byRecipient));
  }

  /** Nothing at all when nothing has been burned: no hard fork. */
  rootLines() {
    if (this.burned === 0n) return [];
    const lines = [`moliburn:total:${this.burned.toString(16)}`];
    for (const to of [...this.byRecipient.keys()].sort()) {
      lines.push(`moliburn:${to}:${this.byRecipient.get(to).toString(16)}`);
    }
    return lines;
  }

  toJSON() {
    if (this.burned === 0n) return null;
    const byRecipient = {};
    for (const to of [...this.byRecipient.keys()].sort()) {
      byRecipient[to] = this.byRecipient.get(to).toString();
    }
    return { burned: this.burned.toString(), byRecipient };
  }

  static fromJSON(raw) {
    if (!raw) return new OutboundLedger();
    const byRecipient = new Map();
    for (const [to, amount] of Object.entries(raw.byRecipient ?? {})) {
      byRecipient.set(normalizeAddress(to), BigInt(amount));
    }
    return new OutboundLedger(BigInt(raw.burned ?? 0), byRecipient);
  }
}
