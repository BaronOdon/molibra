/**
 * /articles: every language the site speaks, every file exactly what the
 * catalogue and the manifest say it is.
 *
 * The manifest's SHA-256 is the DocumentRegistry record, so a PDF that drifts
 * from its manifest line silently stops being authenticated. This test makes
 * that drift a red build instead.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p));
const sha = (b) => createHash('sha256').update(b).digest('hex');

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};
console.log('articles\n');

const rpc = read('src/rpc.js').toString();
const page = read('src/web/articles.html').toString();
const landing = read('src/web/index.html').toString();

check('/articles is routed to articles.html', rpc.includes("path === '/articles'") && rpc.includes("'web', 'articles.html'"));
check('article files are matched against the catalogue, never joined from the URL',
  rpc.includes('a.languages.some((l) => l.file === m[2])') && rpc.includes('/^\\/articles\\/([a-z0-9-]+)\\/([a-z]{2}\\.pdf|MANIFEST\\.txt)$/'));
check('⛔ the page renders text as elements, never innerHTML', !/innerHTML/.test(page));
check('the page follows the serving origin', page.includes('location.origin'));
check('the page reads the registry status live, by record number', page.includes("numberOf: '0xfd8e1856'") && page.includes('0xeadcd3e918be3ad67a6b5c2a3c4fa8e59a809946'));

const siteLangs = ['pt', ...readdirSync(join(ROOT, 'src/web/i18n')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))].sort();
const pageLangs = [...page.matchAll(/\['([a-z]{2})','/g)].map((m) => m[1]).sort();
check('the page offers exactly the languages of the site', JSON.stringify(pageLangs) === JSON.stringify(siteLangs), pageLangs.join(' '));
const uiLangs = [...page.matchAll(/^\s{2}([a-z]{2}): \[/gm)].map((m) => m[1]).sort();
check('  and has its interface in each of them', JSON.stringify(uiLangs) === JSON.stringify(siteLangs), uiLangs.join(' '));

const idx = JSON.parse(read('articles/index.json'));
check('there is at least one article', idx.articles.length > 0);
for (const a of idx.articles) {
  const codes = a.languages.map((l) => l.code).sort();
  check(`${a.slug}: one PDF per site language`, JSON.stringify(codes) === JSON.stringify(siteLangs), codes.join(' '));
  check(`${a.slug}: the original language is listed`, codes.includes(a.original));
  const manifest = read(`articles/${a.slug}/MANIFEST.txt`);
  check(`${a.slug}: index.json carries the manifest's real hash`, sha(manifest) === a.manifest.sha256);
  const lines = manifest.toString().split('\n').filter((l) => /^[0-9a-f]{64}  /.test(l));
  check(`${a.slug}: the manifest lists every PDF once`, lines.length === a.languages.length);
  for (const l of a.languages) {
    const f = `articles/${a.slug}/${l.file}`;
    const ok = existsSync(join(ROOT, f));
    check(`  ${l.code}: ${l.file} exists`, ok);
    if (!ok) continue;
    const h = sha(read(f));
    check(`  ${l.code}: hash matches index.json and the manifest`, h === l.sha256 && lines.includes(`${h}  ${l.file}`));
    check(`  ${l.code}: it is a PDF`, read(f).subarray(0, 5).toString() === '%PDF-');
    check(`  ${l.code}: has a title`, typeof l.title === 'string' && l.title.length > 10);
  }
  check(`${a.slug}: ⛔ the on-chain label names no person`, !/Renan|Osvaldo|Saulo/i.test(a.label));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
