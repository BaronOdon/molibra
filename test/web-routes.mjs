/**
 * Every page that ships must be reachable.
 *
 * A page added to `src/web/` with no route in `src/rpc.js` is a file nobody can
 * open: `npm test` passes, the commit looks complete, the node restarts, and
 * the page 404s forever. That is not hypothetical - `inbound.html` and
 * `pool.html` shipped in caa755f with no route and were dead on the live node
 * until curled by hand.
 *
 * rpc.js serves each page from an explicit branch; there is no static handler,
 * deliberately (an open static route rooted in the source tree is a file-read
 * primitive). So the invariant is exactly: for every `src/web/*.html`, rpc.js
 * names that file. This test reads the shipped directory rather than a list,
 * so a page added tomorrow is covered without editing the test.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rpc = readFileSync(join(ROOT, 'src/rpc.js'), 'utf8');

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('src/web pages vs the routes in src/rpc.js\n');

const pages = readdirSync(join(ROOT, 'src/web')).filter((f) => f.endsWith('.html')).sort();
check('there are pages to check', pages.length > 0, `${pages.length} found`);

/**
 * Pages deliberately NOT reachable from the node.
 *
 * ⛔ This list is a DECISION, not a waiver. Routing a page publishes it on the
 * public node, and these three touch funding and minting - exposure the
 * operator decides, not the person who happens to add a route. They are opened
 * from disk locally until that decision is made. Adding a route for one of
 * these means deleting its line here, deliberately.
 *
 * They were found unreachable by this test on 1 Sep 2026, having shipped
 * without routes some time earlier; they are recorded here rather than quietly
 * routed so the gap stays visible instead of turning into a silent 404.
 */
const LOCAL_ONLY = new Set(['fund.html', 'mint-giz.html']);
// chart.html was removed from this set on 3 Sep 2026, deliberately and for the
// stated reason. The rationale above is funding and minting: chart.html does
// neither. It signs nothing, holds no key, touches no wallet at all - it reads
// pairs and draws them. It was in this list by proximity to two pages that do
// touch funds, not by the rule the list exists to enforce. fund.html and
// mint-giz.html stay, because for them the rule applies exactly.

/**
 * The route table, read out of the source: every `'web', 'name.html'` join.
 * Matching the served filename rather than the URL keeps this honest about
 * what is actually read off disk.
 */
const served = new Set(
  [...rpc.matchAll(/'web',\s*'([A-Za-z0-9_.-]+\.html)'/g)].map((m) => m[1]),
);

for (const page of pages) {
  if (LOCAL_ONLY.has(page)) {
    // Held back on purpose. The check is that it is still held back: a route
    // appearing here without the decision being made is the thing to catch.
    check(`${page} is local-only and stays unrouted`, !served.has(page),
      served.has(page) ? 'it is now served - was that decided? update LOCAL_ONLY' : '');
    continue;
  }
  check(`${page} is served by a route`, served.has(page),
    served.has(page) ? '' : 'no branch in rpc.js reads this file - it would 404');
}

// And the converse: a route naming a file that no longer exists is a 500 in
// waiting, not a 404.
const onDisk = new Set(pages);
for (const name of [...served].sort()) {
  check(`the route for ${name} has a file`, onDisk.has(name),
    onDisk.has(name) ? '' : 'rpc.js reads a page that is not in src/web');
}
/* ------------------------ a page follows the node that served it */

// A page fetched over https://molibra.org cannot fetch http://<ip>:8545 - the
// browser blocks it as mixed content and every control on the page dies at
// once. So the moment this node answers to a name over TLS, any page holding a
// hardcoded host is broken, and it breaks quietly: the HTML loads fine and only
// the fetches fail. Each page must follow location.origin, keeping the literal
// only as the fallback for opening the file directly.

const webDir = join(ROOT, 'src/web');
for (const name of readdirSync(webDir).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(join(webDir, name), 'utf8');
  if (!/193\.123\.191\.142/.test(html)) continue;   // nothing to say about it
  check(`${name} follows the serving origin`,
    html.includes('location.origin'),
    'a hardcoded host survives only until the node has a name');
  const uses = [...html.matchAll(/193\.123\.191\.142/g)].length;
  const fallbacks = [...html.matchAll(/:\s*'http:\/\/193\.123\.191\.142:8545'/g)].length;
  check(`  and every mention of the IP is that fallback, not a live value`,
    uses === fallbacks, `${uses} mention(s), ${fallbacks} as a fallback`);
}

/* ----------------------- the front page may not link into nothing */

// The site is the one page a stranger sees first, and a dead link there is
// worse than a missing feature: it says the project does not check itself.
// Every internal href in index.html must correspond to a route rpc.js serves.

const index = readFileSync(join(ROOT, 'src/web/index.html'), 'utf8');
const routes = new Set([...rpc.matchAll(/path === '(\/[^']*)'/g)].map((m) => m[1]));
const hrefs = [...new Set([...index.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]))];

check('the front page links somewhere at all', hrefs.length > 5, `${hrefs.length} internal links`);
for (const h of hrefs) {
  check(`  ${h} is a route rpc.js serves`, routes.has(h),
    routes.has(h) ? '' : 'the front page links into nothing');
}
check('and the site itself is routed at the root', routes.has('/'),
  "a front page nobody can open is a file, not a site");
check('while /molibra stays the identity JSON', rpc.includes("path === '/molibra'"),
  'moving the API to take the root would break every page and syncFrom');
check('the white paper is served from the repo file, not a copy',
  rpc.includes("'..', 'WHITEPAPER.md'"),
  'a second copy of the paper is a copy that drifts');


/* --------------------- a script a page loads must be a route too */

// The same trap as an unrouted page, one level down and quieter: the HTML
// loads, the browser asks for /molibra/<name>.js, gets a 404, and every
// handler that needed it dies with "molibraWallet is undefined" - on the live
// node only, because opening the file from disk resolves nothing either way
// and looks identical. So every script a page pulls from this origin must be
// named by a branch in rpc.js.

const scriptSrcs = new Set();
for (const name of pages) {
  const html = readFileSync(join(webDir, name), 'utf8');
  for (const m of html.matchAll(/<script[^>]+src="(\/[^"]+)"/g)) scriptSrcs.add(m[1]);
  for (const m of html.matchAll(/from\s+'(\/molibra\/[^']+)'/g)) scriptSrcs.add(m[1]);
}
check('the pages load scripts from this origin at all', scriptSrcs.size > 0,
  `${scriptSrcs.size} distinct`);
for (const src of [...scriptSrcs].sort()) {
  check(`the script ${src} is a route rpc.js serves`, routes.has(src),
    routes.has(src) ? '' : 'the page would load it and get a 404');
}

/* ------------------- a page that touches a wallet must carry the guard */

// On a phone, `window.ethereum` being absent is NORMAL: MetaMask is a separate
// app with its own browser. A page that answers "no wallet detected" tells a
// user who HAS the wallet that the site is broken - and it does that to every
// mobile visitor while working on every desktop, which is exactly why it
// survived on nine pages at once until 5 Sep 2026. mobilewallet.js is the one
// answer; a page that reaches for a provider must load it.

const GUARD = '/molibra/mobilewallet.js';
for (const name of pages) {
  if (LOCAL_ONLY.has(name)) continue;          // never reached from a phone
  const html = readFileSync(join(webDir, name), 'utf8');
  // Either spelling counts: a page still reaching for the raw provider, and a
  // page already on the guard that could quietly lose the <script> that
  // defines it. The second failure is the silent one.
  if (!html.includes('window.ethereum') && !html.includes('molibraWallet')) continue;
  check(`${name} loads the mobile wallet guard`, html.includes(GUARD),
    html.includes(GUARD) ? '' : 'it will dead-end on every phone');
}


/* ------------------------ no route may shadow another */

// ⛔ rpc.js is a chain of `if (path === '...')` branches and the FIRST match
// wins. Two branches claiming one string is not a conflict the language will
// mention: the second is simply dead, and dead in the worst way - the path
// still answers 200, so every "is it routed?" check above passes while the
// page behind it is unreachable.
//
// That is not hypothetical. bridge.html shipped at /molibra/bridge on 30 Aug
// 2026 (1578de1); on 31 Aug (a52817e) the inbound-registrar JSON took the same
// path 200 lines earlier. From that commit the front page's "Bridge out" card
// served a wall of JSON to anyone who clicked it, on the live site, for five
// days, with a green suite the whole time.

// Only branches at the SAME depth in the same chain can shadow each other.
// A deeper `if (path === ...)` is a discriminator INSIDE an outer branch that
// already matched - `/molibra/tokens` inside the `startsWith('/molibra/token/')`
// block, `/molibra/earn` inside the POST section - and those are correct. A
// gate that flags them is a gate someone turns off, so match the indentation
// exactly: two spaces is the top-level chain.
const claimed = [...rpc.matchAll(/^  if \(path === '(\/[^']*)'/gm)].map((m) => m[1]);
const seen = new Map();
const shadowed = [];
for (const path of claimed) {
  if (seen.has(path)) shadowed.push(path);
  else seen.set(path, true);
}
check('no path is claimed by two branches', shadowed.length === 0,
  shadowed.length ? `shadowed: ${[...new Set(shadowed)].join(' ')} - the later branch is dead`
                  : `${seen.size} distinct paths, each claimed once`);


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
