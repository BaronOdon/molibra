/**
 * A sync writes per batch, not per block.
 *
 * `persist()` rewrites the ENTIRE chain file. Doing that once per block makes a
 * sync quadratic in its own length: recovering the public node's 13,319 blocks
 * on 1 Sep 2026 wrote roughly 47.7 GB to disk in order to store 7 MB.
 *
 * This is the same defect `test/persist-load.mjs` pins from the reading side.
 * There the answer was absolute - a load writes nothing. Here it cannot be,
 * because a sync is ACQUIRING data and losing it all on a stall would be worse
 * than the writes. So the invariant is a cadence rather than a prohibition: one
 * write per batch, on the same boundary the loop already yields at, so the
 * pause that keeps the node answering is also the point its progress becomes
 * durable.
 */

import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node } from '../src/node.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENESIS = join(ROOT, 'genesis.json');
const MINER = '0x9999999999999999999999999999999999999999';
const BLOCKS = 40;          // > 1 batch, so the cadence is observable, without a slow suite
const BATCH = 32;           // must match SYNC_BATCH in src/node.js

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('a sync writes per batch, not per block\n');

const dir = mkdtempSync(join(tmpdir(), 'molibra-sync-'));
let source, joiner, reloaded;   // only `source` is ever started
try {
  source = new Node({ genesisPath: GENESIS, dataDir: join(dir, 'a') });
  await source.ready;
  await source.start({ host: '127.0.0.1', port: 18561 });
  const url = 'http://127.0.0.1:18561';

  const started = Date.now();
  for (let i = 0; i < BLOCKS; i++) await source.chain.mine(MINER);
  check(`the source mined ${BLOCKS} blocks`, Number(source.chain.head.header.number) === BLOCKS,
    `${((Date.now() - started) / 1000).toFixed(1)}s`);

  joiner = new Node({ genesisPath: GENESIS, dataDir: join(dir, 'b') });
  await joiner.ready;

  let writes = 0;
  const realPersist = joiner.chain.persist.bind(joiner.chain);
  joiner.chain.persist = () => { writes++; return realPersist(); };

  const adopted = await joiner.syncFrom(url);

  /* ------------------------------------------------- the sync still works */

  check('every block was adopted', adopted === BLOCKS, `${adopted} of ${BLOCKS}`);
  check('the joiner reached the identical head', joiner.chain.head.hash === source.chain.head.hash);
  check('and re-derived the same state independently',
    joiner.chain.state.root() === source.chain.state.root());

  /* --------------------------------------------------- ⛔⛔ the cadence */

  const ceiling = Math.ceil(BLOCKS / BATCH) + 2; // batches, plus the tail write per page
  check('⛔⛔ the sync wrote per BATCH, not per block', writes <= ceiling,
    `${writes} write(s) for ${BLOCKS} blocks (ceiling ${ceiling}) - per-block would be ${BLOCKS}`);
  check('but it did write, so progress is durable before the sync ends', writes >= 1,
    'a sync that only wrote at the very end would lose everything on a stall');

  const amplification = BLOCKS / writes;
  console.log(`\n  ${writes} writes for ${BLOCKS} blocks - ${amplification.toFixed(1)}x fewer than per-block\n`);

  /* ------------------------- what was acquired survives a restart, unaided */

  reloaded = new Node({ genesisPath: GENESIS, dataDir: join(dir, 'b') });
  await reloaded.ready;
  check('everything the sync acquired survived a restart',
    Number(reloaded.chain.head.header.number) === BLOCKS,
    `height ${Number(reloaded.chain.head.header.number)} of ${BLOCKS}`);
  check('and the reloaded head is the source head', reloaded.chain.head.hash === source.chain.head.hash);
} finally {
  // Only `source` ever bound a socket, and only it is stopped. Stopping a node
  // that never started closes handles that were never opened, which trips a
  // libuv assertion on Windows rather than being a harmless no-op.
  // ⛔ Close the fetch client BEFORE the server it is pointed at. syncFrom
  // reached the peer over fetch, and undici keeps that socket pooled with no
  // public handle; tearing the server down first leaves the pool holding a
  // dead socket and Windows aborts the process on the double close - after
  // every check has already passed, so the run reports a failure it did not
  // have.
  try { await globalThis[Symbol.for('undici.globalDispatcher.1')]?.close?.(); } catch { /* none */ }
  try { await source?.stop?.(); } catch { /* already down */ }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
