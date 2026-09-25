/**
 * Molibra Miner - the supervisor. One file, both platforms, plain JavaScript,
 * run by the official Node.js the installer placed beside it.
 *
 * The operating system starts it at boot - a Windows scheduled task (S4U: no
 * login needed, survives logoff) or a macOS LaunchDaemon - and it:
 *
 *   1. keeps the Molibra code at EXACTLY the commit the public node runs
 *      (https://molibra.org/download/version.json), checking every 6 hours.
 *      Before a flag day that is the difference between following the chain
 *      and forking off it at the activation height;
 *   2. runs the node at low priority, mining to the address in config.json;
 *   3. restarts the node if it stops.
 *
 * ⛔ It is deliberately boring, because antivirus is right to be suspicious of
 * miners: no obfuscation, no hidden script host, no second executable. The
 * only binary is node itself, signed by the OpenJS Foundation, running the
 * readable source from github.com/BaronOdon/molibra. The node mines to an
 * ADDRESS; this file never touches a private key except to create a new wallet
 * once, on the user's own request, into a file only they can read.
 *
 *   node molibra-miner.mjs                 supervise (what the OS runs)
 *   node molibra-miner.mjs init [0xADDR]   write config; no address = new wallet
 *   node molibra-miner.mjs update          fetch the current version now, then exit
 *   node molibra-miner.mjs stop            stop this install's supervisor and node
 *   node molibra-miner.mjs window          open the Molibra Miner window (starts the miner if needed)
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync,
  createWriteStream, statSync, chmodSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { setPriority } from 'node:os';
import { createServer } from 'node:http';

const ROOT = dirname(fileURLToPath(import.meta.url));
const APP = join(ROOT, 'app');
const LOGS = join(ROOT, 'logs');
const CONFIG = join(ROOT, 'config.json');
const WALLET = join(ROOT, 'MY-WALLET-KEEP-SECRET.txt');
const VERSION_URL = 'https://molibra.org/download/version.json';
const PEERS = 'http://193.123.191.142:8545,http://141.147.99.86:8545';
const PORT = 20226;
const UPDATE_EVERY_MS = 6 * 3600_000;
const LOW = 10;   // niceness; on Windows this maps to BELOW_NORMAL

mkdirSync(LOGS, { recursive: true });
const logFile = join(LOGS, 'miner.log');
function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}\n`;
  process.stdout.write(line);
  try {
    if (existsSync(logFile) && statSync(logFile).size > 10 * 2 ** 20) renameSync(logFile, logFile + '.1');
    writeFileSync(logFile, line, { flag: 'a' });
  } catch { /* logging must never stop mining */ }
}

/* ------------------------------------------------------------- the code */

const installedCommit = () => {
  try { return readFileSync(join(APP, 'COMMIT'), 'utf8').trim(); } catch { return null; }
};

async function wantedCommit() {
  // For testing a build against a specific commit; never set by the installers.
  if (/^[0-9a-f]{40}$/.test(process.env.MOLIBRA_COMMIT ?? '')) return process.env.MOLIBRA_COMMIT;
  try {
    const r = await fetch(VERSION_URL, { signal: AbortSignal.timeout(30_000) });
    const v = await r.json();
    if (/^[0-9a-f]{40}$/.test(v.commit ?? '')) return v.commit;
  } catch (e) { log(`could not read ${VERSION_URL}: ${e.message}`); }
  return null;
}

/** Unpack a .tar (GitHub's tarballs use pax headers for long names). */
function untar(buf, dest) {
  let off = 0;
  let paxPath = null;
  let top = null;
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
    // ⛔ Never write outside `dest`, whatever an archive says.
    const parts = name.split('/').filter(Boolean);
    if (parts.some((p) => p === '..')) throw new Error(`refusing archive path ${name}`);
    top ??= parts[0];
    const rel = parts.slice(1).join('/');   // drop GitHub's molibra-<sha>/ folder
    if (!rel) continue;
    const out = join(dest, rel);
    if (type === '5') mkdirSync(out, { recursive: true });
    else if (type === '0' || type === '\0') {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, body);
    }
  }
}

function npmCli() {
  const bin = dirname(process.execPath);
  for (const p of [join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (existsSync(p)) return p;
  }
  throw new Error('npm is missing from this Node.js');
}

/** Build `commit` beside the running code; the caller swaps it in. */
async function buildApp(commit) {
  log(`fetching Molibra ${commit.slice(0, 7)}`);
  const stage = join(ROOT, 'app-new');
  rmSync(stage, { recursive: true, force: true });
  const r = await fetch(`https://codeload.github.com/BaronOdon/molibra/tar.gz/${commit}`,
    { signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  untar(gunzipSync(Buffer.from(await r.arrayBuffer())), stage);
  const npm = spawnSync(process.execPath, [npmCli(), 'ci', '--omit=dev', '--no-audit', '--no-fund',
    '--loglevel=error'], { cwd: stage, encoding: 'utf8', timeout: 600_000 });
  if (npm.status !== 0) throw new Error(`npm ci failed: ${(npm.stderr || npm.stdout || '').slice(0, 300)}`);
  writeFileSync(join(stage, 'COMMIT'), commit + '\n');
  return stage;
}

function swapIn(stage) {
  const old = join(ROOT, 'app-old');
  rmSync(old, { recursive: true, force: true });
  if (existsSync(APP)) renameSync(APP, old);
  renameSync(stage, APP);
  rmSync(old, { recursive: true, force: true });
  log(`Molibra ${installedCommit()?.slice(0, 7)} is now installed`);
  return refreshSelf();
}

/**
 * The supervisor and its window live OUTSIDE app/, so updating the code did
 * not update them: an installed 1.0.0 would have kept its first-day launcher
 * forever. The repository tarball carries both, so copy them across when they
 * differ. Returns true when the supervisor itself changed and must restart.
 */
function refreshSelf() {
  let restart = false;
  for (const name of ['molibra-miner.mjs', 'status.html']) {
    const src = join(APP, 'installers', 'launcher', name);
    const dst = join(ROOT, name);
    try {
      const fresh = readFileSync(src);
      let current = null;
      try { current = readFileSync(dst); } catch { /* first time */ }
      if (!current || !fresh.equals(current)) {
        writeFileSync(dst, fresh);
        log(`${name} updated`);
        if (name === 'molibra-miner.mjs') restart = true;
      }
    } catch { /* this version does not ship it */ }
  }
  return restart;
}

/** Restart this supervisor on its new code, the way each platform allows. */
async function restartSelf() {
  log('restarting the supervisor on its new version');
  await stopNode();
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

/* ------------------------------------------------------------- the window */

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
    // It keeps mining until they log out; the boot task takes over after that.
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

/* ------------------------------------------------------------ the wallet */

function readConfig() {
  return JSON.parse(readFileSync(CONFIG, 'utf8'));
}

function init(address) {
  let miner = (address ?? '').trim();
  let created = false;
  if (!miner && existsSync(CONFIG)) miner = readConfig().miner ?? '';
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
  writeFileSync(CONFIG, JSON.stringify({ miner, peers: PEERS, port: PORT }, null, 2));
  const summary = { miner, created, walletFile: created ? WALLET : null, status: `http://127.0.0.1:${PORT}/molibra/miner` };
  writeFileSync(join(ROOT, 'install-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}

/* ------------------------------------------------------ what is happening */

/**
 * The supervisor's own account of itself, served on STATUS_PORT from the first
 * second it runs - BEFORE any update or chain load. The node's RPC only exists
 * once the chain is loaded, so a status window that asked the node first
 * showed "refused to connect" to every new user (found on the first real
 * install, 25 Sep 2026). This always has something true to say.
 */
const STATUS_PORT = 20227;
const status = {
  phase: 'starting', detail: 'Starting the miner…', error: null,
  height: null, networkHeight: null, mining: false,
  minedThisSession: [], startedAt: new Date().toISOString(), commit: null, miner: null,
};
function phase(p, detail) {
  status.phase = p;
  status.detail = detail;
  if (p !== 'problem') status.error = null;
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
    phase('mining', 'Up to date with the network and mining to your wallet.');
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
  const server = statusServer = createServer((req, res) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (req.url.startsWith('/status')) {
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

/* ------------------------------------------------------------- the node */

let child = null;
function startNode() {
  const cfg = readConfig();
  status.miner = cfg.miner;
  status.commit = installedCommit();
  status.mining = false;
  phase('loading', 'Loading this computer\'s copy of the chain…');
  const out = createWriteStream(join(LOGS, 'node.log'), { flags: 'a' });
  child = spawn(process.execPath, [join('src', 'cli.js'), 'node', '--host', '127.0.0.1',
    '--port', String(cfg.port ?? PORT), '--datadir', join(ROOT, 'data'),
    '--peers', cfg.peers ?? PEERS, '--miner', cfg.miner, '--mine'],
  { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
  log(`node started (pid ${child.pid}), mining to ${cfg.miner}`);
  const me = child;
  child.on('exit', (code) => {
    if (child !== me) return;           // replaced on purpose by an update
    child = null;
    status.mining = false;
    status.error = status.error ?? `the node stopped (exit ${code})`;
    phase('problem', 'The miner stopped unexpectedly and restarts by itself in 30 seconds.');
    log(`node stopped (exit ${code}); restarting in 30s`);
    setTimeout(startNode, 30_000);
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

async function updateIfNeeded({ running }) {
  const want = await wantedCommit();
  if (!want || want === installedCommit()) return false;
  if (!running) phase('updating', 'Downloading the latest version of the Molibra software…');
  const stage = await buildApp(want);          // the node keeps mining meanwhile
  if (running) await stopNode();
  return swapIn(stage) ? 'restart' : true;     // 'restart': the supervisor itself changed
}

/* ------------------------------------------------------------------ main */

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'init') {
    init(arg);
  } else if (cmd === 'window') {
    await openWindow();
  } else if (cmd === 'taskxml') {
    // Windows only. The scheduled task, as the XML Task Scheduler reads: S4U
    // (runs whether or not the user is logged on, stores no password), boot
    // trigger, no time limit, restart on failure, below-normal priority, and
    // node.exe run directly - no script host in between. UTF-16LE with a BOM,
    // because that is the encoding the declaration names and schtasks expects.
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
    if (!(await updateIfNeeded({ running: false }))) log(`already current (${installedCommit()?.slice(0, 7)})`);
  } else {
    // ⛔ One supervisor at a time: a second copy would run a second node on the
    //    same data. The lock is the STATUS PORT, not a PID file: after a reboot
    //    the PID in a stale file can belong to an unrelated program, and a miner
    //    that trusted it would decide it was "already running" and never start.
    if (await statusUp()) { log('another supervisor is already running'); process.exit(0); }
    writeFileSync(join(ROOT, 'supervisor.pid'), String(process.pid));
    startStatusServer();
    try { setPriority(process.pid, LOW); } catch { /* best effort */ }
    log('Molibra Miner supervisor starting');
    try { status.miner = readConfig().miner; } catch { /* reported below */ }
    let restart = refreshSelf();                 // an install older than its app/
    if (!installedCommit()) {
      restart = swapIn(await buildApp(await wantedCommit() ?? (() => { throw new Error('cannot learn which version to install'); })())) || restart;
    } else {
      restart = (await updateIfNeeded({ running: false }).catch((e) => { log(`update skipped: ${e.message}`); return false; })) === 'restart' || restart;
    }
    if (restart) await restartSelf();
    startNode();
    setInterval(() => {
      updateIfNeeded({ running: true })
        .then(async (changed) => { if (changed === 'restart') await restartSelf(); else if (changed) startNode(); })
        .catch((e) => { log(`update failed, still on the old version: ${e.message}`); if (!child) startNode(); });
    }, UPDATE_EVERY_MS);
    const bye = async () => { await stopNode(); process.exit(0); };
    process.on('SIGTERM', bye);
    process.on('SIGINT', bye);
  }
} catch (e) {
  log(`FATAL: ${e.message}`);
  process.exit(1);
}
