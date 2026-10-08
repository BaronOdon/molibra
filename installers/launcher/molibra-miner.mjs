/**
 * Molibra Miner - the supervisor. One file, both platforms, plain JavaScript,
 * run by the official Node.js the installer placed beside it.
 *
 * The operating system starts it at boot - a Windows scheduled task (S4U: no
 * login needed, survives logoff) or a macOS LaunchDaemon - and it:
 *
 *   1. keeps the Molibra code at the latest SIGNED release (supervisor v4,
 *      8 Oct 2026). A release is a manifest - version, sequence, commit and a
 *      digest of every file - signed with the release keys built into this
 *      file. It is fetched from every peer, molibra.org and GitHub, and any
 *      copy whose signatures do not verify is ignored, so no server (the
 *      operator's included) can push code the keys did not sign. ⛔ Unsigned
 *      code is never run. Releases roll out over hours (each install has a
 *      stable place in the queue), a release that will not run is rolled back
 *      and skipped, and a release marked mandatory before a flag-day height is
 *      applied at once - an install still on the old code stops mining at that
 *      height rather than fork off the chain;
 *   2. runs a FULL PEER: the node verifies every block itself and, unless the
 *      user said no ("public": false, the default for installs from before
 *      v4, which never agreed), serves the chain to others - it
 *      opens its port on the router (UPnP) when it can, learns its public
 *      address from a peer, and announces it; peers dial it back before they
 *      list it, so "reachable" is a fact, not a hope;
 *   3. runs the node at low priority, mining to the address in config.json,
 *      and restarts it if it stops.
 *
 * ⛔ It is deliberately boring, because antivirus is right to be suspicious of
 * miners: no obfuscation, no hidden script host, no second executable. The
 * only binary is node itself, signed by the OpenJS Foundation, running the
 * readable source from github.com/BaronOdon/molibra. The node mines to an
 * ADDRESS; this file never touches a private key except to create a new wallet
 * once, on the user's own request, into a file only they can read.
 *
 *   node molibra-miner.mjs                 supervise (what the OS runs)
 *   node molibra-miner.mjs init [0xADDR|-] [public|private]   write config; '-' or none = new wallet
 *   node molibra-miner.mjs update          apply the latest signed release now, then exit
 *   node molibra-miner.mjs stop            stop this install's supervisor and node
 *   node molibra-miner.mjs window          open the Molibra Miner window (starts the miner if needed)
 *   node molibra-miner.mjs public on|off   serve the chain to others (default on)
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync,
  createWriteStream, statSync, chmodSync,
} from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { setPriority, networkInterfaces } from 'node:os';
import { createServer } from 'node:http';
import { createHash, createPublicKey, verify as verifySig, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';

/**
 * ⛔⛔ This supervisor's own version. Self-update copies a supervisor out of
 * app/ ONLY when that copy's version is HIGHER than this one. Without it, 1.0.1
 * "updated" itself BACKWARDS on the first independent miner's laptop (25 Sep
 * 2026). Bump this whenever this file changes.
 */
const LAUNCHER_VERSION = 4;

/**
 * ⛔⛔ The keys that may sign a miner release, and how many must agree. A
 * release is applied only with at least RELEASE_THRESHOLD valid signatures
 * from DIFFERENT keys listed here. Adding maintainers = adding keys and raising
 * the threshold, in a release signed under the current rule.
 * Public keys are Ed25519, base64url (JWK "x").
 */
export const RELEASE_SIGNERS = {
  'molibra-release-2026-10': 'UMXRp0rUZEbdvtSvonbsMEIVFIPues9c98sTbiGirVk',
};
export const RELEASE_THRESHOLD = 1;
export const RELEASE_DOMAIN = 'molibra-miner-release-v1\n';

const ROOT = dirname(fileURLToPath(import.meta.url));
const APP = join(ROOT, 'app');
const LOGS = join(ROOT, 'logs');
const CONFIG = join(ROOT, 'config.json');
const STATE = join(ROOT, 'state.json');
const WALLET = join(ROOT, 'MY-WALLET-KEEP-SECRET.txt');
const RELEASE_URLS = [
  'https://molibra.org/download/release.json',
  'https://raw.githubusercontent.com/BaronOdon/molibra/main/releases/miner-release.json',
];
const PEERS = 'http://193.123.191.142:8545,http://141.147.99.86:8545';
const PORT = 20226;
const CHECK_EVERY_MS = 60 * 60_000;            // release check: hourly (cheap: one small JSON)
const MANDATORY_LEAD_BLOCKS = 2000;            // ~11 h before a flag day: apply regardless of rollout
const LOW = 10;   // niceness; on Windows this maps to BELOW_NORMAL
const CODELOAD = 'https://codeload.github.com/BaronOdon/molibra/tar.gz';
const RESTART_DELAY_MS = 30_000;               // after the node stops unexpectedly
const HEALTH_POLL_MS = 30_000;
const RUN_NPM = true;                          // test/miner-release.mjs turns these constants down in its own copy

const isMain = process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) mkdirSync(LOGS, { recursive: true });
const logFile = join(LOGS, 'miner.log');
function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}\n`;
  if (!isMain) return;
  process.stdout.write(line);
  try {
    if (existsSync(logFile) && statSync(logFile).size > 10 * 2 ** 20) renameSync(logFile, logFile + '.1');
    writeFileSync(logFile, line, { flag: 'a' });
  } catch { /* logging must never stop mining */ }
}

/* ===================================================== signed releases */

/** JSON with keys sorted at every level: the bytes a signature covers. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
export const releaseMessage = (manifest) => Buffer.from(RELEASE_DOMAIN + canonicalJson(manifest), 'utf8');

/**
 * The manifest, if `doc` carries at least `threshold` valid signatures from
 * distinct keys in `signers`; otherwise throws, naming why.
 */
export function verifyRelease(doc, signers = RELEASE_SIGNERS, threshold = RELEASE_THRESHOLD) {
  const m = doc?.manifest;
  if (!m || m.product !== 'molibra-miner') throw new Error('not a Molibra Miner release');
  if (!/^[0-9a-f]{40}$/.test(m.commit ?? '')) throw new Error('release has no commit');
  if (!/^sha256:[0-9a-f]{64}$/.test(m.tree ?? '')) throw new Error('release has no tree digest');
  if (!Number.isSafeInteger(m.seq) || m.seq < 1) throw new Error('release has no sequence');
  const msg = releaseMessage(m);
  const good = new Set();
  for (const s of Array.isArray(doc.signatures) ? doc.signatures : []) {
    const x = signers[s?.signer];
    if (!x || good.has(s.signer)) continue;
    try {
      const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
      if (verifySig(null, msg, key, Buffer.from(String(s.sig), 'base64'))) good.add(s.signer);
    } catch { /* malformed signature: does not count */ }
  }
  if (good.size < threshold) throw new Error(`release has ${good.size} valid signature(s), needs ${threshold}`);
  return m;
}

/** Iterate the regular files of a tar (GitHub's pax headers handled): {path, body}, top folder dropped. */
export function* tarFiles(buf) {
  let off = 0;
  let paxPath = null;
  const str = (a, b) => buf.toString('utf8', a, b).replace(/\0.*$/s, '');
  while (off + 512 <= buf.length) {
    if (buf[off] === 0) break;
    let name = str(off, off + 100);
    const prefix = str(off + 345, off + 500);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(str(off + 124, off + 136).trim() || '0', 8);
    const type = String.fromCharCode(buf[off + 156] || 48);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {   // pax: may carry the real path of the next entry
      const m = body.toString('utf8').match(/\d+ path=([^\n]*)\n/);
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === 'g') continue;
    if (paxPath) { name = paxPath; paxPath = null; }
    // ⛔ Never anything outside the archive's folder, whatever it says.
    const parts = name.split('/').filter(Boolean);
    if (parts.some((p) => p === '..')) throw new Error(`refusing archive path ${name}`);
    const rel = parts.slice(1).join('/');   // drop GitHub's molibra-<sha>/ folder
    if (!rel) continue;
    if (type === '5') yield { path: rel, dir: true };
    else if (type === '0' || type === '\0') yield { path: rel, body };
  }
}

/**
 * sha256 over every regular file of the source tree: "path\0sha256(content)\n",
 * sorted by path. The same digest the signing tool computes from git's own
 * objects, so it does not depend on how GitHub compresses an archive.
 */
export function treeDigest(files) {
  const lines = files.map(({ path, body }) => `${path}\0${createHash('sha256').update(body).digest('hex')}\n`).sort();
  return 'sha256:' + createHash('sha256').update(lines.join('')).digest('hex');
}

/** This install's stable place in a rollout, 0-99. */
export const rolloutBucket = (installId) => createHash('sha256').update(String(installId)).digest()[0] % 100;

/**
 * May this install apply `m` now? A release opens to bucket b once
 * b < 100 x (time since publishedAt / rollout hours). Mandatory releases near
 * their height open to everyone.
 */
export function rolloutAllows(m, { bucket, now = Date.now(), networkHeight = null }) {
  if (m.mandatory?.beforeHeight && networkHeight !== null
      && networkHeight >= Number(m.mandatory.beforeHeight) - MANDATORY_LEAD_BLOCKS) return true;
  const hours = Number(m.rollout?.hours ?? 0);
  if (!(hours > 0)) return true;
  const frac = (now - Date.parse(m.publishedAt)) / (hours * 3600_000);
  return bucket < Math.floor(100 * Math.max(0, Math.min(1, frac)));
}

/** Must this install stop MINING because it missed a mandatory release whose height has come? */
export function mustStopMining(m, installedSeq, networkHeight) {
  return Boolean(m?.mandatory?.beforeHeight) && installedSeq < m.seq
    && networkHeight !== null && networkHeight >= Number(m.mandatory.beforeHeight);
}

/* ============================================================== state */

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const state = () => readJson(STATE, { badSeqs: [] });
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));
const installedRelease = () => readJson(join(APP, 'RELEASE.json'), null);
const installedCommit = () => {
  try { return readFileSync(join(APP, 'COMMIT'), 'utf8').trim(); } catch { return null; }
};

function readConfig() {
  return JSON.parse(readFileSync(CONFIG, 'utf8'));
}
/** config.json, with the fields v4 added filled in for an install that predates them. */
function config() {
  const cfg = readConfig();
  let changed = false;
  if (!cfg.installId) { cfg.installId = randomBytes(16).toString('hex'); changed = true; }
  // ⛔ Consent: an install from before v4 never agreed to publish its IP or to
  //    open a router port, so it stays PRIVATE (a full, verifying node that
  //    serves nobody) until its owner turns public on. New installs ask.
  if (cfg.public === undefined) { cfg.public = false; changed = true; }
  if (changed) writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  return cfg;
}
const peerList = (cfg) => String(cfg.peers ?? PEERS).split(',').map((s) => s.trim()).filter(Boolean);

/* ===================================================== fetching a release */

async function getJson(url, ms = 15_000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.json();
}

/** The newest validly signed release any source offers, or null. Sources disagreeing is fine: signatures decide. */
async function latestRelease(cfg) {
  const urls = [...new Set([...peerList(cfg).map((p) => p.replace(/\/$/, '') + '/download/release.json'), ...RELEASE_URLS])];
  const docs = await Promise.allSettled(urls.map((u) => getJson(u)));
  let best = null;
  for (const [i, d] of docs.entries()) {
    if (d.status !== 'fulfilled') continue;
    try {
      const m = verifyRelease(d.value);
      if (!best || m.seq > best.manifest.seq) best = { manifest: m, doc: d.value, from: urls[i] };
    } catch (e) { log(`release from ${urls[i]} refused: ${e.message}`); }
  }
  return best;
}

/** The highest block any peer reports, or null. */
async function networkHeight(cfg) {
  const hs = await Promise.allSettled(peerList(cfg).map(async (p) =>
    Number((await getJson(p.replace(/\/$/, '') + '/molibra/head', 8000))?.header?.number)));
  const ok = hs.filter((h) => h.status === 'fulfilled' && Number.isFinite(h.value)).map((h) => h.value);
  return ok.length ? Math.max(...ok) : null;
}

function npmCli() {
  const bin = dirname(process.execPath);
  for (const p of [join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (existsSync(p)) return p;
  }
  throw new Error('npm is missing from this Node.js');
}

/**
 * Build the release beside the running code; the caller swaps it in.
 * ⛔ The archive's files must hash to the SIGNED tree digest before a single
 *    one is written: whoever served the archive (GitHub today, any mirror
 *    tomorrow) cannot change what runs. Dependencies come from package-lock.json,
 *    which is inside the signed tree, so npm verifies each one by its integrity hash.
 */
async function buildApp(release) {
  const { commit, tree } = release.manifest;
  log(`fetching Molibra ${release.manifest.version} (${commit.slice(0, 7)})`);
  const stage = join(ROOT, 'app-new');
  rmSync(stage, { recursive: true, force: true });
  const r = await fetch(`${CODELOAD}/${commit}`, { signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new Error(`source answered ${r.status}`);
  const entries = [...tarFiles(gunzipSync(Buffer.from(await r.arrayBuffer())))];
  const files = entries.filter((e) => !e.dir);
  const got = treeDigest(files);
  if (got !== tree) throw new Error(`source does not match the signed release (${got} is not ${tree}): refused`);
  for (const e of entries) {
    const out = join(stage, e.path);
    if (e.dir) mkdirSync(out, { recursive: true });
    else { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, e.body); }
  }
  if (RUN_NPM) {
    const npm = spawnSync(process.execPath, [npmCli(), 'ci', '--omit=dev', '--no-audit', '--no-fund',
      '--loglevel=error'], { cwd: stage, encoding: 'utf8', timeout: 600_000 });
    if (npm.status !== 0) throw new Error(`npm ci failed: ${(npm.stderr || npm.stdout || '').slice(0, 300)}`);
  }
  writeFileSync(join(stage, 'COMMIT'), commit + '\n');
  writeFileSync(join(stage, 'RELEASE.json'), JSON.stringify(release.doc, null, 2));
  return stage;
}

/** Swap the built release in, keeping the previous one as app-prev for a rollback. */
function swapIn(stage) {
  const prev = join(ROOT, 'app-prev');
  rmSync(prev, { recursive: true, force: true });
  if (existsSync(APP)) renameSync(APP, prev);
  renameSync(stage, APP);
  const rel = installedRelease()?.manifest;
  log(`Molibra ${rel?.version ?? '?'} (${installedCommit()?.slice(0, 7)}) is now installed`);
  return refreshSelf();
}

/** Put app-prev back (a release that would not run), and never try that release again. */
function rollBack(reason) {
  const bad = installedRelease()?.manifest;
  const prev = join(ROOT, 'app-prev');
  if (!existsSync(prev)) { log(`cannot roll back (${reason}): no previous version kept`); return false; }
  rmSync(join(ROOT, 'app-bad'), { recursive: true, force: true });
  renameSync(APP, join(ROOT, 'app-bad'));
  renameSync(prev, APP);
  if (bad) { const s = state(); s.badSeqs = [...new Set([...(s.badSeqs ?? []), bad.seq])]; saveState(s); }
  log(`rolled back release ${bad?.version ?? '?'} (seq ${bad?.seq ?? '?'}): ${reason}`);
  return true;
}

/**
 * The supervisor and its window live OUTSIDE app/. The release carries both,
 * so copy them across when the release's copy is newer. Returns true when the
 * supervisor itself changed and must restart.
 */
function refreshSelf() {
  const dir = join(APP, 'installers', 'launcher');
  let candidate;
  try { candidate = readFileSync(join(dir, 'molibra-miner.mjs')); } catch { return false; }
  // A copy with no version is older than every versioned one: never adopted.
  const theirs = Number(candidate.toString('utf8').match(/const LAUNCHER_VERSION = (\d+);/)?.[1] ?? 0);
  if (theirs <= LAUNCHER_VERSION) return false;
  writeFileSync(join(ROOT, 'molibra-miner.mjs'), candidate);
  try { writeFileSync(join(ROOT, 'status.html'), readFileSync(join(dir, 'status.html'))); } catch { /* optional */ }
  log(`supervisor updated: version ${LAUNCHER_VERSION} -> ${theirs}`);
  return true;
}

/**
 * Windows: keep "Molibra Miner.exe" (the window) current. The manifest
 * installers/app/windows/window.json is read from the INSTALLED release - a
 * signed tree - and names the published exe and its SHA-256; a file whose hash
 * differs is refused. A running exe cannot be overwritten but CAN be renamed.
 */
async function refreshWindow() {
  if (process.platform !== 'win32') return;
  try {
    const m = readJson(join(APP, 'installers', 'app', 'windows', 'window.json'), null);
    if (!m) return;
    const vf = join(ROOT, 'window-version.txt');
    const have = Number((() => { try { return readFileSync(vf, 'utf8'); } catch { return '0'; } })());
    if (!(Number(m.version) > have) || !/^[0-9a-f]{64}$/.test(m.sha256 ?? '')) return;
    const bytes = Buffer.from(await (await fetch(m.url, { signal: AbortSignal.timeout(120_000) })).arrayBuffer());
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== m.sha256) { log(`window update refused: hash ${got} is not ${m.sha256}`); return; }
    const exe = join(ROOT, 'Molibra Miner.exe');
    rmSync(exe + '.old', { force: true });
    if (existsSync(exe)) renameSync(exe, exe + '.old');
    writeFileSync(exe, bytes);
    writeFileSync(vf, String(m.version));
    log(`window updated to version ${m.version}`);
  } catch (e) { log(`window update skipped: ${e.message}`); }
}

/** A marker the supervisor leaves when it restarts itself for a release: the next start watches that release's health. */
const UPDATED_MARK = join(ROOT, 'just-updated');
function restartedAfterUpdate() {
  if (!existsSync(UPDATED_MARK)) return false;
  rmSync(UPDATED_MARK, { force: true });
  return true;
}

/** Restart this supervisor on its new code, the way each platform allows. */
async function restartSelf() {
  log('restarting the supervisor on its new version');
  await stopNode();
  await upnpRelease().catch(() => {});
  try { rmSync(join(ROOT, 'supervisor.pid'), { force: true }); } catch { /* fine */ }
  // ⛔ Release the status port FIRST: it is the lock, and a successor that
  //    found it still answering would conclude it was a duplicate and exit.
  if (statusServer) {
    statusServer.closeAllConnections?.();
    await new Promise((r) => statusServer.close(r));
  }
  // launchd (KeepAlive) restarts us by itself; a second copy would fight it.
  // Task Scheduler does not, so hand over to a detached successor first.
  if (process.platform === 'win32') {
    spawn(process.execPath, [join(ROOT, 'molibra-miner.mjs')],
      { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  process.exit(0);
}

/* ========================================================== full peer: UPnP */

/**
 * Ask the router to forward the miner's port (UPnP IGD), so peers can reach it.
 * Best effort: many routers have UPnP off, and then the node still runs as a
 * full, verifying node - it just cannot serve others. Returns
 * { externalPort, externalIp } or null.
 */
export async function upnpDiscover(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = (v) => { try { sock.close(); } catch { /* closed */ } resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.on('message', (msg) => {
      const loc = /^location:\s*(\S+)/im.exec(msg.toString())?.[1];
      if (loc) { clearTimeout(timer); done(loc); }
    });
    sock.on('error', () => { clearTimeout(timer); done(null); });
    const q = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\n'
      + 'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n');
    sock.bind(() => sock.send(q, 1900, '239.255.255.250', () => {}));
  });
}

/** The WAN connection service of the gateway described at `location`: { controlUrl, serviceType }. */
export async function upnpService(location, fetchText = async (u) => (await fetch(u, { signal: AbortSignal.timeout(5000) })).text()) {
  const xml = await fetchText(location);
  const base = /<URLBase>([^<]+)<\/URLBase>/i.exec(xml)?.[1] ?? location;
  for (const block of xml.split(/<service>/i).slice(1)) {
    const type = /<serviceType>([^<]+)<\/serviceType>/i.exec(block)?.[1] ?? '';
    if (!/WAN(IP|PPP)Connection:\d/.test(type)) continue;
    const ctl = /<controlURL>([^<]+)<\/controlURL>/i.exec(block)?.[1];
    if (ctl) return { controlUrl: new URL(ctl, base).toString(), serviceType: type };
  }
  throw new Error('the router offers no WAN connection service');
}

async function soap(svc, action, args = {}) {
  const body = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
    + 's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
    + `<u:${action} xmlns:u="${svc.serviceType}">`
    + Object.entries(args).map(([k, v]) => `<${k}>${String(v).replace(/[<&]/g, '')}</${k}>`).join('')
    + `</u:${action}></s:Body></s:Envelope>`;
  const r = await fetch(svc.controlUrl, {
    method: 'POST', body, signal: AbortSignal.timeout(6000),
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${svc.serviceType}#${action}"` },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${action}: router answered ${r.status}`);
  return text;
}

/** This machine's LAN address on the route to `host`. */
function localAddressTowards(host) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.connect(1900, host, () => { const a = s.address().address; s.close(); resolve(a); });
    s.on('error', () => {
      const v4 = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
      resolve(v4?.address ?? null);
    });
  });
}

let upnpMapping = null;
async function upnpMap(port) {
  const location = await upnpDiscover();
  if (!location) return null;
  const svc = await upnpService(location);
  const client = await localAddressTowards(new URL(location).hostname);
  if (!client) return null;
  // The same external port when free; a few alternatives when another device took it.
  for (const ext of [port, port + 2, port + 3, port + 4, port + 5]) {
    try {
      await soap(svc, 'AddPortMapping', { NewRemoteHost: '', NewExternalPort: ext, NewProtocol: 'TCP',
        NewInternalPort: port, NewInternalClient: client, NewEnabled: 1,
        NewPortMappingDescription: 'Molibra Miner', NewLeaseDuration: 7200 });
      let externalIp = null;
      try { externalIp = /<NewExternalIPAddress>([^<]+)</i.exec(await soap(svc, 'GetExternalIPAddress'))?.[1] ?? null; } catch { /* ask a peer */ }
      upnpMapping = { svc, ext };
      return { externalPort: ext, externalIp };
    } catch { /* taken: try the next */ }
  }
  return null;
}
async function upnpRelease() {
  if (!upnpMapping) return;
  const { svc, ext } = upnpMapping;
  upnpMapping = null;
  await soap(svc, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: ext, NewProtocol: 'TCP' });
}

/** Where the world can reach this node: http://<public ip>:<port>, or null. */
async function publicEndpoint(cfg) {
  let mapped = null;
  try { mapped = await upnpMap(cfg.port ?? PORT); } catch (e) { log(`UPnP: ${e.message}`); }
  let ip = mapped?.externalIp ?? null;
  if (!ip || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)) {
    // No UPnP answer, or a router behind another NAT: ask a peer what it sees.
    for (const p of peerList(cfg)) {
      try { ip = (await getJson(p.replace(/\/$/, '') + '/molibra/whoami', 8000)).ip; if (ip) break; } catch { /* next */ }
    }
  }
  if (!ip || !/^[\d.]+$/.test(ip)) return null;
  status.network.upnp = Boolean(mapped);
  return `http://${ip}:${mapped?.externalPort ?? cfg.port ?? PORT}`;
}

/* ============================================================== the window */

const statusUp = async () => {
  try { return (await fetch(`http://127.0.0.1:${STATUS_PORT}/status`, { signal: AbortSignal.timeout(2500) })).ok; }
  catch { return false; }
};
const waitFor = async (ms) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await statusUp()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};

/** Open `url` in an app-style window (no browser bars) if a Chromium browser is there. */
function openAppWindow(url) {
  const candidates = process.platform === 'win32' ? [
    join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  const browser = candidates.find((p) => p && existsSync(p));
  if (browser) {
    spawn(browser, [`--app=${url}`, '--window-size=600,860'], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

/**
 * What the "Molibra Miner" shortcut runs. It never opens a page that cannot
 * answer: it waits for the supervisor, starts it if it is not running, and if
 * it still cannot, shows WHY - the last lines of the log - instead of a
 * browser error.
 */
async function openWindow() {
  const url = `http://127.0.0.1:${STATUS_PORT}/`;
  let up = await waitFor(4000);
  if (!up && process.platform === 'win32') {
    spawnSync('schtasks', ['/Run', '/TN', 'Molibra Miner'], { windowsHide: true });
    up = await waitFor(20_000);
  }
  if (!up) {
    // Last resort: run the supervisor directly, as whoever opened the window.
    spawn(process.execPath, [join(ROOT, 'molibra-miner.mjs')],
      { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    up = await waitFor(30_000);
  }
  if (up) return openAppWindow(url);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const page = join(ROOT, 'not-running.html');
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>Molibra Miner</title>
<body style="background:#0b0b0c;color:#ececf0;font:15px/1.6 system-ui,sans-serif;padding:24px">
<h2 style="color:#ff5c5c">Molibra Miner could not start</h2>
<p>Restart the computer and open Molibra Miner again. If this page comes back, send a photo of it to the
person who gave you the installer, or see <a style="color:#FFD100" href="https://molibra.org/download">molibra.org/download</a>.</p>
<pre style="background:#141416;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:12px">${esc(logTail('miner.log', 25).join('\n'))}</pre>
<p style="color:#8b8b94;font-size:12px">Folder: ${esc(ROOT)}</p>`);
  openAppWindow('file:///' + page.replace(/\\/g, '/'));
}

/* ============================================================== the wallet */

function init(address, publicChoice = null) {
  let miner = (address ?? '').trim();
  let created = false;
  const prev = existsSync(CONFIG) ? readConfig() : {};
  if (!miner) miner = prev.miner ?? '';
  if (!miner) {
    const out = spawnSync(process.execPath, [join(APP, 'src', 'cli.js'), 'keys'], { encoding: 'utf8' }).stdout;
    const key = out.match(/private key\s*:\s*(0x[0-9a-fA-F]{64})/)?.[1];
    miner = out.match(/address\s*:\s*(0x[0-9a-fA-F]{40})/)?.[1];
    if (!key || !miner) throw new Error('could not create a wallet');
    writeFileSync(WALLET, [
      'MOLIBRA WALLET - KEEP THIS FILE SECRET AND BACKED UP', '',
      `Address     : ${miner}`, `Private key : ${key}`, '',
      'Anyone who has the private key controls the MOLI in this wallet.',
      'Never send it to anyone. Molibra will never ask for it.',
      'To see or spend your MOLI: MetaMask > Add account > Import account > paste the private key,',
      'then add the Molibra network: chain ID 20226, RPC https://molibra.org, symbol MOLI.', '',
    ].join('\n'), { mode: 0o600 });
    try { chmodSync(WALLET, 0o600); } catch { /* Windows: the folder's ACL applies */ }
    created = true;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(miner)) throw new Error(`not a wallet address: ${miner}`);
  // The installer passes 'public' when its owner ticked "help the network", 'private' otherwise.
  const pub = publicChoice === 'public' ? true : publicChoice === 'private' ? false : (prev.public ?? false);
  writeFileSync(CONFIG, JSON.stringify({ miner, peers: prev.peers ?? PEERS, port: PORT, public: pub,
    installId: prev.installId ?? randomBytes(16).toString('hex') }, null, 2));
  const summary = { miner, created, public: pub, walletFile: created ? WALLET : null, status: `http://127.0.0.1:${STATUS_PORT}/` };
  writeFileSync(join(ROOT, 'install-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}

/* ====================================================== what is happening */

/**
 * The supervisor's own account of itself, served on STATUS_PORT from the first
 * second it runs - BEFORE any update or chain load.
 */
const STATUS_PORT = 20227;
const status = {
  phase: 'starting', detail: 'Starting the miner…', error: null,
  height: null, networkHeight: null, mining: false,
  minedThisSession: [], startedAt: new Date().toISOString(), commit: null, miner: null,
  release: null, update: null, launcher: LAUNCHER_VERSION,
  network: { public: null, advertised: null, reachable: null, upnp: null, peers: null },
};
function phase(p, detail) {
  status.phase = p;
  status.detail = detail;
  if (p !== 'problem') status.error = null;
}
/** One line the native windows show as-is: what the miner is doing for the network. */
function networkLine() {
  const n = status.network;
  const peers = n.peers === null ? '' : ` · ${n.peers} peer${n.peers === 1 ? '' : 's'}`;
  if (n.public === false) return `Full node (verifies every block), private${peers}.`;
  if (n.reachable === true) return `Full node serving the network${peers}.`;
  if (n.reachable === false) return `Full node; not reachable from the internet (router port closed)${peers}.`;
  return `Full node${peers}.`;
}

/** Read the node's own output as it happens: progress, catch-up, blocks found. */
function watchNodeOutput(line) {
  let m;
  if ((m = line.match(/catching up: ([\d,]+) of ([\d,]+) blocks/))) {
    status.height = Number(m[1].replace(/,/g, ''));
    status.networkHeight = Number(m[2].replace(/,/g, ''));
    phase('catching-up', 'Downloading and checking the chain. Mining starts by itself when this reaches 100%.');
  } else if (/caught up at \d+ - mining starts now/.test(line) || /no peer has answered/.test(line)) {
    status.mining = true;
    phase('mining', `Up to date with the network and mining to your wallet. ${networkLine()}`);
    healthy = true;
  } else if ((m = line.match(/^\s+#(\d+)\s+0x[0-9a-f]+/))) {
    // `cli.js node` prints a line like this ONLY for blocks this node mined.
    status.minedThisSession.push({ height: Number(m[1]), at: new Date().toISOString() });
    if (status.minedThisSession.length > 50) status.minedThisSession.shift();
  } else if ((m = line.match(/height\s*:\s*(\d+)/)) && status.phase === 'loading') {
    status.height = Number(m[1]);
  } else if (/Error|FATAL/.test(line) && !/sync from .* failed/.test(line)) {
    status.error = line.trim().slice(0, 300);
  }
}

function logTail(file, lines = 12) {
  try {
    const text = readFileSync(join(LOGS, file), 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch { return []; }
}

let statusServer = null;
function startStatusServer() {
  const page = (() => { try { return readFileSync(join(ROOT, 'status.html')); } catch { return null; } })();
  const server = statusServer = createServer(async (req, res) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (req.url.startsWith('/status')) {
      if (child && ['catching-up', 'mining', 'loading'].includes(status.phase)) {
        try {
          const cfg = readConfig();
          const r = await fetch(`http://127.0.0.1:${cfg.port ?? PORT}/molibra`, { signal: AbortSignal.timeout(1500) });
          const h = Number((await r.json()).height);
          if (Number.isFinite(h)) { status.height = h; healthy ||= status.phase === 'catching-up'; }
        } catch { /* busy verifying; the last known height stands */ }
      }
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...status, log: logTail('miner.log', 6), nodeLog: logTail('node.log', 8) }));
    } else if (page) {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page);
    } else {
      res.writeHead(404, headers);
      res.end('status.html is missing from this install');
    }
  });
  server.on('error', (e) => log(`status window unavailable: ${e.message}`));
  server.listen(STATUS_PORT, '127.0.0.1');
}

/* ================================================================ the node */

let child = null;
let healthy = false;          // the running release has proved itself (caught up or mining)
let mineAllowed = true;       // false while a mandatory release is missed past its height
let exitsSinceStart = 0;
let advertised = null;

function startNode() {
  const cfg = config();
  status.miner = cfg.miner;
  status.commit = installedCommit();
  status.release = installedRelease()?.manifest?.version ?? null;
  status.mining = false;
  status.network.public = cfg.public !== false;
  status.network.advertised = advertised;
  phase('loading', 'Loading this computer\'s copy of the chain…');
  const out = createWriteStream(join(LOGS, 'node.log'), { flags: 'a' });
  // ⭐ A full peer: binds every interface when public (so peers can sync from
  //    it), only loopback when the user chose private.
  const args = [join('src', 'cli.js'), 'node',
    '--host', cfg.public === false ? '127.0.0.1' : '0.0.0.0',
    '--port', String(cfg.port ?? PORT), '--datadir', join(ROOT, 'data'),
    '--peers', cfg.peers ?? PEERS, '--miner', cfg.miner];
  if (cfg.public !== false && advertised) args.push('--advertise', advertised);
  if (mineAllowed) args.push('--mine');
  child = spawn(process.execPath, args, { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  let partial = '';
  const feed = (chunk) => {
    const lines = (partial + chunk.toString()).split(/\r?\n/);
    partial = lines.pop();
    for (const l of lines) watchNodeOutput(l);
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  try { setPriority(child.pid, LOW); } catch { /* best effort */ }
  writeFileSync(join(ROOT, 'node.pid'), String(child.pid));
  log(`node started (pid ${child.pid}), ${mineAllowed ? `mining to ${cfg.miner}` : 'NOT mining (needs the mandatory update)'}`
    + `${advertised ? `, serving at ${advertised}` : ''}`);
  const me = child;
  child.on('exit', (code) => {
    if (child !== me) return;           // replaced on purpose by an update
    child = null;
    exitsSinceStart++;
    status.mining = false;
    status.error = status.error ?? `the node stopped (exit ${code})`;
    phase('problem', 'The miner stopped unexpectedly and restarts by itself in 30 seconds.');
    log(`node stopped (exit ${code}); restarting in 30s`);
    setTimeout(startNode, RESTART_DELAY_MS);
  });
}

function stopNode() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const c = child;
    child = null;
    c.once('exit', resolve);
    c.kill();
    setTimeout(resolve, 30_000);
  });
}

/** Is this node reachable? Its peers dial back before listing it, so being listed is the proof. */
async function checkReachable(cfg) {
  try {
    const counts = await Promise.allSettled([fetch(`http://127.0.0.1:${cfg.port ?? PORT}/molibra/peers`,
      { signal: AbortSignal.timeout(3000) }).then((r) => r.json())]);
    if (counts[0].status === 'fulfilled') status.network.peers = counts[0].value?.peers?.length ?? null;
  } catch { /* node busy */ }
  if (cfg.public === false || !advertised) { status.network.reachable = cfg.public === false ? null : false; return; }
  const lists = await Promise.allSettled(peerList(cfg).map((p) => getJson(p.replace(/\/$/, '') + '/molibra/peers', 8000)));
  status.network.reachable = lists.some((l) => l.status === 'fulfilled' && (l.value?.peers ?? []).includes(advertised));
  if (status.phase === 'mining') status.detail = `Up to date with the network and mining to your wallet. ${networkLine()}`;
}

/**
 * Check for a signed release and apply it when this install's turn has come.
 * Returns false (nothing done), true (new code: restart the node) or 'restart'
 * (the supervisor itself changed).
 */
async function updateIfNeeded({ running }) {
  const cfg = config();
  const best = await latestRelease(cfg);
  if (!best) { status.update = 'no signed release reachable'; return false; }
  const m = best.manifest;
  const have = installedRelease()?.manifest;
  const haveSeq = have?.seq ?? 0;
  const height = await networkHeight(cfg);
  if (height !== null) status.networkHeight = height;
  // Flag-day guard: past the height of a mandatory release we do not have, stop mining.
  const stop = mustStopMining(m, haveSeq, height);
  if (stop !== !mineAllowed) {
    mineAllowed = !stop;
    if (stop) log(`release ${m.version} was mandatory before height ${m.mandatory.beforeHeight}: mining paused until it is installed`);
    if (running) { await stopNode(); startNode(); }
  }
  if (m.seq <= haveSeq) { status.update = `up to date (${have?.version ?? m.version})`; return false; }
  if ((state().badSeqs ?? []).includes(m.seq)) { status.update = `release ${m.version} was rolled back here; waiting for the next`; return false; }
  if (Number(m.minLauncher ?? 0) > LAUNCHER_VERSION) { status.update = `release ${m.version} needs a newer installer`; return false; }
  if (!rolloutAllows(m, { bucket: rolloutBucket(cfg.installId), networkHeight: height })) {
    status.update = `release ${m.version} is rolling out; this computer's turn comes later`;
    return false;
  }
  status.update = `installing ${m.version}`;
  if (!running) phase('updating', `Installing Molibra ${m.version} (signed release)…`);
  const stage = await buildApp(best);           // the node keeps mining meanwhile
  if (running) await stopNode();
  healthy = false;
  exitsSinceStart = 0;
  status.update = `installed ${m.version}`;
  const self = swapIn(stage);
  writeFileSync(UPDATED_MARK, String(m.seq));
  return self ? 'restart' : true;
}

/**
 * Right after a release is swapped in: if its node keeps CRASHING (3 exits
 * before it ever catches up or mines), the release is rolled back and skipped.
 * ⛔ Slowness is never a reason: replaying the chain on a slow laptop can take
 *    longer than any window we could pick, and rolling back a good release for
 *    it would be worse than waiting. Only a crash loop is evidence.
 */
function watchHealth() {
  const t = setInterval(async () => {
    if (healthy) { clearInterval(t); return; }
    if (exitsSinceStart >= 3) {
      clearInterval(t);
      await stopNode();
      if (rollBack(`the node stopped ${exitsSinceStart} times before it ever ran`)) {
        healthy = false; exitsSinceStart = 0;
        if (refreshSelf()) await restartSelf();
      }
      startNode();
    }
  }, HEALTH_POLL_MS);
}

/* ==================================================================== main */

async function supervise() {
  // ⛔ One supervisor at a time: the lock is the STATUS PORT, not a PID file.
  if (await statusUp()) { log('another supervisor is already running'); process.exit(0); }
  writeFileSync(join(ROOT, 'supervisor.pid'), String(process.pid));
  startStatusServer();
  try { setPriority(process.pid, LOW); } catch { /* best effort */ }
  log(`Molibra Miner supervisor ${LAUNCHER_VERSION} starting`);
  const cfg = config();
  status.miner = cfg.miner;
  let restart = refreshSelf();                 // an install older than its app/
  if (!installedCommit()) {
    const best = await latestRelease(cfg);
    if (!best) throw new Error('no signed release reachable: cannot install the chain software');
    restart = swapIn(await buildApp(best)) || restart;
  } else {
    restart = (await updateIfNeeded({ running: false }).catch((e) => { log(`update skipped: ${e.message}`); return false; })) === 'restart' || restart;
  }
  if (restart) await restartSelf();
  if (cfg.public !== false) {
    advertised = await publicEndpoint(cfg).catch((e) => { log(`public address unknown: ${e.message}`); return null; });
  }
  startNode();
  if (restartedAfterUpdate()) watchHealth();
  refreshWindow();
  setTimeout(() => checkReachable(cfg), 5 * 60_000);
  setInterval(() => checkReachable(config()), 30 * 60_000);
  // UPnP leases are two hours: renew hourly, beside the release check.
  setInterval(() => {
    refreshWindow();
    if (config().public !== false && upnpMapping) upnpMap(config().port ?? PORT).catch(() => {});
    updateIfNeeded({ running: true })
      .then(async (changed) => {
        if (changed === 'restart') await restartSelf();
        else if (changed) { restartedAfterUpdate(); startNode(); watchHealth(); }
      })
      .catch((e) => { log(`update failed, still on the old version: ${e.message}`); if (!child) startNode(); });
  }, CHECK_EVERY_MS + Math.floor(Math.random() * 10 * 60_000));
  const bye = async () => { await stopNode(); await upnpRelease().catch(() => {}); process.exit(0); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}

if (isMain) {
  const [cmd, arg, arg2] = process.argv.slice(2);
  try {
    if (cmd === 'init') {
      // init <0xADDR|''> <public|private>: an empty address string = a new wallet.
      init(arg === '-' ? '' : arg, arg2 ?? null);
    } else if (cmd === 'window') {
      await openWindow();
    } else if (cmd === 'public') {
      const cfg = config();
      cfg.public = arg !== 'off';
      writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
      console.log(`public: ${cfg.public} (takes effect when the miner restarts)`);
    } else if (cmd === 'taskxml') {
      // Windows only. The scheduled task, as the XML Task Scheduler reads: S4U
      // (runs whether or not the user is logged on, stores no password), boot
      // trigger, no time limit, restart on failure, below-normal priority, and
      // node.exe run directly - no script host in between. UTF-16LE with a BOM.
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
      const xml = '<?xml version="1.0" encoding="UTF-16"?>\r\n'
        + '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">'
        + '<RegistrationInfo><Description>Mines MOLI on the Molibra network. https://molibra.org/download</Description></RegistrationInfo>'
        + '<Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>'
        + `<Principals><Principal id="Author"><UserId>${esc(user)}</UserId>`
        + '<LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>'
        + '<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'
        + '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'
        + '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable>'
        + '<IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>'
        + '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority>'
        + '<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>'
        + `<Actions Context="Author"><Exec><Command>${esc(process.execPath)}</Command>`
        + `<Arguments>"${esc(join(ROOT, 'molibra-miner.mjs'))}"</Arguments>`
        + `<WorkingDirectory>${esc(ROOT)}</WorkingDirectory></Exec></Actions></Task>`;
      writeFileSync(join(ROOT, 'task.xml'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
      log(`task.xml written for ${user}`);
    } else if (cmd === 'stop') {
      // Used by the uninstaller: stop THIS install's supervisor and node, by the
      // PIDs they recorded - never every node.exe on the machine.
      for (const f of ['supervisor.pid', 'node.pid']) {
        try { process.kill(Number(readFileSync(join(ROOT, f), 'utf8')), 'SIGTERM'); log(`stopped ${f}`); } catch { /* not running */ }
      }
    } else if (cmd === 'update') {
      if (!(await updateIfNeeded({ running: false }))) log(`no update applied: ${status.update}`);
    } else {
      await supervise();
    }
  } catch (e) {
    log(`FATAL: ${e.message}`);
    process.exit(1);
  }
}
