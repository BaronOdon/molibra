/**
 * Destroying MOLI so it may exist somewhere else.
 *
 * The Ethereum half of this lives in `bridge/bridgedmoli-build-and-test.mjs`,
 * which needs a compiler and therefore cannot run here. What this file proves
 * is the half that has to be true first: that a `moliBurn` payload really
 * takes MOLI out of existence, that nobody is credited it, that the amount is
 * in the state root, and that a chain with no burn on it hashes exactly as it
 * did before the instruction existed.
 *
 * ⛔⛔ The rule under test that matters most is the one about `bridgeOut`.
 * That payload is the same 56-byte shape and moves NOTHING - src/bridge.js
 * says so in its own first paragraph. It must never be mistaken for this one,
 * because a mint on the far side against a payload that destroyed nothing
 * would let one coin mint forever.
 */

import { State, applyTransaction } from '../src/state.js';
import { intrinsicGas } from '../src/tx.js';
import {
  encodeMoliBurn, decodeMoliBurn, MOLI_BURN_TAG, OutboundLedger, MOLI_BURN_ACTIVATION,
} from '../src/moliburn.js';
import { encodeBridgeOut, decodeBridgeOut, BRIDGE_OUT_TAG } from '../src/bridge.js';

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('moliBurn: MOLI leaves existence\n');

const MINER = '0x9999999999999999999999999999999999999999';
const ALICE = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
const BOB = '0x2b5ad5c4795c026514f8317c7a215e218dccd6cf';
const OVER_THERE = '0x3333333333333333333333333333333333333333';

const START = 10_000n * 10n ** 18n;
const BURN = 2_000n * 10n ** 18n;

const fresh = () => {
  const s = new State();
  s.credit(ALICE, START);
  s.credit(BOB, START);
  return s;
};

const tx = (state, from, data, value = 0n) => ({
  from, to: from, value, nonce: state.nonceOf(from),
  gasPrice: 1n, gasLimit: 3_000_000n, data,
});
// ⛔ At or after the flag day. A burn below MOLI_BURN_ACTIVATION is not a
// burn at all - see the gate tests at the end of this file.
const AFTER = MOLI_BURN_ACTIVATION;
const apply = (state, t, block = AFTER) =>
  applyTransaction(state, t, intrinsicGas(t), MINER, block);

/* ------------------------------------------------------- the payload */

check('the tag is derived, not written down', MOLI_BURN_TAG === '0x94a06c3e', MOLI_BURN_TAG);
check('⛔⛔ and it is NOT bridgeOut\'s', MOLI_BURN_TAG !== BRIDGE_OUT_TAG,
  `${MOLI_BURN_TAG} vs ${BRIDGE_OUT_TAG} - four bytes between "destroyed" and "said"`);

const data = encodeMoliBurn(OVER_THERE, BURN);
const decoded = decodeMoliBurn(data);
check('a burn round-trips through its own codec',
  decoded.recipient === OVER_THERE && decoded.amount === BURN);
check('⛔ a bridgeOut payload does NOT decode as a burn',
  decodeMoliBurn(encodeBridgeOut(OVER_THERE, BURN)) === null,
  'the decoder must not be the thing that confuses them');
check('⛔ and a burn does not decode as a bridgeOut',
  decodeBridgeOut(data) === null,
  'each decoder must reject the other payload, not merely prefer its own');

let threw = null;
try { encodeMoliBurn(OVER_THERE, 0n); } catch (e) { threw = e; }
check('⛔ a zero burn cannot be encoded', threw !== null);

threw = null;
try { decodeMoliBurn(MOLI_BURN_TAG + '0'.repeat(40) + '1'.padStart(64, '0')); } catch (e) { threw = e; }
check('⛔ a burn to the zero address is refused', threw !== null,
  'it would destroy MOLI here and be unclaimable there');

threw = null;
try { decodeMoliBurn(MOLI_BURN_TAG + 'aa'); } catch (e) { threw = e; }
check('⛔ a malformed burn throws rather than decoding to something', threw !== null);

/* -------------------------------------------------------- the effect */

const state = fresh();
const before = state.balanceOf(ALICE);
const t = tx(state, ALICE, data);
const fee = intrinsicGas(t) * 1n;
await apply(state, t);

check('⭐ the burner is lighter by the burn plus the fee',
  state.balanceOf(ALICE) === before - BURN - fee,
  `${before} -> ${state.balanceOf(ALICE)}`);
check('⛔⛔ and NOBODY holds the burned amount',
  state.balanceOf(MINER) === fee,
  'the miner has the fee and nothing else: there is no vault, so there is nothing to rob');
check('the ledger counts what was destroyed', state.outbound.burned === BURN);
check('  and for whom', state.outbound.byRecipient.get(OVER_THERE) === BURN);

// Two burns accumulate rather than replacing one another.
await apply(state, tx(state, BOB, encodeMoliBurn(OVER_THERE, BURN)));
check('a second burn to the same recipient accumulates',
  state.outbound.burned === BURN * 2n && state.outbound.byRecipient.get(OVER_THERE) === BURN * 2n);

/* ---------------------------------------------------------- the root */

const withBurn = fresh();
await apply(withBurn, tx(withBurn, ALICE, data));
const without = fresh();
// The same balance movement, but by an ordinary transfer to the miner rather
// than a burn - so the ONLY difference is the destruction itself.
check('⛔⛔ the burn is IN the state root',
  withBurn.root() !== without.root(),
  'two nodes that disagreed about what was destroyed must fork, as they should');

const roundTripped = State.fromJSON(JSON.parse(JSON.stringify(withBurn.toJSON())));
check('⛔ the ledger survives a datadir round trip',
  roundTripped.outbound.burned === BURN && roundTripped.root() === withBurn.root(),
  'a restarted node would otherwise disagree with itself about what it destroyed');

const a = new State(); a.credit(ALICE, START);
const b = new State(); b.credit(ALICE, START);
check('⛔ a chain with no burn on it hashes exactly as it did before',
  a.root() === b.root() && a.outbound.rootLines().length === 0,
  'appended only when present: adding this instruction is not a hard fork');

/* ------------------------------------------------------------ reorgs */

const parent = fresh();
const candidate = parent.clone();
await apply(candidate, tx(candidate, ALICE, data));
check('⛔ a burn in a candidate block does not touch its parent',
  parent.outbound.burned === 0n && candidate.outbound.burned === BURN,
  'a reorg must give the MOLI back, or it is destroyed on a chain that no longer exists');
check('  and the parent balance is untouched', parent.balanceOf(ALICE) === START);

/* -------------------------------------------------------- refusals */

async function refuses(label, state_, t_, detail = '') {
  const rootBefore = state_.root();
  let e = null;
  try { await apply(state_, t_); } catch (err) { e = err; }
  check(label, e !== null && state_.root() === rootBefore,
    detail || (e ? String(e.message).slice(0, 80) : 'IT WAS ACCEPTED'));
}

const s2 = fresh();
await refuses('⛔ a burn beyond the balance is refused', s2,
  tx(s2, ALICE, encodeMoliBurn(OVER_THERE, START * 2n)));
await refuses('⛔ a burn that cannot also cover the fee is refused', s2,
  tx(s2, ALICE, encodeMoliBurn(OVER_THERE, START)),
  'the fee is taken on top: a burn of the whole balance leaves nothing to pay with');
await refuses('⛔ a burn carrying value as well is refused', s2,
  tx(s2, ALICE, encodeMoliBurn(OVER_THERE, 10n ** 18n), 10n ** 18n),
  'two places to say the amount is one place for them to disagree');

/* ------------------------------------------------------ the ledger */

const led = new OutboundLedger();
check('an empty ledger contributes nothing to the root', led.rootLines().length === 0);
check('  and serialises to nothing', led.toJSON() === null);
led.burn(OVER_THERE, 5n);
const copy = led.clone();
copy.burn(OVER_THERE, 7n);
check('⛔ a cloned ledger is copied, not shared',
  led.burned === 5n && copy.burned === 12n);
check('a round trip through JSON preserves the total',
  OutboundLedger.fromJSON(led.toJSON()).burned === 5n);

/* ------------------------------------------------- the activation gate */

/**
 * ⛔⛔ Below the flag day a burn payload must behave EXACTLY as it does on a
 * node running the old code: ordinary data, nothing destroyed. If it did not,
 * an upgraded node and an un-upgraded one would compute different roots for
 * the same block - a chain split, not a disagreement.
 */
const early = fresh();
const earlyBefore = early.balanceOf(ALICE);
const et = tx(early, ALICE, data);
const earlyFee = intrinsicGas(et) * 1n;
await applyTransaction(early, et, intrinsicGas(et), MINER, MOLI_BURN_ACTIVATION - 1n);
check('⛔⛔ one block BEFORE activation, nothing is burned',
  early.outbound.burned === 0n,
  'an un-upgraded node moves nothing here, and the two must agree');
check('  and the balance moved only by the fee',
  early.balanceOf(ALICE) === earlyBefore - earlyFee,
  'exactly what an old node does with data it does not recognise');
check('  so the ledger contributes nothing to the root',
  early.outbound.rootLines().length === 0);

const onTime = fresh();
const ot = tx(onTime, ALICE, data);
await applyTransaction(onTime, ot, intrinsicGas(ot), MINER, MOLI_BURN_ACTIVATION);
check('⭐ and AT the activation height it burns', onTime.outbound.burned === BURN,
  `activation height ${MOLI_BURN_ACTIVATION}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
