/**
 * Node hardening after the node 1 outage (accept-queue overflow under ~11.5k
 * POSTs from 627 proxy IPs). One check per fix:
 *
 *   - eth_feeHistory blockCount capped at 1024, and priced
 *   - route cost computed from the NORMALISED path (/molibra/./blocks bypass)
 *   - limiter keyed on X-Forwarded-For only when the socket is loopback (Caddy)
 *   - server timeouts and a connection cap are set
 *   - POST bodies over the cap are refused (declared and streamed)
 *   - a sync tick that adds nothing does not rewrite the chain file
 *   - /molibra/announce refuses private, loopback, link-local, metadata and
 *     non-http(s) URLs (SSRF)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { Node } from '../src/node.js';
import { createRpcHandlers, MAX_FEE_HISTORY_BLOCKS } from '../src/rpc.js';
import { RateLimiter, clientKey, costOfPath, costOfMethod } from '../src/ratelimit.js';
import { MAX_REQUEST_BYTES } from '../src/limits.js';
import { isBlockedAddress, checkPeerUrl } from '../src/netguard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENESIS = join(ROOT, 'genesis.json');
const MINER = '0x3333333333333333333333333333333333333333';
const PORT_A = 18591; const PORT_B = 18592;

let passed = 0; let failed = 0;
const check = (name, ok, note = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}${note ? '  ' + note : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${note ? '  ' + note : ''}`); }
};
const throws = async (fn) => { try { await fn(); return false; } catch { return true; } };

const dir = mkdtempSync(join(tmpdir(), 'hardening-'));
let a; let b;
try {
  a = new Node({ genesisPath: GENESIS, dataDir: join(dir, 'a') });
  await a.ready;
  for (let i = 0; i < 3; i++) await a.chain.mine(MINER);

  // --- eth_feeHistory ------------------------------------------------------
  console.log('eth_feeHistory\n');
  const h = createRpcHandlers(a);
  const big = h.eth_feeHistory(['0xffffffff']);
  check('blockCount is capped at 1024', big.gasUsedRatio.length === MAX_FEE_HISTORY_BLOCKS
    && big.baseFeePerGas.length === MAX_FEE_HISTORY_BLOCKS + 1);
  check('a small blockCount is honoured', h.eth_feeHistory(['0x4']).reward.length === 4);
  check('blockCount 0 is refused', await throws(() => h.eth_feeHistory(['0x0'])));
  check('a non-quantity is refused', await throws(() => h.eth_feeHistory(['zz'])));
  check('and it costs more than a balance read', costOfMethod('eth_feeHistory') > 1);

  // --- route cost from the normalised path ---------------------------------
  console.log('\nroute cost\n');
  check('/molibra/./blocks costs what /molibra/blocks costs',
    costOfPath('/molibra/./blocks?from=0') === 20);
  check('/molibra/x/../blocks too', costOfPath('/molibra/x/../blocks') === 20);
  check('%2e dot segments too', costOfPath('/molibra/%2e/blocks') === 20);
  check('case does not dodge it', costOfPath('/MOLIBRA/Blocks') === 20);
  check('an unlisted route still costs 1', costOfPath('/molibra/stats') === 1);

  // --- client key ----------------------------------------------------------
  console.log('\nclient key\n');
  const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  check('from Caddy (loopback) the rightmost XFF entry is the key',
    clientKey(req('127.0.0.1', '6.6.6.6, 1.2.3.4')) === '1.2.3.4');
  check('  also for ::1 and ::ffff:127.0.0.1',
    clientKey(req('::1', '1.2.3.4')) === '1.2.3.4' && clientKey(req('::ffff:127.0.0.1', '1.2.3.4')) === '1.2.3.4');
  check('  a junk XFF falls back to the socket', clientKey(req('127.0.0.1', 'evil')) === '127.0.0.1');
  check('  no XFF falls back to the socket', clientKey(req('127.0.0.1')) === '127.0.0.1');
  check('from anywhere else XFF is ignored', clientKey(req('5.5.5.5', '1.2.3.4')) === '5.5.5.5');

  // --- live server ---------------------------------------------------------
  a.rateLimiter = new RateLimiter({ capacity: 25, refillPerSecond: 0.01 });
  await a.start({ host: '127.0.0.1', port: PORT_A });
  const base = `http://127.0.0.1:${PORT_A}`;

  console.log('\nserver limits\n');
  const s = a.server;
  check('requestTimeout is set', s.requestTimeout > 0 && s.requestTimeout <= 60_000, String(s.requestTimeout));
  check('headersTimeout is set', s.headersTimeout > 0 && s.headersTimeout <= 60_000, String(s.headersTimeout));
  check('keepAliveTimeout is set', s.keepAliveTimeout > 0 && s.keepAliveTimeout < s.headersTimeout, String(s.keepAliveTimeout));
  check('maxConnections is set', Number.isFinite(s.maxConnections) && s.maxConnections > 0, String(s.maxConnections));

  console.log('\nthe dot-segment bypass, end to end\n');
  const r1 = await fetch(`${base}/molibra/./blocks?from=0&to=0`);
  const r2 = await fetch(`${base}/molibra/./blocks?from=0&to=0`);
  check('the first expensive call is served', r1.status === 200, String(r1.status));
  check('the second is refused (20 + 20 > 25)', r2.status === 429, String(r2.status));
  a.rateLimiter.buckets.clear();
  a.rateLimiter.capacity = 10_000; a.rateLimiter.refillPerSecond = 10_000;

  console.log('\nPOST body limit\n');
  const declared = await new Promise((resolve, reject) => {
    const r = request(`${base}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': MAX_REQUEST_BYTES + 1 } },
      (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', (e) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve('reset') : reject(e)));
    r.write('{');
    // never send the rest: the answer must not wait for it
  });
  check('a declared oversize body is refused before it is read', declared === 413, String(declared));
  const streamed = await fetch(`${base}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: '[' + '1,'.repeat(MAX_REQUEST_BYTES) + '1]',
  }).then((r) => r.status).catch(() => 'reset');
  check('a streamed oversize body is refused', streamed === 413 || streamed === 'reset', String(streamed));

  console.log('\n/molibra/announce SSRF\n');
  const announce = async (url) => {
    const r = await fetch(`${base}/molibra/announce`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    });
    return { status: r.status, body: await r.json() };
  };
  for (const bad of [
    'http://127.0.0.1:8545', 'http://localhost:8545', 'http://10.0.0.9:8545', 'http://192.168.1.2:80',
    'http://172.16.5.5:80', 'http://169.254.169.254', 'http://metadata.google.internal',
    'http://[::1]:8545', 'http://[fe80::1]:80', 'http://[::ffff:127.0.0.1]:80', 'http://2130706433:80',
    'http://100.64.0.1:80', 'http://0.0.0.0:8545', 'file:///etc/passwd', 'gopher://8.8.8.8:70',
    'ftp://8.8.8.8', 'http://u:p@8.8.8.8:80',
  ]) {
    const r = await announce(bad);
    check(`refused: ${bad}`, r.status === 400, `${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
  }
  check('nothing refused became a peer', a.peers.size === 0, String(a.peers.size));
  // A public address passes the guard; the dial-back (a separate check, see
  // test/peering.mjs) is stubbed here so this tests the guard alone.
  a.probePeer = async () => true;
  const ok = await announce('http://203.0.113.9:8545');
  check('a public http address is still accepted', ok.status === 200 && ok.body.added === 'http://203.0.113.9:8545',
    JSON.stringify(ok.body));
  a.stopSyncing();
  check('isBlockedAddress: a public v6 address is allowed', !isBlockedAddress('2606:4700::1111'));
  check('a name resolving to a private address is refused', await throws(
    () => checkPeerUrl('http://peer.example:8545', { resolve: async () => [{ address: '10.1.1.1', family: 4 }] })));
  check('a name resolving publicly is allowed', (await checkPeerUrl('http://peer.example:8545',
    { resolve: async () => [{ address: '8.8.8.8', family: 4 }] })) === 'http://peer.example:8545');

  // --- persist only when something was added -------------------------------
  console.log('\nsync persist\n');
  b = new Node({ genesisPath: GENESIS, dataDir: join(dir, 'b') });
  await b.ready;
  let writes = 0;
  const real = b.chain.persist.bind(b.chain);
  b.chain.persist = (...args) => { writes++; return real(...args); };
  const first = await b.syncFrom(base, { window: 64 });
  check('a sync that adds blocks writes them', first === 3 && writes >= 1, `adopted ${first}, ${writes} write(s)`);
  const before = writes;
  const second = await b.syncFrom(base, { window: 64 });
  check('a sync that adds nothing does NOT rewrite the chain file',
    second === 0 && writes === before, `adopted ${second}, ${writes - before} extra write(s)`);
} finally {
  await a?.stop?.();
  await b?.stop?.();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
