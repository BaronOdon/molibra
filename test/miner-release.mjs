/**
 * Supervisor v4 (8 Oct 2026): installed miners run only SIGNED releases.
 *
 * Unit: signatures (threshold, wrong key, tampering), the tree digest (git
 * objects = an archive of the same commit), rollout buckets, the flag-day
 * guard, the UPnP description parser.
 *
 * End to end: the REAL supervisor file, copied into a temp folder with its
 * ports, release keys, download base and delays turned down (constants
 * rewritten in the copy - the shipped file has no test hooks), against a local
 * server playing peer + source host:
 *   1. a signed release installs;
 *   2. a release whose source does not match its signed digest is refused;
 *   3. a release signed by a key not built in is refused;
 *   4. a signed release whose node crash-loops is rolled back and skipped.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  canonicalJson, releaseMessage, verifyRelease, tarFiles, treeDigest, rolloutBucket, rolloutAllows,
  mustStopMining, upnpService,
} from '../installers/launcher/molibra-miner.mjs';
import { commitFiles } from '../installers/release-tool.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const check = (l, ok, d = '') => {
  if (ok) { passed++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { failed++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};
const keyPair = () => { const k = generateKeyPairSync('ed25519'); return { priv: k.privateKey, x: k.publicKey.export({ format: 'jwk' }).x }; };
const signDoc = (manifest, ...signers) => ({ manifest, signatures: signers.map(([id, k]) => ({ signer: id, sig: sign(null, releaseMessage(manifest), k.priv).toString('base64') })) });
const throwsMsg = (f) => { try { f(); return null; } catch (e) { return e.message; } };

console.log('signatures\n');
const A = keyPair(), B = keyPair(), X = keyPair();
const base = { product: 'molibra-miner', version: '1.1.0', seq: 1, commit: 'c'.repeat(40), tree: 'sha256:' + 'd'.repeat(64), publishedAt: '2026-10-08T00:00:00Z', rollout: { hours: 48 }, mandatory: null };
check('canonical JSON ignores key order', canonicalJson({ b: 1, a: { d: 2, c: 3 } }) === canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
check('a release signed by a listed key verifies', verifyRelease(signDoc(base, ['a', A]), { a: A.x }, 1).version === '1.1.0');
check('⛔ a key not listed does not count', /0 valid/.test(throwsMsg(() => verifyRelease(signDoc(base, ['a', X]), { a: A.x }, 1))));
check('⛔ tampering with any field after signing breaks it',
  /0 valid/.test(throwsMsg(() => { const d = signDoc(base, ['a', A]); d.manifest = { ...d.manifest, commit: 'e'.repeat(40) }; return verifyRelease(d, { a: A.x }, 1); })));
check('threshold 2: one signature is not enough', /1 valid signature\(s\), needs 2/.test(throwsMsg(() => verifyRelease(signDoc(base, ['a', A]), { a: A.x, b: B.x }, 2))));
check('  the same key twice is still one', /needs 2/.test(throwsMsg(() => verifyRelease(signDoc(base, ['a', A], ['a', A]), { a: A.x, b: B.x }, 2))));
check('  two different keys pass', verifyRelease(signDoc(base, ['a', A], ['b', B]), { a: A.x, b: B.x }, 2).seq === 1);
check('⛔ a release without commit, tree or sequence is refused',
  ['commit', 'tree', 'seq'].every((f) => throwsMsg(() => verifyRelease(signDoc({ ...base, [f]: undefined }, ['a', A]), { a: A.x }, 1))));

console.log('\nthe tree digest\n');
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
const archive = spawnSync('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', '--prefix=molibra-x/', head], { cwd: REPO, maxBuffer: 512 * 2 ** 20 }).stdout;
const fromArchive = treeDigest([...tarFiles(archive)].filter((e) => !e.dir));
const fromObjects = treeDigest(commitFiles(head));
check('git objects and an archive of the same commit give the same digest (GitHub matched too, 8 Oct)', fromArchive === fromObjects, fromObjects.slice(0, 22));
check('one changed byte changes it', treeDigest([{ path: 'a', body: Buffer.from('x') }]) !== treeDigest([{ path: 'a', body: Buffer.from('y') }]));
check('file order does not', treeDigest([{ path: 'a', body: Buffer.from('1') }, { path: 'b', body: Buffer.from('2') }])
  === treeDigest([{ path: 'b', body: Buffer.from('2') }, { path: 'a', body: Buffer.from('1') }]));
check('⛔ an archive path climbing out of the folder is refused', /refusing/.test(throwsMsg(() => [...tarFiles(tar({ '../evil': 'x' }, 'top'))])));

console.log('\nrollout and the flag-day guard\n');
const t0 = Date.parse(base.publishedAt);
check('an install keeps its bucket', rolloutBucket('abc') === rolloutBucket('abc') && rolloutBucket('abc') < 100);
const buckets = Array.from({ length: 1000 }, (_, i) => rolloutBucket('id' + i));
const share = (h) => buckets.filter((b) => rolloutAllows(base, { bucket: b, now: t0 + h * 3600_000 })).length / 10;
check('at publication nobody, half way ~half, at the end everyone', share(0) === 0 && share(24) > 40 && share(24) < 60 && share(48) === 100, `${share(0)}% / ${share(24)}% / ${share(48)}%`);
const mand = { ...base, seq: 2, mandatory: { beforeHeight: 200_000 } };
check('a mandatory release opens to everyone 2,000 blocks before its height', rolloutAllows(mand, { bucket: 99, now: t0, networkHeight: 198_000 })
  && !rolloutAllows(mand, { bucket: 99, now: t0, networkHeight: 197_999 }));
check('⛔ past that height, an install still on the old release stops mining', mustStopMining(mand, 1, 200_000) && !mustStopMining(mand, 1, 199_999));
check('  and one on the release keeps mining', !mustStopMining(mand, 2, 250_000));

console.log('\nUPnP\n');
const desc = `<?xml version="1.0"?><root><URLBase>http://192.168.1.1:5000/</URLBase><device><serviceList>
  <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service>
  <service><serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType><controlURL>/ctl/PPP</controlURL></service>
</serviceList></device></root>`;
const svc = await upnpService('http://192.168.1.1:5000/desc.xml', async () => desc);
check('the WAN connection service and its control URL are found', svc.controlUrl === 'http://192.168.1.1:5000/ctl/PPP' && /WANPPPConnection/.test(svc.serviceType));
check('⛔ a router with no WAN service is an error, not a guess', Boolean(await upnpService('http://r/x', async () => '<root></root>').catch((e) => e.message)));

/* ------------------------------------------------------------ end to end */
console.log('\nend to end: the real supervisor\n');

/** A minimal ustar archive, every file under `top/`. */
function tar(files, top) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(`${top}/${name}`, 0, 100);
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136); h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const dir = mkdtempSync(join(tmpdir(), 'molibra-sup-'));
const K = keyPair(), STRANGER = keyPair();
const STATUS = 20337, NODEPORT = 20336;
const shipped = readFileSync(join(REPO, 'installers', 'launcher', 'molibra-miner.mjs'), 'utf8');
const patch = (src, from, to) => { if (!src.includes(from)) throw new Error('cannot patch: ' + from); return src.replace(from, to); };
let sup = shipped;
let releases = {};           // seq -> { doc, tarball }
let current = null;          // the doc the server serves
const server = createServer((req, res) => {
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  if (req.url === '/download/release.json') return current ? send(200, JSON.stringify(current)) : send(404, '{}');
  if (req.url === '/molibra/head') return send(200, JSON.stringify({ header: { number: 5 } }));
  if (req.url === '/molibra/peers') return send(200, JSON.stringify({ peers: [] }));
  const m = /^\/tar\/([0-9a-f]{40})$/.exec(req.url);
  const rel = m && Object.values(releases).find((r) => r.doc.manifest.commit === m[1]);
  if (rel) return send(200, rel.tarball, 'application/gzip');
  send(404, '{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SRV = `http://127.0.0.1:${server.address().port}`;
sup = patch(sup, "'molibra-release-2026-10': 'UMXRp0rUZEbdvtSvonbsMEIVFIPues9c98sTbiGirVk',", `'test-key': '${K.x}',`);
sup = patch(sup, "const STATUS_PORT = 20227;", `const STATUS_PORT = ${STATUS};`);
sup = patch(sup, "const PORT = 20226;", `const PORT = ${NODEPORT};`);
sup = patch(sup, "const CODELOAD = 'https://codeload.github.com/BaronOdon/molibra/tar.gz';", `const CODELOAD = '${SRV}/tar';`);
sup = patch(sup, "const RESTART_DELAY_MS = 30_000;", 'const RESTART_DELAY_MS = 300;');
sup = patch(sup, "const HEALTH_POLL_MS = 30_000;", 'const HEALTH_POLL_MS = 300;');
sup = patch(sup, "const RUN_NPM = true;", 'const RUN_NPM = false;');
sup = sup.replace(/const RELEASE_URLS = \[[\s\S]*?\];/, 'const RELEASE_URLS = [];');
writeFileSync(join(dir, 'molibra-miner.mjs'), sup);
writeFileSync(join(dir, 'config.json'), JSON.stringify({ miner: '0x' + '11'.repeat(20), peers: SRV, port: NODEPORT, public: false, installId: 'test' }));

const GOOD_CLI = "console.log('  caught up at 5 - mining starts now'); setTimeout(() => process.exit(0), 120000);";
const CRASH_CLI = "console.error('Error: this release is broken'); process.exit(1);";
let commitN = 0;
function publish(seq, cli, { signer = ['test-key', K], wrongTree = false, version = `1.${seq}.0` } = {}) {
  const files = { 'src/cli.js': cli, 'package.json': '{"name":"x"}', 'installers/launcher/molibra-miner.mjs': sup };
  const commit = String(++commitN).padStart(40, 'a');
  const tarball = gzipSync(tar(files, 'molibra-' + commit.slice(0, 7)));
  const tree = wrongTree ? 'sha256:' + '0'.repeat(64) : treeDigest(Object.entries(files).map(([path, c]) => ({ path, body: Buffer.from(c) })));
  const manifest = { product: 'molibra-miner', version, seq, commit, tree, publishedAt: new Date().toISOString(), rollout: { hours: 0 }, mandatory: null, minLauncher: 4, notes: '' };
  const doc = signDoc(manifest, signer);
  releases[seq] = { doc, tarball };
  current = doc;
  return doc;
}
// ⛔ Async: the release server lives in THIS process, and spawnSync would block it.
const runUpdate = () => new Promise((r) => { const c = spawn(process.execPath, [join(dir, 'molibra-miner.mjs'), 'update'], { cwd: dir, stdio: 'ignore' }); const t = setTimeout(() => c.kill(), 60_000); c.on('exit', () => { clearTimeout(t); r(); }); });
const installed = () => { try { return JSON.parse(readFileSync(join(dir, 'app', 'RELEASE.json'), 'utf8')).manifest.seq; } catch { return null; } };
const minerLog = () => { try { return readFileSync(join(dir, 'logs', 'miner.log'), 'utf8'); } catch { return ''; } };

let supProc = null;
try {
  publish(1, GOOD_CLI);
  await runUpdate();
  check('1. a signed release installs (source verified against its digest)', installed() === 1
    && readFileSync(join(dir, 'app', 'COMMIT'), 'utf8').trim() === releases[1].doc.manifest.commit, minerLog().split('\n').slice(-3).join(' | '));

  publish(2, GOOD_CLI, { wrongTree: true });
  await runUpdate();
  check('2. ⛔ a release whose source does not match its signed digest is refused', installed() === 1 && /does not match the signed release/.test(minerLog()));

  publish(3, GOOD_CLI, { signer: ['test-key', STRANGER] });
  await runUpdate();
  check('3. ⛔ a release signed by a key not built in is refused', installed() === 1 && /refused: release has 0 valid/.test(minerLog()));

  // 4. a good-looking signed release whose node crash-loops.
  publish(4, CRASH_CLI);
  supProc = spawn(process.execPath, [join(dir, 'molibra-miner.mjs')], { cwd: dir, stdio: 'ignore' });
  let st = null;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { st = await (await fetch(`http://127.0.0.1:${STATUS}/status`)).json(); } catch { continue; }
    if (st.phase === 'mining' && /rolled back/.test(minerLog())) break;
  }
  const badSeqs = existsSync(join(dir, 'state.json')) ? JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).badSeqs : [];
  check('4. ⭐ a signed release that crash-loops is ROLLED BACK to the last good one', installed() === 1 && /rolled back release 1\.4\.0/.test(minerLog()), `installed seq ${installed()}`);
  check('   and the miner is back to mining on it', st?.phase === 'mining', st?.phase);
  check('   and that release is never tried again here', badSeqs.includes(4), JSON.stringify(badSeqs));
  check('   the window says which signed release runs', st?.release === '1.1.0' && st?.launcher === 4, `${st?.release} / ${st?.launcher}`);
} finally {
  supProc?.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
