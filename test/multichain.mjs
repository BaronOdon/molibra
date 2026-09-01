/**
 * The inbound path is chain-agnostic. This is the file that proves it.
 *
 * ⛔⛔ Every other test uses `chainId = 1`. `originChainId` is a parameter in
 * `claimKey`, `commitHeader`, `receiptsRootFor`, `foreignTokenId` and
 * `encodeBridgeRegister`, and nothing hardcodes Ethereum — but "designed to be
 * general" and "verified to be general" are different claims, and only one of
 * them survives somebody refactoring.
 *
 * The practical stake: Arbitrum, Base, Optimism, Polygon and BSC share
 * Ethereum's RLP receipts encoding and the same `Transfer` topic, so the burn
 * prover reads them unmodified. If the ledger is genuinely keyed per chain,
 * supporting them needs no consensus change at all — only somebody committing
 * their headers. That is a large claim resting on these assertions.
 */

import { InboundLedger } from '../src/inbound.js';
import { foreignTokenId, foreignAssetRecord } from '../src/foreign.js';
import { encodeBridgeRegister, decodeBridgeRegister, encodeHeaderCommit, decodeHeaderCommit } from '../src/bridgemint.js';

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};
const throws = (fn, needle) => {
  try { fn(); return false; } catch (e) { return needle ? String(e.message).includes(needle) : true; }
};

console.log('the inbound path across several chains\n');

/** The EVM chains whose receipts encoding the prover already reads. */
const CHAINS = [
  { id: 1n, name: 'Ethereum' },
  { id: 42161n, name: 'Arbitrum One' },
  { id: 8453n, name: 'Base' },
  { id: 10n, name: 'Optimism' },
  { id: 137n, name: 'Polygon' },
  { id: 56n, name: 'BSC' },
];
const CONTRACT = '0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8';
const CAP = 1_000_000n * 10n ** 18n;
const ROOT = '0x' + 'ab'.repeat(32);
/** ⛔ Only a registrar of an asset on a chain may commit that chain's headers -
 *  a real rule this test discovered by violating it. */
const REGISTRAR = '0x1111111111111111111111111111111111111111';

/* ------------------------------------------------- ids are per chain */

const ids = CHAINS.map((c) => foreignTokenId(c.id, CONTRACT));
check('⭐ the SAME contract address on different chains gets different asset ids',
  new Set(ids).size === CHAINS.length,
  `${CHAINS.length} chains, ${new Set(ids).size} distinct ids`);
check('  which is what stops a Base token being spent as its Ethereum namesake',
  foreignTokenId(1n, CONTRACT) !== foreignTokenId(8453n, CONTRACT));
check('⛔ and chain 0 is refused', throws(() => foreignTokenId(0n, CONTRACT)));

/* --------------------------------------------- registration per chain */

const ledger = new InboundLedger();
for (const c of CHAINS) {
  const rec = foreignAssetRecord({
    originChainId: c.id, contract: CONTRACT, symbol: 'WSRO', name: 'WSRO',
  });
  ledger.register(rec, CAP, { registrar: REGISTRAR });
}
check('⭐⭐ all six chains register the same contract side by side',
  ledger.assets.size === CHAINS.length, `${ledger.assets.size} assets`);
check('  and re-registering one of them is still refused', throws(() => {
  ledger.register(foreignAssetRecord({ originChainId: 8453n, contract: CONTRACT, symbol: 'WSRO', name: 'WSRO' }), CAP, { registrar: REGISTRAR });
}, 'already registered'));

/* ------------------------------------------------- headers per chain */

// The same block NUMBER on two chains must not collide: an L2 at height 100
// and Ethereum at height 100 are unrelated facts.
ledger.commitHeader({ originChainId: 1n, blockNumber: 100n, receiptsRoot: ROOT, by: REGISTRAR });
const OTHER = '0x' + 'cd'.repeat(32);
ledger.commitHeader({ originChainId: 8453n, blockNumber: 100n, receiptsRoot: OTHER, by: REGISTRAR });

// ⛔⛔ The rule this test learned the hard way: a stranger cannot commit a
// chain's headers just because the chain exists.
check('⛔⛔ only a registrar of an asset on that chain may commit its headers',
  throws(() => ledger.commitHeader({
    originChainId: 8453n, blockNumber: 101n, receiptsRoot: ROOT,
    by: '0x2222222222222222222222222222222222222222' }), 'registered no asset'),
  'otherwise a new chain id is a free way to introduce a root nobody vouched for');

check('⛔⛔ the same block NUMBER on two chains does not collide',
  ledger.receiptsRootFor(1n, 100n) === ROOT && ledger.receiptsRootFor(8453n, 100n) === OTHER,
  'headers are keyed by (chain, height), never by height alone');
check('  and a height committed on one chain is unknown on another',
  ledger.receiptsRootFor(42161n, 100n) === null,
  'null rather than someone else\'s root, which would be a proof against a number nobody committed');

/* ------------------------------------------ the payloads carry the id */

for (const c of [CHAINS[1], CHAINS[2]]) {
  const enc = encodeBridgeRegister({
    originChainId: c.id, contract: CONTRACT, assetContract: CONTRACT, cap: CAP, symbol: 'WSRO',
  });
  const dec = decodeBridgeRegister(enc);
  check(`a ${c.name} registration round-trips its chain id`, dec.originChainId === c.id, `${dec.originChainId}`);

  const h = decodeHeaderCommit(encodeHeaderCommit({ originChainId: c.id, blockNumber: 7n, receiptsRoot: ROOT }));
  check(`  and so does a ${c.name} header commit`, h.originChainId === c.id && h.blockNumber === 7n);
}

/* -------------------------------------------- the electoral keystone */

// ⛔ Whatever chain it claims to come from, an expression token is refused at
// the door. A new chain id must not become a new way in.
// ⛔⛔ Stronger than "refused": an arriving token cannot DECLARE itself social
// or non-transferable, because those fields are not read from the input at all.
// They are forced. Discovered by asserting the weaker property and watching it
// fail — the record came back purpose 'market', transferable true, kind 'asset'.
check('⛔⛔ an arriving token cannot declare a social purpose, on ANY chain',
  CHAINS.every((c) => foreignAssetRecord({
    originChainId: c.id, contract: CONTRACT, symbol: 'GIZ', name: 'GIZ',
    purpose: 'social', transferable: false,
  }).purpose === 'market'),
  'the field is forced, not validated — so adding a chain adds no way past the electoral rule');
check('  nor can it arrive non-transferable', CHAINS.every((c) => foreignAssetRecord({
    originChainId: c.id, contract: CONTRACT, symbol: 'X', name: 'X', transferable: false,
  }).transferable === true),
  'a non-transferable arrival would be an expression instrument wearing a bridge');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
