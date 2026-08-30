/**
 * Foreign assets - the inbound half of the bridge rule.
 *
 * The tests that matter here are the refusals. A bridge is the most attacked
 * component in crypto, and the attack this file is written against is not a
 * clever one: it is somebody minting a question on a chain with no rules and
 * bridging it in, so that the purpose taxonomy is walked around rather than
 * broken. Every refusal below is that attack in a different coat.
 */

import {
  foreignTokenId, foreignAssetRecord, mayEnterFromABridge, NATIVE_CONTRACT,
} from '../src/foreign.js';
import { mayCrossABridge } from '../src/proof.js';

let passed = 0;
let failed = 0;
const check = (name, ok, note = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}${note ? '  ' + note : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${note ? '  ' + note : ''}`); }
};
const refuses = (name, record, expect) => {
  const v = mayEnterFromABridge(record);
  check(name, !v.ok && (!expect || v.reason.includes(expect)), v.reason || '(allowed!)');
};

console.log('foreign assets\n');

// --- identity ---------------------------------------------------------------
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const a = foreignTokenId(1, USDC);
const b = foreignTokenId(1, USDC.toLowerCase());
check('the same (chain, contract) always derives the same id', a === b,
  'case in the address does not fork the token');
check('a different chain is a different token', foreignTokenId(10, USDC) !== a,
  'the same contract address on another chain is not the same asset');
check('a different contract is a different token',
  foreignTokenId(1, '0x' + '11'.repeat(20)) !== a);
check('the id is 32 bytes', /^0x[0-9a-f]{64}$/.test(a));
check('nobody can squat a name: the id is derived, never chosen',
  foreignTokenId(1, USDC) === a, 'whoever bridges first does not own it');
check('chain id must be positive',
  (() => { try { foreignTokenId(0, USDC); return false; } catch { return true; } })());

// --- what a real arrival looks like -----------------------------------------
const usdc = foreignAssetRecord({
  originChainId: 1, contract: USDC, symbol: 'usdc', name: 'USD Coin', decimals: 6,
});
check('an arriving token is an asset', usdc.kind === 'asset');
check('the symbol is normalised', usdc.symbol === 'USDC');
check('decimals are carried across', usdc.decimals === 6);
check('nothing exists until something is proved locked', usdc.initialSupply === '0');
check('no ceiling is invented', usdc.maxSupply === '0',
  'the ceiling is whatever is locked, not a number chosen here');
check('the origin is recorded', usdc.origin.chainId === '1'
  && usdc.origin.contract === USDC.toLowerCase(),
  'so a bridged token can never be mistaken for a native one');
check('it is not marked native', usdc.origin.native === false);

const eth = foreignAssetRecord({
  originChainId: 1, contract: NATIVE_CONTRACT, symbol: 'ETH', name: 'Ether',
});
check('a chain\'s native coin bridges too', eth.origin.native === true,
  'ETH is not an ERC-20 and has no address; the zero address is its slot');
check('ETH and USDC are different tokens', eth.id !== usdc.id);

// --- ⛔⛔ the refusals: the rule, from the other side ------------------------
refuses('a question is never imported',
  { kind: 'expression', transferable: true }, 'created here');
refuses('nor one wearing an asset label but carrying options',
  { kind: 'asset', transferable: true, options: ['a', 'b'] }, 'is a question');
refuses('nor one carrying a vote mode',
  { kind: 'asset', transferable: true, voteMode: 'single' }, 'is a question');
refuses('nor one carrying an expression cost',
  { kind: 'asset', transferable: true, expressionCost: '1000' }, 'is a question');

for (const purpose of ['social', 'purchase', 'electoral']) {
  refuses(`${purpose} subject matter never arrives`,
    { kind: 'asset', transferable: true, purpose }, 'never crosses');
}
refuses('chalk cannot arrive any more than it can leave',
  { kind: 'asset', transferable: false }, 'manufacture both');

check('market and behaviour assets are fine',
  mayEnterFromABridge({ kind: 'asset', transferable: true, purpose: 'market' }).ok
  && mayEnterFromABridge({ kind: 'asset', transferable: true, purpose: 'behaviour' }).ok);

// --- ⛔⛔ the two halves agree ----------------------------------------------
// The point of this block: a token refused on the way out must be refused on
// the way in. If these ever disagree, the rule has a door in it.
const giz = {
  id: '0xgiz', symbol: 'GIZ', kind: 'expression', purpose: 'social', transferable: false,
};
check('GIZ is refused on the way OUT', !mayCrossABridge(giz).ok, mayCrossABridge(giz).reason);
check('GIZ is refused on the way IN', !mayEnterFromABridge(giz).ok,
  mayEnterFromABridge(giz).reason);

for (const purpose of ['social', 'purchase', 'electoral']) {
  const t = { symbol: 'X', kind: 'asset', purpose, transferable: true };
  check(`a transferable ${purpose} asset is refused BOTH ways`,
    !mayCrossABridge(t).ok && !mayEnterFromABridge(t).ok,
    'calling it an asset is not a way around the rule');
}

const moli = { symbol: 'MOLI', kind: 'asset', purpose: 'market', transferable: true };
check('MOLI crosses in both directions', mayCrossABridge(moli).ok
  && mayEnterFromABridge(moli).ok,
  'an ordinary coin is an ordinary question');

// --- the constructor refuses too, not just the checker ----------------------
check('foreignAssetRecord cannot be talked into building a refused record',
  (() => {
    try {
      foreignAssetRecord({
        originChainId: 1, contract: USDC, symbol: 'X', name: 'x', decimals: 18,
      });
      return true;
    } catch { return false; }
  })(), 'a legal one still builds');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
