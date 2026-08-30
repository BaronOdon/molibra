/**
 * Anchoring - the reorg risk it removes, and the risk it does not.
 *
 * The tests worth having here are the ones that fail if somebody later
 * "simplifies" the rule: that an anchor beats work, that an unconfirmed anchor
 * beats nothing, that an equivocating publisher is believed about nothing, and
 * that a chain with no anchors behaves exactly as it always did.
 */

import {
  AnchorStore, anchorDigest, ETH_CONFIRMATIONS, TARGET_ANCHOR_INTERVAL,
} from '../src/anchor.js';

let passed = 0; let failed = 0;
const check = (name, ok, note = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}${note ? '  ' + note : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${note ? '  ' + note : ''}`); }
};
const H = (n) => '0x' + n.toString(16).padStart(64, '0');

console.log('anchoring\n');

// --- the digest -------------------------------------------------------------
const d1 = anchorDigest({ height: 100, blockHash: H(0xaa), cumulativeWork: 5000 });
check('the digest is deterministic',
  d1 === anchorDigest({ height: 100, blockHash: H(0xaa), cumulativeWork: 5000 }));
check('a different block at the same height is a different digest',
  d1 !== anchorDigest({ height: 100, blockHash: H(0xbb), cumulativeWork: 5000 }),
  'this is what makes equivocation provable');
check('a different work claim is a different digest',
  d1 !== anchorDigest({ height: 100, blockHash: H(0xaa), cumulativeWork: 5001 }));

// --- confirmations: an unconfirmed anchor binds nothing ---------------------
{
  const s = new AnchorStore();
  s.add({ height: 100, blockHash: H(0xaa), cumulativeWork: 5000, ethBlock: 1000 });
  s.setEthereumHead(1000n + BigInt(ETH_CONFIRMATIONS) - 1n);
  check('an anchor one block short of confirmation does not bind',
    s.finalizedHeight() === -1n && s.binding().length === 0,
    'an anchor inside a reorganisable Ethereum block is worth nothing');
  check('and it permits any reorg while unconfirmed',
    s.permitsReorgFrom(0).ok);

  s.setEthereumHead(1000n + BigInt(ETH_CONFIRMATIONS));
  check('at exactly the confirmation depth it binds', s.finalizedHeight() === 100n);
}

// --- ⛔⛔ the inversion: an anchor beats work -------------------------------
{
  const s = new AnchorStore();
  s.add({ height: 500, blockHash: H(0xcc), cumulativeWork: 90000, ethBlock: 2000 });
  s.setEthereumHead(2000n + BigInt(ETH_CONFIRMATIONS));

  const below = s.permitsReorgFrom(499);
  check('a branch forking BELOW the anchored floor is refused', !below.ok, below.reason);
  check('the refusal names the floor', below.floor === 500n);
  check('and says work does not override it',
    below.reason.includes('Accumulated work does not override an anchor'));

  check('a branch forking AT the floor is allowed', s.permitsReorgFrom(500).ok,
    'the anchor attests to that block, not to what comes after it');
  check('a branch forking above the floor is allowed', s.permitsReorgFrom(501).ok);
}

// --- ⛔ equivocation ---------------------------------------------------------
{
  const s = new AnchorStore();
  s.add({ height: 300, blockHash: H(0x11), cumulativeWork: 7000, ethBlock: 500, publisher: '0xPUB' });
  const second = s.add({ height: 300, blockHash: H(0x22), cumulativeWork: 7000, ethBlock: 501, publisher: '0xPUB' });
  check('the same height attested two ways is refused', !second.added && !!second.fault);
  check('and is recorded as a fault', s.equivocations.length === 1);
  check('the fault carries both sides, which IS the slashing proof',
    second.fault.a.blockHash === H(0x11) && second.fault.b.blockHash === H(0x22));

  s.setEthereumHead(500n + BigInt(ETH_CONFIRMATIONS) * 2n);
  check('an equivocated height binds NOTHING',
    s.finalizedHeight() === -1n,
    'a publisher who attested to two histories tells us nothing about either');

  const dup = s.add({ height: 300, blockHash: H(0x11), cumulativeWork: 7000, ethBlock: 500 });
  check('an identical re-publish is not equivocation', !dup.fault,
    'a retry is not a fault');
}

// --- work must increase with height -----------------------------------------
{
  const s = new AnchorStore();
  s.add({ height: 100, blockHash: H(1), cumulativeWork: 9000, ethBlock: 10 });
  const r = s.add({ height: 200, blockHash: H(2), cumulativeWork: 8000, ethBlock: 20 });
  check('more height with less work is refused', !r.added,
    'a higher block cannot carry less accumulated work');
  check('and the regression is kept as evidence, not discarded',
    s.equivocations.length === 1);
}

// --- ⛔ disagreement with the local chain ------------------------------------
{
  const s = new AnchorStore();
  s.add({ height: 700, blockHash: H(0xdd), cumulativeWork: 100000, ethBlock: 3000 });
  s.setEthereumHead(3000n + BigInt(ETH_CONFIRMATIONS));

  const agree = s.disagreements((h) => (h === 700n ? H(0xdd) : null));
  check('a node on the anchored chain reports no disagreement', agree.length === 0);

  const clash = s.disagreements((h) => (h === 700n ? H(0xee) : null));
  check('a node on a DIFFERENT chain reports it loudly', clash.length === 1,
    clash[0]?.note ?? '');
  check('the disagreement carries both hashes',
    clash[0].anchored === H(0xdd) && clash[0].local === H(0xee));
}

// --- health: the number to publish instead of the word "final" --------------
{
  const s = new AnchorStore();
  check('with no anchors, ALL history is exposed',
    s.anchorHealth(1000).blocksExposed === '1000'
    && s.anchorHealth(1000).finalizedHeight === null
    && !s.anchorHealth(1000).healthy,
    s.anchorHealth(1000).note);

  s.add({ height: 950, blockHash: H(9), cumulativeWork: 12345, ethBlock: 4000 });
  s.setEthereumHead(4000n + BigInt(ETH_CONFIRMATIONS));
  const h = s.anchorHealth(1000);
  check('with an anchor, only the gap above it is exposed',
    h.blocksExposed === '50' && h.finalizedHeight === '950', h.note);
  check('and that is inside the target interval', h.healthy,
    `target ${TARGET_ANCHOR_INTERVAL}`);
  check('a stale anchor is reported unhealthy',
    !s.anchorHealth(5000).healthy, 'the gap has outgrown twice the interval');
}

// --- Ethereum reorging under us ---------------------------------------------
{
  const s = new AnchorStore();
  s.setEthereumHead(5000);
  s.setEthereumHead(4990);
  check('Ethereum going backwards is recorded, not swallowed',
    s.reorgOnAnchorChain?.from === '5000' && s.reorgOnAnchorChain?.to === '4990');
}

// --- malformed anchors ------------------------------------------------------
{
  const s = new AnchorStore();
  const bad = (raw) => { try { s.add(raw); return false; } catch { return true; } };
  check('an anchor needs a block hash', bad({ height: 1, cumulativeWork: 1, ethBlock: 1 }));
  check('an anchor needs positive work',
    bad({ height: 1, blockHash: H(1), cumulativeWork: 0, ethBlock: 1 }));
  check('an anchor needs its Ethereum block',
    bad({ height: 1, blockHash: H(1), cumulativeWork: 1 }));
  check('an anchor needs a height',
    bad({ blockHash: H(1), cumulativeWork: 1, ethBlock: 1 }));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
