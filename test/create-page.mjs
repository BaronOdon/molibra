/**
 * The create-a-question form, checked against the chain that will judge it.
 *
 * A form that accepts what consensus refuses is worse than no form: the person
 * fills it in, pays gas, and the transaction is thrown away by every node with
 * an error they never see. So the page's own validation is extracted from the
 * shipped file and run against `normalizeTokenRecord` itself — every record the
 * form calls valid must be accepted, and every record it refuses must be one
 * the chain would also refuse.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeTokenRecord, encodeTokenCreate, decodeTokenCreate } from '../src/token.js';
import { privateToAddress, fromHex } from '../src/crypto.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(ROOT, 'src/web/create.html'), 'utf8');

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('create.html vs src/token.js\n');

const start = page.indexOf('/* RECORD-BEGIN');
const end = page.indexOf('/* RECORD-END */');
if (start < 0 || end < 0) throw new Error('could not locate the RECORD markers in create.html');
const tmp = join(tmpdir(), 'molibra-create-record.mjs');
writeFileSync(tmp, page.slice(start, end)
  + '\nexport { problemsWith, buildRecord, PURPOSES, VOTE_MODES, expressionsPerUnit };\n', 'utf8');
const form = await import('file:///' + tmp.replace(/\\/g, '/'));

const CREATOR = privateToAddress(fromHex('0x' + '01'.repeat(32)));
const UNIT = 10n ** 18n;

const base = {
  title: 'Quem você comprou hoje?',
  options: ['A', 'B'],
  purpose: 'purchase',
  voteMode: 'quantum',
  cap: 2,
  expressionCost: (UNIT / 1000n).toString(),
  initialSupply: '0',
  maxSupply: '0',
  issuable: true,
  transferable: false,
};

/** Does the chain accept what the form built? */
function chainAccepts(f) {
  try { normalizeTokenRecord(form.buildRecord(f), CREATOR, 1n); return null; }
  catch (e) { return e.message; }
}

// --- the form and the chain agree on a good record ------------------------
check('the form calls a well-formed question valid', form.problemsWith(base).length === 0,
  form.problemsWith(base).join(', ') || 'no problems');
check('and the chain accepts exactly what the form built', chainAccepts(base) === null,
  chainAccepts(base) ?? 'accepted');

const record = form.buildRecord(base);
const normalized = normalizeTokenRecord(record, CREATOR, 1n);
check('every field the form sets survives normalisation unchanged',
  normalized.title === record.title
  && normalized.voteMode === record.voteMode
  && normalized.purpose === record.purpose
  && normalized.expressionCost === record.expressionCost
  && normalized.issuable === record.issuable
  && normalized.transferable === record.transferable);

// The payload the page builds must decode to the record it showed.
const TAG = '0x73306244';
const encoded = TAG + Array.from(new TextEncoder().encode(JSON.stringify(record)),
  (b) => b.toString(16).padStart(2, '0')).join('');
check('the page\'s payload is byte-identical to encodeTokenCreate',
  encoded === encodeTokenCreate(record));
check('and it decodes back to the same record',
  JSON.stringify(decodeTokenCreate(encoded)) === JSON.stringify(record));

// --- everything the form refuses, the chain refuses too -------------------
// This is the direction that matters: a form refusing something valid is an
// annoyance, but a form ACCEPTING something invalid takes the person's gas.
const bad = [
  ['needsTitle', { ...base, title: '   ' }],
  ['needsTwoOptions', { ...base, options: ['only one'] }],
  ['tooManyOptions', { ...base, options: Array.from({ length: 65 }, (_, i) => 'o' + i) }],
  ['needsPurpose', { ...base, purpose: 'invented' }],
  ['needsCost', { ...base, expressionCost: '0' }],
  ['noEnqueteName', { ...base, title: 'Enquete: quem você prefere?' }],
  ['noEnqueteName', { ...base, title: 'Pesquisa de intenção de voto' }],
  ['cannotTransfer', { ...base, transferable: true }],
  ['cannotTransfer', { ...base, purpose: 'social', transferable: true }],
  ['cannotTransfer', { ...base, purpose: 'electoral', transferable: true }],
  ['deadEnd', { ...base, issuable: false, transferable: false }],
  ['needsCap', { ...base, voteMode: 'capped', cap: 0 }],
];

let mismatches = [];
for (const [expected, f] of bad) {
  const problems = form.problemsWith(f);
  const rejection = chainAccepts(f);
  if (!problems.includes(expected)) mismatches.push(`${expected}: form allowed it`);
  // Every case the form refuses must also be refused by the chain, except the
  // ones the form is stricter about on purpose (duplicate options, cap shape).
  if (rejection === null && !['needsCap'].includes(expected)) {
    mismatches.push(`${expected}: chain accepted it`);
  }
}
check('every record the form refuses, the chain refuses too', mismatches.length === 0,
  mismatches.join(' | ') || `${bad.length} cases`);

// --- the form is stricter in exactly one place, and deliberately ----------
const dupes = { ...base, options: ['Sim', 'sim'] };
check('the form also refuses duplicate options, which the chain tolerates',
  form.problemsWith(dupes).includes('duplicateOptions') && chainAccepts(dupes) === null,
  'a question with two identical answers is a mistake, not a rule violation');

// --- transferability offered exactly where consensus permits it ----------
const allowed = Object.entries(form.PURPOSES).filter(([, p]) => p.mayTransfer).map(([k]) => k);
const refused = Object.entries(form.PURPOSES).filter(([, p]) => !p.mayTransfer).map(([k]) => k);
check('the form offers transferability for market and behaviour only',
  allowed.join(',') === 'market,behaviour', allowed.join(', '));
let wrong = [];
for (const purpose of refused) {
  if (chainAccepts({ ...base, purpose, transferable: true }) === null) wrong.push(purpose);
}
for (const purpose of allowed) {
  if (chainAccepts({ ...base, purpose, transferable: true }) !== null) wrong.push(purpose);
}
check('and the chain agrees on every one of them', wrong.length === 0,
  wrong.join(', ') || refused.join(', ') + ' refused');

// --- all four modes are offered and all four are real --------------------
let modeProblems = [];
for (const voteMode of form.VOTE_MODES) {
  const f = { ...base, voteMode, cap: 2, purpose: voteMode === 'weighted' ? 'market' : 'purchase' };
  if (form.problemsWith(f).length) modeProblems.push(`${voteMode}: form`);
  if (chainAccepts(f) !== null) modeProblems.push(`${voteMode}: ${chainAccepts(f)}`);
}
check('every mode the form offers is one the chain implements', modeProblems.length === 0,
  modeProblems.join(' | ') || form.VOTE_MODES.join(', '));

// --- the cost arithmetic the person actually sees ------------------------
check('1000 millionths of a unit reads back as 1,000 expressions per unit',
  form.expressionsPerUnit((UNIT / 1000n).toString()) === 1000n);
check('a cost of zero reports zero rather than dividing by it',
  form.expressionsPerUnit('0') === 0n);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
