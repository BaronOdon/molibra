/**
 * A node holds the world state only where a reorg can still reach.
 *
 * Every block entry used to carry its own full clone of the state, so memory
 * grew with the length of the chain. At ~257k blocks node 2 passed the V8 heap
 * limit about 65 minutes into every replay, never finished loading, and the
 * network was halted from 3 to 8 Nov 2026. These checks pin the fix: states
 * deeper than the reorg bound are dropped, and nothing that needed them breaks.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chain } from '../src/chain.js';
import { serializeBlock } from '../src/block.js';

const GENESIS = join(dirname(fileURLToPath(import.meta.url)), '..', 'genesis.json');
const DEPTH = 4;
const make = (dir) => new Chain(Chain.loadGenesis(GENESIS), dir, { maxReorgDepth: DEPTH });

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('state pruning below the reorg bound\n');

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const HEIGHT = 40;
const root = mkdtempSync(join(tmpdir(), 'molibra-prune-'));
try {
  const chain = await make(join(root, 'a')).init();
  for (let i = 0; i < HEIGHT; i++) await chain.mine(A);
  const held = chain.canonical.filter((e) => e.state).length;
  const keepFrom = HEIGHT - DEPTH - 16;

  check('⛔⛔ deep blocks no longer hold a state', chain.canonical[1].state === null && chain.canonical[keepFrom - 1].state === null,
    `${held} of ${HEIGHT + 1} blocks hold one`);
  check('every block a reorg can reach still holds its state',
    chain.canonical.slice(keepFrom).every((e) => e.state !== null));
  check('the head state is intact', chain.state.balanceOf(A) > 0n);

  // A branch off a parent deeper than the bound is refused, not crashed on.
  const deepParent = chain.canonical[3];
  let refused = null;
  try { await chain.mine(B, { parent: deepParent }); } catch (e) { refused = e.message; }
  check('a block on a pruned parent is refused with a clear reason',
    refused !== null && /reorg bound/.test(refused), refused ?? 'accepted');
  check('and the head did not move', Number(chain.height) === HEIGHT);

  // A reorg inside the bound still works: a rival that shares all but the last
  // two blocks, then mines three, must win.
  const rival = await make(join(root, 'b')).init();
  for (let n = 1; n <= HEIGHT - 2; n++) await rival.appendSerialized(serializeBlock(chain.blockByNumber(n)));
  for (let i = 0; i < 3; i++) await rival.mine(B);
  for (let n = HEIGHT - 1; n <= Number(rival.height); n++) await chain.appendSerialized(serializeBlock(rival.blockByNumber(n)));
  check('a reorg within the bound is still adopted', chain.head.hash === rival.head.hash,
    chain.lastReorg ? `depth ${chain.lastReorg.depth}` : 'no reorg');
  check('and the rival miner was credited', chain.state.balanceOf(B) > 0n);

  // A restart replays from disk and ends in the same place, pruned.
  chain.persist();
  const reloaded = await make(join(root, 'a')).init();
  check('a reload reaches the same head', reloaded.head.hash === chain.head.hash);
  check('with the same balances', reloaded.state.balanceOf(A) === chain.state.balanceOf(A)
    && reloaded.state.balanceOf(B) === chain.state.balanceOf(B));
  check('and the replay pruned as it went', reloaded.canonical[1].state === null);
  check('mining continues after the reload', (await reloaded.mine(A)) !== null);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
