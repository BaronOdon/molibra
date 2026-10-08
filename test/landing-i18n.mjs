/**
 * The front page in every language it offers: each /molibra/i18n/<code>.json
 * carries exactly the keys the page tags (data-t) plus the ones its script
 * uses, keeps the *emphasis* / **bold** markup balanced like the English
 * source, and names itself as the picker does. A missing key would silently
 * show Portuguese in the middle of another language.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const page = read('src/web/index.html');
const rpc = read('src/rpc.js');

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};
console.log('landing page languages\n');

const langs = new Function(page.match(/const LANGS = (\[[\s\S]*?\]);/)[0].replace('const LANGS = ', 'return '))();
const tagged = [...new Set([...page.matchAll(/data-t="([^"]+)"/g)].map((m) => m[1]))];
const scripted = ['liveOn', 'liveOff', 'liveFail', 'walletOk', 'walletCancel', 'credit', 'coauth', 'metaTitle', 'langName'];
const en = JSON.parse(read('src/web/i18n/en.json'));
const keys = Object.keys(en).sort();
const stars = (v) => (String(v).match(/\*/g) ?? []).length;

check('Portuguese is the page itself, listed first', langs[0][0] === 'pt');
check('the English source has every tagged and scripted key',
  [...tagged, ...scripted].every((k) => k in en), [...tagged, ...scripted].filter((k) => !(k in en)).join(', '));
check('  and nothing the page does not use', keys.every((k) => tagged.includes(k) || scripted.includes(k)),
  keys.filter((k) => !tagged.includes(k) && !scripted.includes(k)).join(', '));

const files = readdirSync(join(ROOT, 'src/web/i18n')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
check('every language in the picker but pt has a file, and no file is unlisted',
  JSON.stringify(langs.slice(1).map(([c]) => c).sort()) === JSON.stringify(files), files.join(' '));
check(`${langs.length} languages`, langs.length >= 16);

for (const [code, name] of langs.slice(1)) {
  let d;
  try { d = JSON.parse(read(`src/web/i18n/${code}.json`)); } catch (e) { check(`${code}.json parses`, false, e.message); continue; }
  const k = Object.keys(d).sort();
  const missing = keys.filter((x) => !(x in d)), extra = k.filter((x) => !(x in en));
  check(`${code}: exactly the English keys`, !missing.length && !extra.length, [...missing, ...extra].join(', '));
  const bad = keys.filter((x) => x in d && stars(d[x]) !== stars(en[x]));
  check(`${code}: emphasis markup balanced like the source`, !bad.length, bad.join(', '));
  const empty = keys.filter((x) => typeof d[x] !== 'string' || !d[x].trim());
  check(`${code}: no empty string`, !empty.length, empty.join(', '));
  check(`${code}: names itself as the picker does (${name})`, d.langName === name, d.langName);
  check(`${code}: brand names untouched`, d.cBmoli.includes('bMOLI') && /Molibra/.test(d.hWallet + d.pWallet + d.walletOk));
}

check('⛔ the page renders strings as elements, never innerHTML', !/innerHTML/.test(page));
check('the browser translator is never switched off', !/translate="no"/.test(page) && !/notranslate/.test(page));
check('right-to-left languages flip the page', page.includes("const RTL = new Set(['ar'])") && page.includes("html.dir = RTL.has(LANG)"));
check('rpc.js serves /molibra/i18n/<two letters>.json by a matched name, never a raw path',
  rpc.includes("path.startsWith('/molibra/i18n/')") && rpc.includes('/^\\/molibra\\/i18n\\/([a-z]{2})\\.json$/'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
