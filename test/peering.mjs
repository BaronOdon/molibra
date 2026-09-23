/**
 * Peering: a node follows the peers it learns, and announces only an address
 * that can be dialled.
 *
 * ⛔ Both of these ran wrong on the live network for weeks, and neither was
 * visible from inside a node.
 *
 *   1. The public miner was started without `--peers`, so `startSyncing`
 *      refused - correctly, there was nobody to follow - and NOTHING ever
 *      started it afterwards. It could be pushed to and could never pull. Every
 *      convergence with the second miner was the second node giving way; had
 *      the second node ever held the heavier chain, the first could not have
 *      followed it and the fork would have stood forever.
 *
 *   2. `announceTo` published `rpcUrl`, which is built from the BIND host. A
 *      public node binds 0.0.0.0, so it announced "reach me at 0.0.0.0:8545".
 *      A peer that accepted it would sync from an address that is not a host.
 *
 * The newcomer's path is the same path: download, point at the public miner,
 * announce, and be followed back without anyone restarting anything.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Node } from '../src/node.js';

const GENESIS = join(import.meta.dirname, '..', 'genesis.json');
const MINER = '0x3333333333333333333333333333333333333333';

let passed = 0;
let failed = 0;
const check = (name, ok, note = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  ${note}` : ''}`);
  ok ? passed++ : failed++;
};

const dir = mkdtempSync(join(tmpdir(), 'molibra-peering-'));
let miner;
let joiner;
try {
  console.log('a node follows a peer it learns after start-up\n');

  // The public miner's own configuration: no --peers at all.
  miner = new Node({ genesisPath: GENESIS, dataDir: join(dir, 'miner') });
  await miner.ready;
  await miner.start({ host: '127.0.0.1', port: 18583, advertise: 'http://10.0.0.7:18583' });
  await miner.chain.mine(MINER);

  check('it starts with no peers', miner.peers.size === 0);
  check('  so it has no sync timer', !miner.syncTimer);

  // The newcomer announces itself, exactly as startSyncing does each tick.
  const answer = await (await fetch('http://127.0.0.1:18583/molibra/announce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'http://10.0.0.9:8545' }),
  })).json();

  check('the announcement is accepted', answer.added === 'http://10.0.0.9:8545', JSON.stringify(answer));
  check('  and the miner now has a peer', miner.peers.size === 1);
  check('  ⭐ and it is now FOLLOWING, without a restart', Boolean(miner.syncTimer));
  check('  which the answer says out loud', answer.following === true);

  miner.stopSyncing();

  /* ------------------------------------------------- what may be announced */

  console.log('\nan address peers cannot dial is never announced');

  check('0.0.0.0 is not dialable', !Node.isDialable('http://0.0.0.0:8545'));
  check('localhost is not dialable', !Node.isDialable('http://127.0.0.1:8545'));
  check('a real host is', Node.isDialable('http://193.123.191.142:8545'));
  check('--advertise is what gets published', miner.rpcUrl === 'http://10.0.0.7:18583',
    miner.rpcUrl);

  // A node bound to a wildcard, with no --advertise, must stay quiet rather
  // than tell a peer to dial 0.0.0.0.
  joiner = new Node({ genesisPath: GENESIS, dataDir: join(dir, 'joiner') });
  await joiner.ready;
  joiner.rpcUrl = 'http://0.0.0.0:8545';
  let announced = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    if (String(url).includes('/molibra/announce')) announced = true;
    return realFetch(url, init);
  };
  await joiner.announceTo('http://127.0.0.1:18583').catch(() => {});
  globalThis.fetch = realFetch;

  check('a wildcard-bound node announces nothing', !announced);
  check('  and the miner did not gain a 0.0.0.0 peer',
    ![...miner.peers].some((p) => p.includes('0.0.0.0')), [...miner.peers].join(', '));
} finally {
  for (const n of [miner, joiner]) await n?.stop?.().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
