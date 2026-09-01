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
const LOCAL_ONLY = new Set(['chart.html', 'fund.html', 'mint-giz.html']);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
