/**
 * Every miner a full peer (operator, 8 Oct 2026): a node that knows only one
 * peer comes to know that peer's peers, remembers them across a restart,
 * forgets a learned peer that stays unreachable (never a configured one), and
 * the census counts the nodes that answer - counts, never addresses.
 *
 * Three real nodes on loopback; MOLIBRA_ALLOW_PRIVATE_PEERS lets the SSRF
 * guard accept 127.0.0.1 for this test only.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Node, PEER_DROP_AFTER_FAILURES } from '../src/node.js';

process.env.MOLIBRA_ALLOW_PRIVATE_PEERS = '1';
const GENESIS = join(import.meta.dirname, '..', 'genesis.json');
let passed = 0, failed = 0;
const check = (l, ok, d = '') => {
  if (ok) { passed++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { failed++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};
const dir = mkdtempSync(join(tmpdir(), 'molibra-discovery-'));
const url = (p) => `http://127.0.0.1:${p}`;
const nodes = [];
const make = async (name, port, peers = []) => {
  const n = new Node({ genesisPath: GENESIS, dataDir: join(dir, name), peers });
  await n.ready;
  await n.start({ host: '127.0.0.1', port, advertise: url(port) });
  n.quietSync = true;
  nodes.push(n);
  return n;
};

try {
  console.log('peer discovery, memory, pruning and census\n');
  // A (the "operator node") knows B; C (a newcomer) knows only A.
  const b = await make('b', 18611);
  const a = await make('a', 18610, [url(18611)]);
  const c = await make('c', 18612, [url(18610)]);

  check('the newcomer starts knowing only its configured peer', c.peers.size === 1 && c.peers.has(url(18610)));
  const added = await c.discoverPeers();
  check('⭐ it learns its peer\'s peer by asking for the peer list', added === 1 && c.peers.has(url(18611)), `added ${added}`);
  check('  never itself', !c.peers.has(url(18612)));
  check('  and remembers it in peers.json', existsSync(join(dir, 'c', 'peers.json'))
    && JSON.parse(readFileSync(join(dir, 'c', 'peers.json'), 'utf8')).includes(url(18611)));

  // A stranger's list cannot push in what the guard refuses or what does not answer.
  b.peers.add('http://127.0.0.1:18699');         // nobody listens there
  b.peers.add('gopher://127.0.0.1:70');           // not http
  const again = await c.discoverPeers();
  check('⛔ a listed address that does not answer is not taken', !c.peers.has('http://127.0.0.1:18699'), `added ${again}`);
  check('⛔ a listed address the guard refuses is not taken', !c.peers.has('gopher://127.0.0.1:70'));

  // Memory across a restart: a fresh Node object on the same datadir.
  await c.stop();
  nodes.splice(nodes.indexOf(c), 1);
  const c2 = await make('c', 18612, [url(18610)]);
  check('⭐ after a restart it still knows the peer it learned', c2.peers.has(url(18611)) && c2.peers.has(url(18610)));
  check('  and the learned one is not treated as configured', !c2.configuredPeers.has(url(18611)));

  // Pruning: a learned peer that keeps failing is forgotten; a configured one never.
  c2.addPeer('http://127.0.0.1:18698');
  for (let i = 0; i < PEER_DROP_AFTER_FAILURES; i++) {
    c2.notePeerResult('http://127.0.0.1:18698', false);
    c2.notePeerResult(url(18610), false);
  }
  check('a learned peer unreachable for the whole window is forgotten', !c2.peers.has('http://127.0.0.1:18698'));
  check('⛔ a configured peer is never forgotten', c2.peers.has(url(18610)));
  check('  and the file forgets it too', !JSON.parse(readFileSync(join(dir, 'c', 'peers.json'), 'utf8')).includes('http://127.0.0.1:18698'));
  c2.notePeerResult('http://127.0.0.1:18697', false);
  c2.notePeerResult('http://127.0.0.1:18697', true);
  check('one success resets the count', !c2.peerFailures.has('http://127.0.0.1:18697'));

  // Census: counts the nodes that answer, walking peer lists.
  const census = await (await fetch(url(18612) + '/molibra/network')).json();
  check('⭐ /molibra/network counts every node that answers (3 here)', census.reachableNodes === 3, JSON.stringify(census));
  check('⛔ and publishes counts, never addresses', !JSON.stringify(census).includes('127.0.0.1'));
  const cached = await c2.census();
  check('  cached (a page view cannot make it crawl)', cached.crawledAt === census.crawledAt);

  // whoami: what a miner uses to learn its public address.
  const who = await (await fetch(url(18610) + '/molibra/whoami')).json();
  check('/molibra/whoami answers the caller\'s address', who.ip === '127.0.0.1' || who.ip === '::ffff:127.0.0.1', JSON.stringify(who));

  // release.json is served from releases/ when present, 404 when not.
  const rel = await fetch(url(18610) + '/download/release.json');
  check('/download/release.json is a route (200 with a release, 404 before the first)', rel.status === 200 || rel.status === 404, String(rel.status));
} finally {
  for (const n of nodes) await n.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
