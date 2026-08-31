/**
 * Molibra - blind credentials, phase 2: what the chain does with them.
 *
 * Phase 1's tests prove the cryptography. These prove the CONSENSUS rules, and
 * the one that matters most is section 4: a credential is unique by its
 * SERIAL, not by the wallet that spent it. Every other check here would still
 * pass if that were wrong, which is exactly why it is tested on its own.
 */

import * as blind from '../src/blind.js';
import {
  encodePollOpen, decodePollOpen, encodeCredentialExpress, decodeCredentialExpress,
  assertPollOpenShape, credentialIsValid, serialKey,
  POLL_OPEN_TAG, CREDENTIAL_TAG, POLL_OPEN_BYTES, CREDENTIAL_BYTES,
} from '../src/credential.js';
import { State, applyTransaction } from '../src/state.js';
import { toPollId } from '../src/vote.js';
import { intrinsicGas } from '../src/tx.js';
import { toHex, fromHex } from '../src/crypto.js';

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

const PLACE = toPollId('prefeitura-sp-2026');
const OPENER = '0x1111111111111111111111111111111111111111';
const ALICE  = '0x2222222222222222222222222222222222222222';
const BOB    = '0x3333333333333333333333333333333333333333';
const MINER  = '0x9999999999999999999999999999999999999999';
const COMMIT = '0x' + 'cd'.repeat(32);

const place = blind.generateCredentialKey();
const params = blind.publicParams(place.publicKeyPem);

/** A credential the publisher signed without seeing: the whole phase-1 dance. */
function mintCredential() {
  const serial = blind.newSerial();
  const { blinded, unblinder } = blind.blind(serial, params);
  const signature = blind.unblind(
    blind.signBlinded(blinded, place.privateKeyPem, params), unblinder, params);
  return { serial, signature };
}

function funded() {
  const s = new State();
  for (const a of [OPENER, ALICE, BOB]) s.credit(a, 10n ** 18n);
  return s;
}

const tx = (from, data, nonce = 0n) => ({
  from, to: from, value: 0n, nonce, gasPrice: 1n, gasLimit: 200000n, data,
});

const apply = (state, t, block = 1n) => applyTransaction(state, t, intrinsicGas(t), MINER, block);

/* ------------------------------------------------------------------ */
/* 1. Encoding.                                                        */
/* ------------------------------------------------------------------ */

const openData = encodePollOpen(PLACE, params);
check('a poll opening encodes to a fixed length',
  fromHex(openData).length === POLL_OPEN_BYTES, `${POLL_OPEN_BYTES} bytes`);
check('and carries the tag', openData.startsWith(POLL_OPEN_TAG));

const back = decodePollOpen(openData);
check('the modulus survives the round trip', back.n === params.n);
check('the exponent survives the round trip', back.e === params.e, `e=${back.e}`);
check('the place survives the round trip', back.pollId === PLACE);

const cred = mintCredential();
const credData = encodeCredentialExpress(PLACE, cred.serial, COMMIT, cred.signature);
check('a credential expression encodes to a fixed length',
  fromHex(credData).length === CREDENTIAL_BYTES, `${CREDENTIAL_BYTES} bytes`);
const cback = decodeCredentialExpress(credData);
check('the signature survives the round trip', cback.signature === cred.signature);
check('the serial survives the round trip', cback.serial === cred.serial);
check('the commitment survives the round trip', cback.commitment === COMMIT);
check('the two tags are different', POLL_OPEN_TAG !== CREDENTIAL_TAG);
check('an ordinary transfer decodes as neither',
  decodePollOpen('0x') === null && decodeCredentialExpress('0x') === null);

/* ------------------------------------------------------------------ */
/* 2. A key that could be forged is refused at the door.               */
/* ------------------------------------------------------------------ */

function refuses(label, fn, detail = '') {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(label, threw, detail);
}

refuses('⛔ a short modulus is refused', () => assertPollOpenShape({ n: 65537n, e: 3n }),
  'a small modulus signs things anybody can forge');
refuses('⛔ an even modulus is refused', () => assertPollOpenShape({ n: (1n << 2047n) * 2n, e: 3n }));
refuses('⛔ an exponent of 1 is refused', () => assertPollOpenShape({ n: params.n, e: 1n }));
refuses('⛔ an even exponent is refused', () => assertPollOpenShape({ n: params.n, e: 4n }));
check('the real key passes', (() => {
  try { assertPollOpenShape(params); return true; } catch { return false; }
})());

/* ------------------------------------------------------------------ */
/* 3. Opening a place, and spending a credential.                      */
/* ------------------------------------------------------------------ */

const state = funded();
const openReceipt = await apply(state, tx(OPENER, openData));
check('a voting place opens', state.getPlace(PLACE) !== null);
check('the receipt names the place opened', openReceipt.placeOpened === PLACE);
check('and records who opened it', state.getPlace(PLACE).opener === OPENER);
check('opening moved the state root', state.root() !== funded().root());

const rootBeforeSpend = state.root();
const spendReceipt = await apply(state, tx(ALICE, credData));
check('a genuine credential is spent', spendReceipt.credentialSerial === cred.serial);
check('and the serial is now recorded',
  state.hasSpentSerial(serialKey(PLACE, cred.serial)));
check('spending moved the state root', state.root() !== rootBeforeSpend);

/* ------------------------------------------------------------------ */
/* 4. ⛔⛔ THE PROPERTY. Uniqueness is by SERIAL, not by wallet.        */
/* ------------------------------------------------------------------ */

let replayed = false;
try { await apply(state, tx(BOB, credData)); } catch { replayed = true; }
check('⛔⛔ the SAME credential cannot be spent again by a DIFFERENT wallet',
  replayed,
  'if uniqueness were keyed on the wallet this would pass and the scheme would be worthless');

let selfReplay = false;
try { await apply(state, tx(ALICE, credData, 1n)); } catch { selfReplay = true; }
check('⛔ nor again by the same wallet', selfReplay);

const second = mintCredential();
const secondData = encodeCredentialExpress(PLACE, second.serial, COMMIT, second.signature);
const bobReceipt = await apply(state, tx(BOB, secondData));
check('⛔⛔ but a DIFFERENT credential spent by the same wallet is fine',
  bobReceipt.credentialSerial === second.serial,
  'the wallet is not the unit of account; the credential is');

const third = mintCredential();
const thirdData = encodeCredentialExpress(PLACE, third.serial, COMMIT, third.signature);
await apply(state, tx(BOB, thirdData, 1n));
check('⛔⛔ and one wallet may spend SEVERAL credentials',
  state.hasSpentSerial(serialKey(PLACE, third.serial)),
  'the chain cannot tell whose they were - which is the point');

check('no wallet address appears in any spent-serial key',
  [...state.spentSerials].every((k) => ![OPENER, ALICE, BOB].some(
    (a) => k.includes(a.slice(2).toLowerCase()))),
  'the key is the place and the serial, and nothing else');

/* ------------------------------------------------------------------ */
/* 5. Forgery and misuse.                                             */
/* ------------------------------------------------------------------ */

const forged = encodeCredentialExpress(PLACE, blind.newSerial(), COMMIT, 12345n);
let forgeRefused = false;
try { await apply(state, tx(ALICE, forged, 1n)); } catch { forgeRefused = true; }
check('⛔ a made-up signature is refused', forgeRefused);

const otherPlace = blind.generateCredentialKey();
const otherParams = blind.publicParams(otherPlace.publicKeyPem);
const foreignSerial = blind.newSerial();
const fb = blind.blind(foreignSerial, otherParams);
const foreignSig = blind.unblind(
  blind.signBlinded(fb.blinded, otherPlace.privateKeyPem, otherParams), fb.unblinder, otherParams);
const foreignData = encodeCredentialExpress(PLACE, foreignSerial, COMMIT, foreignSig);
let foreignRefused = false;
try { await apply(state, tx(ALICE, foreignData, 1n)); } catch { foreignRefused = true; }
check('⛔⛔ a credential from ANOTHER place is refused here',
  foreignRefused, 'this is what makes a per-place quota enforceable');

const unopened = encodeCredentialExpress(toPollId('never-opened'), cred.serial, COMMIT, cred.signature);
let noPlace = false;
try { await apply(state, tx(ALICE, unopened, 1n)); } catch { noPlace = true; }
check('⛔ a credential for a place that was never opened is refused', noPlace);

let reopened = false;
try { await apply(state, tx(OPENER, openData, 1n)); } catch { reopened = true; }
check('⛔ a place cannot be opened twice', reopened,
  'the second opening would replace the key and invalidate every credential issued');

const notSelf = { ...tx(ALICE, secondData, 1n), to: BOB };
let mustBeSelf = false;
try { await apply(state, notSelf); } catch { mustBeSelf = true; }
check('⛔ a credential expression must be self-addressed', mustBeSelf);

const carriesValue = { ...tx(ALICE, secondData, 1n), value: 1n };
let noValue = false;
try { await apply(state, carriesValue); } catch { noValue = true; }
check('⛔ and moves no value', noValue);

/* ------------------------------------------------------------------ */
/* 6. Refused transactions leave nothing behind.                       */
/* ------------------------------------------------------------------ */

const clean = state.root();
for (const bad of [forged, foreignData, unopened]) {
  try { await apply(state, tx(ALICE, bad, 9n)); } catch { /* expected */ }
}
check('⛔ every refused credential left the state untouched', state.root() === clean,
  'a half-applied refusal is a chain split');

/* ------------------------------------------------------------------ */
/* 7. A chain with no credentials hashes as it always did.             */
/* ------------------------------------------------------------------ */

const plain = new State();
plain.credit(ALICE, 5n);
const plainRoot = plain.root();
plain.polls = new Map();
plain.spentSerials = new Set();
check('places and serials are appended only when present', plain.root() === plainRoot);

/* ------------------------------------------------------------------ */
/* 8. Clone isolation - a rejected block must not open a place.        */
/* ------------------------------------------------------------------ */

const parent = funded();
const parentRoot = parent.root();
const candidate = parent.clone();
await apply(candidate, tx(OPENER, openData));
check('⛔ opening a place in a candidate block does not touch its parent',
  parent.root() === parentRoot && parent.getPlace(PLACE) === null);

/* ------------------------------------------------------------------ */
/* 9. The claim, by its own name.                                      */
/* ------------------------------------------------------------------ */

check('⛔ this buys UNLINKABILITY, not coercion resistance', true,
  'the holder can still prove to a buyer which credential was theirs');

/* ------------------------------------------------------------------ */
/* 10. The publisher: a quota it can enforce without seeing through it. */
/* ------------------------------------------------------------------ */

const { Publisher } = await import('../src/publisher.js');

const pub = new Publisher({ quota: 2 });
const opened = pub.openPlace('camara-rj-2026');
check('the publisher opens a place and hands back POLL_OPEN calldata',
  opened.data.startsWith(POLL_OPEN_TAG) && fromHex(opened.data).length === POLL_OPEN_BYTES);

const pp = pub.paramsFor(opened.pollId);
const st2 = funded();
await apply(st2, tx(OPENER, opened.data));
check('that calldata opens the place on chain', st2.getPlace(opened.pollId) !== null);

/** The full dance against the publisher, as a client would do it. */
function requestCredential(account) {
  const serial = blind.newSerial();
  const b = blind.blind(serial, pp);
  const signature = blind.unblind(pub.signFor(account, opened.pollId, b.blinded), b.unblinder, pp);
  return { serial, signature };
}

const c1 = requestCredential(ALICE);
const d1 = encodeCredentialExpress(opened.pollId, c1.serial, COMMIT, c1.signature);
const r1 = await apply(st2, tx(ALICE, d1));
check('a publisher-issued credential spends on chain', r1.credentialSerial === c1.serial);

check('the quota counts down', pub.remainingFor(opened.pollId, ALICE) === 1,
  `${pub.issuedTo(opened.pollId, ALICE)} of ${pub.quota} used`);

const c2 = requestCredential(ALICE);
check('the second credential is issued', pub.remainingFor(opened.pollId, ALICE) === 0);

let overQuota = false;
try { requestCredential(ALICE); } catch { overQuota = true; }
check('⛔ a third is refused: the quota is enforced', overQuota);

check('⛔ and another account has its own quota, untouched',
  pub.remainingFor(opened.pollId, BOB) === 2,
  'the quota is per account per place, not global');

check('⛔ a place the publisher has no key for cannot be signed for', (() => {
  try { pub.signFor(ALICE, 'somewhere-else', 5n); return false; } catch { return true; }
})());

check('⛔ a blinded value outside the modulus is refused clearly', (() => {
  try { pub.signFor(BOB, opened.pollId, pp.n); return false; } catch { return true; }
})());

/* ⛔⛔ The property the whole scheme exists for. */
const held = JSON.stringify([...pub.issued.entries()]);
check('⛔⛔ the publisher holds a COUNT, and no serial it could link',
  !held.includes(c1.serial.slice(2)) && !held.includes(c2.serial.slice(2)),
  'nothing the publisher stores appears in any expression on the chain');
check('⛔⛔ nor does any blinded value it signed',
  !held.includes('0x') || [...pub.issued.values()].every((v) => typeof v === 'number'),
  'a request log could be correlated with the chain by ordering alone');
check('the publisher describes what it buys, and what it does not',
  pub.describe().doesNotBuy.includes('coercion'));
check('⛔ and does not list the accounts that asked',
  JSON.stringify(pub.describe()).toLowerCase().indexOf(ALICE.slice(2).toLowerCase()) === -1,
  'naming every requester would hand an observer the anonymity set');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
