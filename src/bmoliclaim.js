/**
 * Molibra - building and reading a BridgedMoli claim on Ethereum.
 *
 * Shared by claim-preflight.mjs (a person pre-flighting one claim) and
 * bots/bridge-bot.mjs (the relayer claiming every burn), so the calldata the
 * operator checks by hand and the calldata the bot sends are one encoder, not
 * two that can drift. CLIENT-SIDE ONLY: nothing here is consensus.
 *
 * ⛔ Nothing here signs. It encodes, and it names reverts.
 */
import { keccak256, toHex } from './crypto.js';

/** bMOLI on Ethereum (the CURRENT BridgedMoli; the stray 0x035b2377… is not it). */
export const BMOLI = '0xa302877efb74f567f3605851194b46f1d5746822';

export const sel = (s) => toHex(keccak256(new TextEncoder().encode(s))).slice(0, 10);
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const pad = (h) => String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0');

export const SELECTORS = {
  claim: sel('claim(uint256,bytes,bytes,bytes32[],bool[])'),
  claimed: sel('claimed(bytes32)'),
  status: sel('status(uint256)'),
  totalSupply: sel('totalSupply()'),
  balanceOf: sel('balanceOf(address)'),
};

/** Every custom error BridgedMoli declares, by selector, derived not pasted. */
export const CLAIM_ERRORS = Object.fromEntries([
  'AlreadyClaimed()', 'NotAnchored(uint256)', 'PublisherSlashed()',
  'ChallengeWindowOpen(uint256,uint256)', 'HeaderDoesNotMatchAnchor(bytes32,bytes32)',
  'NotInBlock()', 'NotAMoliBurn()', 'ABridgeOutBurnsNothing()', 'ZeroAmount()',
  'BadProof()', 'BrokenAncestry(uint256)',
].map((s) => [sel(s), s]));

/** The error's name from revert data (or any text containing it), else null. */
export function revertName(dataOrText) {
  const m = /0x[0-9a-fA-F]{8,}/.exec(String(dataOrText ?? ''));
  return m ? (CLAIM_ERRORS[m[0].slice(0, 10).toLowerCase()] ?? null) : null;
}

/** ABI-encode claim(uint256,bytes,bytes,bytes32[],bool[]). */
export function encodeClaim(height, headerRlp, rawTx, siblings, onRight) {
  const bytesArg = (hex) => {
    const body = String(hex).replace(/^0x/, '');
    const padded = body.padEnd(Math.ceil(body.length / 64) * 64, '0');
    return word(body.length / 2) + padded;
  };
  const arrArg = (items) => word(items.length) + items.join('');
  const tails = [
    bytesArg(headerRlp),
    bytesArg(rawTx),
    arrArg(siblings.map((s) => pad(s))),
    arrArg(onRight.map((b) => word(b ? 1 : 0))),
  ];
  let offset = 5 * 32;                       // height + four dynamic heads
  const heads = tails.map((t) => { const h = word(offset); offset += t.length / 2; return h; });
  return SELECTORS.claim + word(height) + heads.join('') + tails.join('');
}

/**
 * The claim calldata from a node's /molibra/proof/<tx> answer. Accepts both
 * sibling spellings the route has used ({hash, side} and {sibling, right}).
 */
export function claimFromProof(p) {
  const path = p.proof ?? p.siblings ?? [];
  const siblings = path.map((s) => s.hash ?? s.sibling ?? s);
  const onRight = path.map((s) => (s.side ? s.side === 'right' : (s.onRight ?? s.right ?? s.siblingOnRight)));
  return encodeClaim(p.blockNumber, p.headerRlp, p.raw, siblings, onRight);
}

export const claimedCall = (molibraTxHash) => SELECTORS.claimed + pad(molibraTxHash);
export const statusCall = (height) => SELECTORS.status + word(height);

/** status(uint256) -> { anchored, usable, anchoredAt, supply } */
export function decodeStatus(hex) {
  const h = String(hex).replace(/^0x/, '');
  const w = (i) => BigInt('0x' + (h.slice(i * 64, i * 64 + 64) || '0'));
  return { anchored: w(0) !== 0n, usable: w(1) !== 0n, anchoredAt: w(2), supply: w(3) };
}
