/**
 * The inbound ledger - bounded minting, single-use burns, conservation.
 *
 * The tests that matter are the refusals, and the sharpest one is replay: a
 * proof that can be presented twice is the shape of every bridge theft of this
 * kind. If only one test in this file survives a future refactor, it should be
 * "the same burn cannot be claimed twice".
 */

import { InboundLedger, claimKey } from '../src/inbound.js';
import { WSRO, ETH } from '../src/registry.js';

let passed = 0; let failed = 0;
const check = (name, ok, note = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}${note ? '  ' + note : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${note ? '  ' + note : ''}`); }
};
const throws = (fn, needle) => {
  try { fn(); return false; } catch (e) { return !needle || e.message.includes(needle); }
};
const TX = (n) => '0x' + n.toString(16).padStart(64, '0');
const ALICE = '0x1111111111111111111111111111111111111111';
const UNIT = 10n ** 18n;

console.log('inbound ledger\n');

// The 144,000 already committed to the market is the starting cap: a new bridge
// should be able to lose only what somebody chose to risk.
const CAP = 144000n * UNIT;

// --- registration -----------------------------------------------------------
{
  const l = new InboundLedger();
  const a = l.register(WSRO, CAP);
  check('WSRO registers as a bridged asset', a.symbol === 'WSRO' && a.cap === CAP);
  check('it starts with nothing minted', a.minted === 0n);
  check('registering twice is refused', throws(() => l.register(WSRO, CAP), 'already registered'));
  check('a zero cap is refused', throws(() => new InboundLedger().register(ETH, 0),
    'must be positive'), 'a bridge that carries nothing is a configuration error');

  // ⛔⛔ the keystone, on this surface too
  const giz = {
    id: '0xgiz', symbol: 'GIZ', kind: 'expression', purpose: 'social',
    transferable: false, origin: { chainId: '1', contract: '0x' + '00'.repeat(20) },
  };
  check('⛔⛔ GIZ can never be registered as a bridged asset',
    throws(() => l.register(giz, CAP), 'refused at the door'),
    'the electoral keystone applies here as it does everywhere else');
  for (const purpose of ['social', 'purchase', 'electoral']) {
    check(`⛔ nor a transferable ${purpose} asset`,
      throws(() => l.register({
        id: '0x' + purpose, symbol: 'X', kind: 'asset', purpose, transferable: true,
        origin: { chainId: '1', contract: '0x' + '11'.repeat(20) },
      }, CAP), 'refused at the door'));
  }
}

// --- ⛔ replay: the one that matters ----------------------------------------
{
  const l = new InboundLedger();
  l.register(WSRO, CAP);
  const claim = { tokenId: WSRO.id, ethTxHash: TX(1), amount: 100n * UNIT, recipient: ALICE };
  l.claim(claim);
  check('a proved burn mints once', l.get(WSRO.id).minted === 100n * UNIT);
  check('⛔ the SAME burn cannot be claimed twice',
    throws(() => l.claim(claim), 'already been claimed'),
    'a proof presentable twice is the shape of every bridge theft of this kind');
  check('⛔ nor by a different recipient',
    throws(() => l.claim({ ...claim, recipient: '0x' + '22'.repeat(20) }), 'already been claimed'),
    'the key is the origin transaction, not who is asking');
  check('⛔ nor for a different amount',
    throws(() => l.claim({ ...claim, amount: 1n }), 'already been claimed'));
  check('a DIFFERENT burn still mints',
    l.claim({ ...claim, ethTxHash: TX(2) }) && l.get(WSRO.id).minted === 200n * UNIT);
  check('the claim key depends on the chain, not just the hash',
    claimKey(1, TX(1)) !== claimKey(10, TX(1)),
    'the same tx hash on another chain is a different burn');
}

// --- the cap ----------------------------------------------------------------
{
  const l = new InboundLedger();
  l.register(WSRO, CAP);
  l.claim({ tokenId: WSRO.id, ethTxHash: TX(10), amount: CAP, recipient: ALICE });
  check('minting exactly to the cap is allowed', l.get(WSRO.id).minted === CAP);
  check('⛔ one unit over the cap is refused',
    throws(() => l.claim({ tokenId: WSRO.id, ethTxHash: TX(11), amount: 1n, recipient: ALICE }),
      "over this bridge's cap"),
    'if every assumption here is wrong, the loss is bounded by a number set in advance');
  check('the report shows zero headroom', l.report(WSRO.id).headroom === '0');

  check('the cap cannot be lowered below what is minted',
    throws(() => l.lowerCap(WSRO.id, CAP - 1n), 'below the'),
    'a rule an administrator can violate is not a rule');
}

// --- ⭐ gradual growth: safer is instant, bigger always waits ---------------
{
  const NOW = 1_700_000_000n;
  const WEEK = 604800n;
  const l = new InboundLedger();
  l.register(WSRO, CAP);

  check('⛔ a raise cannot be applied in one call',
    throws(() => l.lowerCap(WSRO.id, CAP * 2n), 'only lowers'),
    'a cap a compromised key removes in one transaction was never a bound');

  check('⛔ nor can it jump past the growth factor',
    throws(() => l.proposeCap(WSRO.id, CAP * 3n, NOW), 'more than 2x'),
    'the bridge grows in stages that each get tested by use');

  const p = l.proposeCap(WSRO.id, CAP * 2n, NOW);
  check('a bounded raise can be ANNOUNCED', p.to === (CAP * 2n).toString());
  check('but the cap has not moved yet', l.get(WSRO.id).cap === CAP,
    'announced is not live');
  check('the pending raise is visible to anyone reading the report',
    l.report(WSRO.id).pendingCap.cap === (CAP * 2n).toString(),
    'that is what turns a private intention into a public commitment');

  check('⛔ applying it early is refused',
    throws(() => l.applyCap(WSRO.id, NOW + WEEK - 1n), 'becomes effective at'));
  check('applying it after the delay works',
    l.applyCap(WSRO.id, NOW + WEEK).to === (CAP * 2n).toString());
  check('and there is nothing left pending',
    l.report(WSRO.id).pendingCap === null);

  // Making the bridge SAFER never waits.
  check('⭐ lowering the cap is immediate',
    l.lowerCap(WSRO.id, CAP).immediate === true,
    'making a bridge safer should never be delayed');

  l.proposeCap(WSRO.id, CAP * 2n, NOW);
  l.lowerCap(WSRO.id, CAP / 2n);
  check('and it abandons any raise in flight', l.report(WSRO.id).pendingCap === null,
    'a decision to shrink overrides an announced expansion');
}

{
  const l = new InboundLedger();
  l.register(WSRO, CAP);
  check('the report tells a stranger how to check it themselves',
    l.report(WSRO.id).howToVerify.includes('public on both chains'),
    'a bound nobody outside can verify is a claim, not a control');
}

// --- release frees headroom -------------------------------------------------
{
  const l = new InboundLedger();
  l.register(WSRO, CAP);
  l.claim({ tokenId: WSRO.id, ethTxHash: TX(20), amount: CAP, recipient: ALICE });
  l.release({ tokenId: WSRO.id, amount: CAP / 2n });
  check('releasing lowers what exists here', l.get(WSRO.id).minted === CAP / 2n);
  check('and frees room under the cap',
    l.report(WSRO.id).headroom === (CAP / 2n).toString(),
    'a small cap still carries unlimited volume over time');
  check('⛔ releasing more than exists is refused',
    throws(() => l.release({ tokenId: WSRO.id, amount: CAP }), 'only'),
    'that would create units on the origin chain that were never burned');
  check('a further claim fits in the freed room',
    !!l.claim({ tokenId: WSRO.id, ethTxHash: TX(21), amount: CAP / 2n, recipient: ALICE }));
}

// --- ⭐ conservation across both chains -------------------------------------
{
  const l = new InboundLedger();
  l.register(WSRO, CAP);
  const TOTAL = 21000000n * UNIT;

  const before = l.conservation(WSRO.id, TOTAL, TOTAL);
  check('with nothing bridged, everything is still on Ethereum', before.ok
    && before.mintedHere === '0');

  // 1,000 burned there, so 1,000 may exist here.
  l.claim({ tokenId: WSRO.id, ethTxHash: TX(30), amount: 1000n * UNIT, recipient: ALICE });
  const after = l.conservation(WSRO.id, TOTAL, TOTAL - 1000n * UNIT);
  check('⭐ after a burn-and-mint the total across both chains is unchanged',
    after.ok && after.total === TOTAL.toString(),
    'the only way to create a unit here is to destroy one there');

  // The failure this check exists to catch: minted here without burning there.
  const broken = l.conservation(WSRO.id, TOTAL, TOTAL);
  check('⛔ minting here WITHOUT burning there is caught', !broken.ok, broken.note);
}

// --- malformed input --------------------------------------------------------
{
  const l = new InboundLedger();
  l.register(WSRO, CAP);
  check('a zero claim is refused',
    throws(() => l.claim({ tokenId: WSRO.id, ethTxHash: TX(40), amount: 0n, recipient: ALICE })));
  check('a negative claim is refused',
    throws(() => l.claim({ tokenId: WSRO.id, ethTxHash: TX(41), amount: -1n, recipient: ALICE })));
  check('a malformed recipient is refused BEFORE anything mutates',
    throws(() => l.claim({ tokenId: WSRO.id, ethTxHash: TX(42), amount: UNIT, recipient: 'nope' }))
    && l.get(WSRO.id).minted === 0n,
    'and the failed claim did not consume its key');
  check('the failed claim can be retried once corrected',
    !!l.claim({ tokenId: WSRO.id, ethTxHash: TX(42), amount: UNIT, recipient: ALICE }));
  check('an unknown asset is refused',
    throws(() => l.claim({ tokenId: '0xdead', ethTxHash: TX(43), amount: UNIT, recipient: ALICE }),
      'unknown bridged asset'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
