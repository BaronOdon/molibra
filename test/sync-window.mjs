/**
 * The sync's walk-back window: shallow by default, deep when it must be.
 *
 * ⛔ Why this test exists. `syncFrom` used to start every walk at block 0, so a
 * node re-fetched its whole chain every ten seconds to learn twenty blocks. It
 * was correct - blocks already held are skipped by hash - and that is exactly
 * why nothing caught it: the cost was invisible in every assertion. At height
 * 105,000 one pass took about six minutes on the live nodes, so the two miners
 * sat 20-35 blocks apart in steady state, and the cost grows with the chain
 * forever.
 *
 * The window that fixes it can be wrong in exactly one way: if it does not
 * reach back to the common ancestor, every page holds blocks whose parents are
 * missing and the node adopts nothing while staying behind. So both halves are
 * asserted here - that the ordinary sync asks from a recent height, and that a
 * node whose divergence is older than the window still catches up.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Node } from '../src/node.js';

const GENESIS = join(import.meta.dirname, '..', 'genesis.json');
const MINER_A = '0x1111111111111111111111111111111111111111';
const MINER_B = '0x2222222222222222222222222222222222222222';

let passed = 0;
let failed = 0;
const check = (name, ok, note = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  ${note}` : ''}`);
  ok ? passed++ : failed++;
};

/** Record the `from=` of every blocks page a sync requests. */
function spyOnFetch() {
  const real = globalThis.fetch;
  const froms = [];
  globalThis.fetch = (url, init) => {
    const m = String(url).match(/\/molibra\/blocks\?from=(\d+)/);
    if (m) froms.push(Number(m[1]));
    return real(url, init);
  };
  return { froms, restore: () => { globalThis.fetch = real; } };
}

const dir = mkdtempSync(join(tmpdir(), 'molibra-sync-window-'));
let source;
let joiner;
let alone;
try {
  console.log('the sync asks from a recent height, not from genesis\n');

  // Deep enough that a window of MAX_REORG_DEPTH + 64 cannot reach genesis.
  // ⛔ A small window, injected, and a chain to match. Mining a real
  // MAX_REORG_DEPTH of history back to back ramps the difficulty until the test
  // takes minutes, and a slow test is a test nobody runs.
  const WINDOW = 16;
  const DEPTH = 40;

  source = new Node({ genesisPath: GENESIS, dataDir: join(dir, 'source') });
  await source.ready;
  await source.start({ host: '127.0.0.1', port: 18572 });
  const url = 'http://127.0.0.1:18572';
  for (let i = 0; i < DEPTH; i++) await source.chain.mine(MINER_A);

  joiner = new Node({ genesisPath: GENESIS, dataDir: join(dir, 'joiner') });
  await joiner.ready;

  // First catch-up: the joiner holds only genesis, so the window IS genesis and
  // the whole chain is fetched. Nothing is being optimised away here.
  const first = await joiner.syncFrom(url, { window: WINDOW });
  check('a joiner still catches up from nothing', first === DEPTH, `${first} of ${DEPTH}`);
  check('  and reaches the identical head', joiner.chain.head.hash === source.chain.head.hash);

  // Steady state: twenty new blocks on a chain hundreds long.
  for (let i = 0; i < 20; i++) await source.chain.mine(MINER_A);
  const spy = spyOnFetch();
  const second = await joiner.syncFrom(url, { window: WINDOW });
  spy.restore();

  check('the next sync adopts only what is new', second === 20, `${second} block(s)`);
  check('  and asks from a RECENT height, not 0',
    spy.froms.length > 0 && spy.froms[0] > 0, `from=${spy.froms[0]}`);
  check('  within the walk-back window of the tip',
    spy.froms[0] >= Number(joiner.chain.height) - WINDOW - 20,
    `from=${spy.froms[0]} height=${joiner.chain.height}`);
  check('  and the heads match again', joiner.chain.head.hash === source.chain.head.hash);

  /* ------------------------------------------------------------- the net */

  console.log('\na divergence older than the window still heals');

  // A node that has mined its own chain from genesis all along: its only common
  // ancestor with the source is genesis itself, far outside the window.
  alone = new Node({ genesisPath: GENESIS, dataDir: join(dir, 'alone') });
  await alone.ready;
  for (let i = 0; i < DEPTH; i++) await alone.chain.mine(MINER_B);
  check('it is on its own branch', alone.chain.head.hash !== source.chain.head.hash,
    `height ${alone.chain.height} vs source ${source.chain.height}`);

  const spy2 = spyOnFetch();
  const healed = await alone.syncFrom(url, { window: WINDOW });
  spy2.restore();

  check('it adopts the peer\'s chain anyway', healed > 0, `${healed} block(s)`);
  check('  because the shallow window fell back to genesis', spy2.froms.includes(0),
    `asked from ${spy2.froms.slice(0, 3).join(', ')}…`);
  check('  and it now holds the peer\'s head',
    alone.chain.blockByHash(source.chain.head.hash) !== undefined
    && alone.chain.blockByHash(source.chain.head.hash) !== null);
} finally {
  for (const n of [source, joiner, alone]) await n?.stop?.().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
