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

/* ------------------------------------------------------------- the node */

let child = null;
function startNode() {
  const cfg = readConfig();
  const out = createWriteStream(join(LOGS, 'node.log'), { flags: 'a' });
  child = spawn(process.execPath, [join('src', 'cli.js'), 'node', '--host', '127.0.0.1',
    '--port', String(cfg.port ?? PORT), '--datadir', join(ROOT, 'data'),
    '--peers', cfg.peers ?? PEERS, '--miner', cfg.miner, '--mine'],
  { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  try { setPriority(child.pid, LOW); } catch { /* best effort */ }
  writeFileSync(join(ROOT, 'node.pid'), String(child.pid));
  log(`node started (pid ${child.pid}), mining to ${cfg.miner}`);
  const me = child;
  child.on('exit', (code) => {
    if (child !== me) return;           // replaced on purpose by an update
    child = null;
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
  const stage = await buildApp(want);          // the node keeps mining meanwhile
  if (running) await stopNode();
  swapIn(stage);
  return true;
}

/* ------------------------------------------------------------------ main */

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'init') {
    init(arg);
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
    // ⛔ One supervisor at a time: a second copy would run a second node on the same data.
    const lock = join(ROOT, 'supervisor.pid');
    try {
      const other = Number(readFileSync(lock, 'utf8'));
      if (other && other !== process.pid) { process.kill(other, 0); log(`already running (pid ${other})`); process.exit(0); }
    } catch { /* no lock, or its process is gone */ }
    writeFileSync(lock, String(process.pid));
    try { setPriority(process.pid, LOW); } catch { /* best effort */ }
    log('Molibra Miner supervisor starting');
    if (!installedCommit()) swapIn(await buildApp(await wantedCommit() ?? (() => { throw new Error('cannot learn which version to install'); })()));
    else await updateIfNeeded({ running: false }).catch((e) => log(`update skipped: ${e.message}`));
    startNode();
    setInterval(() => {
      updateIfNeeded({ running: true })
        .then((changed) => { if (changed) startNode(); })
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
