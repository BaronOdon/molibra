/**
 * Does the SHA-256 shipped INSIDE chalk.html agree with the node's?
 *
 * The page's grind and the node's verifier have to compute the same number or
 * the button spins forever and every claim is refused. This extracts the real
 * functions out of the page - not a copy of them - and compares against
 * src/work.js over random inputs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { workHash, workValue, workThreshold, verifyWork, DEFAULT_WORK_DIFFICULTY }
  from '../src/work.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(ROOT, 'src/web/chalk.html'), 'utf8');
// Marker-delimited, because an implicit boundary drifted once and this test
// began importing the page's DOM code instead of its arithmetic.
const start = page.indexOf('/* PUZZLE-BEGIN');
const end = page.indexOf('/* PUZZLE-END */');
if (start < 0 || end < 0) throw new Error('could not locate the PUZZLE markers in chalk.html');
const extracted = page.slice(start, end);

const tmp = join(tmpdir(), 'molibra-page-sha.mjs');
writeFileSync(tmp, extracted + '\nexport { digestValue, buildBlock, hexBytes };\n', 'utf8');
const pageCode = await import('file:///' + tmp.replace(/\\/g, '/'));

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
};

console.log('chalk.html vs src/work.js\n');

let mismatches = 0;
for (let i = 0; i < 500; i++) {
  const challenge = '0x' + randomBytes(16).toString('hex');
  const address = '0x' + randomBytes(20).toString('hex');
  const nonce = Math.floor(Math.random() * 2 ** 31);
  const words = pageCode.buildBlock(challenge, address);
  words[10] = nonce | 0;
  const fromPage = pageCode.digestValue(words);
  const fromNode = workValue(workHash(challenge, address, nonce));
  if (fromPage !== fromNode) {
    mismatches++;
    if (mismatches < 3) console.log(`    ${challenge} ${address} ${nonce}: ${fromPage} != ${fromNode}`);
  }
}
check('the page and the node agree on 500 random preimages', mismatches === 0,
  `${mismatches} mismatches`);

// And end to end: let the PAGE's loop find a solution, then have the NODE verify it.
const challenge = '0x' + randomBytes(16).toString('hex');
const address = '0x' + randomBytes(20).toString('hex');
const difficulty = 20000;
const threshold = workThreshold(difficulty);
const words = pageCode.buildBlock(challenge, address);
const t0 = Date.now();
let found = null;
for (let nonce = 0; nonce < 5_000_000; nonce++) {
  words[10] = nonce | 0;
  if (pageCode.digestValue(words) < threshold) { found = nonce; break; }
}
const elapsed = (Date.now() - t0) / 1000;
check('the page loop finds a solution', found !== null, `nonce ${found} in ${elapsed.toFixed(2)}s`);
check('and the node accepts what the page found',
  found !== null && verifyWork(challenge, address, found, difficulty));

// Rate, so the shipped default difficulty is a few seconds and not a frozen tab.
const rateStart = Date.now();
let n = 0;
while (Date.now() - rateStart < 1000) { words[10] = n++ | 0; pageCode.digestValue(words); }
console.log(`\n  page hash rate: ~${(n / 1000).toFixed(0)}k/s in this JS engine`);
console.log(`  default difficulty ${DEFAULT_WORK_DIFFICULTY} => ~${(DEFAULT_WORK_DIFFICULTY / n).toFixed(1)}s expected`);
check('the default difficulty lands in the "a few seconds" band', DEFAULT_WORK_DIFFICULTY / n > 0.4 && DEFAULT_WORK_DIFFICULTY / n < 15,
  'on a browser engine slower than this one it will be longer');

// --- every language says everything -------------------------------------
// A missing key does not crash; it silently falls back to English, so a
// Brazilian reader gets one English sentence in the middle of the page and
// nobody notices. The check is cheap; the failure mode is embarrassing.
const i18nStart = page.indexOf('/* I18N-BEGIN */');
const i18nEnd = page.indexOf('/* I18N-END */');
if (i18nStart < 0 || i18nEnd < 0) throw new Error('could not locate the I18N markers');
const i18nTmp = join(tmpdir(), 'molibra-page-i18n.mjs');
writeFileSync(i18nTmp, page.slice(i18nStart, i18nEnd) + '\nexport { STRINGS };\n', 'utf8');
const { STRINGS } = await import('file:///' + i18nTmp.replace(/\\/g, '/'));

const languages = Object.keys(STRINGS);
check('the page ships more than one language, pt-BR first',
  languages.length > 1 && languages[0] === 'pt-BR', languages.join(', '));

const reference = new Set(Object.keys(STRINGS.en));
const missing = [];
for (const code of languages) {
  for (const key of reference) if (!(key in STRINGS[code])) missing.push(`${code}.${key}`);
  for (const key of Object.keys(STRINGS[code])) if (!reference.has(key)) missing.push(`en.${key}`);
}
check('every language defines every key', missing.length === 0,
  missing.length ? missing.slice(0, 5).join(', ')
    : `${reference.size} keys x ${languages.length} languages`);

const untranslated = Object.keys(STRINGS.en).filter(
  (k) => k !== 'lang' && STRINGS['pt-BR'][k] === STRINGS.en[k]);
check('the pt-BR strings are actually Portuguese, not copied English',
  untranslated.length === 0, untranslated.join(', ') || 'none identical');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
