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

/* -------- any device (8 Oct 2026; proved by a 16-device x 16-language CDP matrix) */
console.log('\nany device\n');
check('viewport meta: device width, safe areas (viewport-fit=cover)', page.includes('content="width=device-width,initial-scale=1,viewport-fit=cover"'));
check('  and the safe areas are actually padded (notch, home bar)', page.includes('env(safe-area-inset-left)') && page.includes('env(safe-area-inset-top)') && page.includes('env(safe-area-inset-bottom)'));
check('card grid never wider than the screen (minmax(min(290px,100%),1fr))', page.includes('minmax(min(290px,100%),1fr)'));
check('long words wrap instead of pushing the page sideways', page.includes('overflow-wrap:anywhere'));
check('⛔ sections hide for the fade-in only when the script runs (.js gate)', page.includes(".js .reveal{opacity:0") && !/\n\s*\.reveal\{opacity:0/.test(page)
  && page.includes("document.documentElement.classList.add('js')"));
check('touch: no sticky hover lift, 44 px targets, 16 px picker (no iOS zoom)',
  page.includes('@media (hover:none)') && page.includes('@media (pointer:coarse)') && page.includes('.lang select{font-size:16px;min-height:44px}'));
check('phones/tablets get the section links as a swipeable row, not hidden', /@media \(max-width:820px\)\{[\s\S]*?\.nav\{order:3/.test(page) && !/\.nav\{display:none\}/.test(page));
check('short landscape screens keep the header to one row', page.includes('@media (max-height:500px) and (orientation:landscape)'));
check('folded phones (≤300 px) and 4K screens have their own rules', page.includes('@media (max-width:300px)') && page.includes('@media (min-width:3200px)'));
check('⛔ no syntax older Safari cannot parse (??=, replaceChildren)', !page.includes('??=') && !page.includes('replaceChildren'));
check('text size not inflated by mobile browsers', page.includes('text-size-adjust:100%'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
