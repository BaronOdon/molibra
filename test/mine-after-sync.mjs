/**
 * A node told to mine does not start until it has caught up with its peers.
 *
 * ⛔⛔ The failure this pins: `--mine` on a fresh datadir used to grind from
 * genesis while the first sync was still downloading, so a newcomer built a
 * private branch from block 0 that the real chain - forking at genesis, far
 * deeper than any reorg the chain accepts - could never replace. It is the
 * download page's own journey, and the installers' only journey.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Node } from '../src/node.js';

const GENESIS = join(import.meta.dirname, '..', 'genesis.json');
const A = '0x3333333333333333333333333333333333333333';

let passed = 0;
let failed = 0;
const check = (name, ok, note = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  ${note}` : ''}`);
  ok ? passed++ : failed++;
};
const within = (ms, promise) => Promise.race([
  promise.then((v) => ({ done: true, v })),
  new Promise((r) => setTimeout(() => r({ done: false }), ms)),
]);

const dir = mkdtempSync(join(tmpdir(), 'molibra-mine-after-sync-'));
const nodes = [];
try {
  console.log('a newcomer waits for the chain before mining\n');

  const peer = new Node({ genesisPath: GENESIS, dataDir: join(dir, 'peer') });
  nodes.push(peer);
  await peer.ready;
  await peer.start({ host: '127.0.0.1', port: 18591 });
  for (let i = 0; i < 25; i++) await peer.chain.mine(A);

  const fresh = new Node({ genesisPath: GENESIS, dataDir: join(dir, 'fresh'), peers: ['http://127.0.0.1:18591'] });
  nodes.push(fresh);
  await fresh.ready;
  check('the newcomer starts at genesis', Number(fresh.chain.height) === 0);

  // Before any sync has run, it is not caught up, so the wait must not end.
  const early = await within(400, fresh.waitUntilCaughtUp({ pollMs: 50 }));
  check('⛔⛔ with the chain still to download, it does NOT start mining', !early.done);

  fresh.startSyncing({ intervalMs: 100 });
  const verdict = await within(20_000, fresh.waitUntilCaughtUp({ pollMs: 50 }));
  fresh.stopSyncing();
  check('once synced, the wait ends', verdict.done && verdict.v.caughtUp === true,
    verdict.done ? `height ${verdict.v.height} of ${verdict.v.peerHeight}` : 'timed out');
  check('⭐ and it holds the REAL chain, not a branch of its own',
    fresh.chain.blockByNumber?.(20n)?.hash === peer.chain.blockByNumber?.(20n)?.hash
      || fresh.chain.head.hash === peer.chain.head.hash);

  console.log('\nan absent peer');

  const lonelyFresh = new Node({ genesisPath: GENESIS, dataDir: join(dir, 'lonely-fresh'), peers: ['http://127.0.0.1:18599'] });
  nodes.push(lonelyFresh);
  await lonelyFresh.ready;
  const f = await within(600, lonelyFresh.waitUntilCaughtUp({ pollMs: 20, lonelyAfterMs: 50 }));
  check('⛔ a FRESH node with nobody answering never mines alone', !f.done,
    'mining alone from genesis is the fork this exists to prevent');

  const established = new Node({ genesisPath: GENESIS, dataDir: join(dir, 'established'), peers: ['http://127.0.0.1:18599'] });
  nodes.push(established);
  await established.ready;
  for (let i = 0; i < 3; i++) await established.chain.mine(A);
  const e = await within(2_000, established.waitUntilCaughtUp({ pollMs: 20, lonelyAfterMs: 50, establishedHeight: 3 }));
  check('a node WITH history is not held hostage by an absent peer', e.done && e.v.caughtUp === false,
    'two miners restarting while the other is down must not both wait forever');
} finally {
  for (const n of nodes) await n.stop?.().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
