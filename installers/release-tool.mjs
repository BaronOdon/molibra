/**
 * Molibra Miner release tool - makes the signed release every installed miner
 * follows (supervisor v4, 8 Oct 2026). Nothing here publishes: it writes
 * releases/miner-release.json, which reaches miners when the operator pushes
 * and the nodes pull.
 *
 *   node installers/release-tool.mjs keygen --out <key.pem>
 *        a new Ed25519 release key; prints its public half for RELEASE_SIGNERS.
 *        ⛔ The private key goes straight into the operator vault, never the repo.
 *   node installers/release-tool.mjs digest <commit>
 *        the tree digest of a commit, from git's own objects (no checkout, no
 *        line-ending conversion: the bytes GitHub serves).
 *   node installers/release-tool.mjs sign --commit <sha> --version 1.1.0 --seq <n>
 *        [--rollout-hours 48] [--mandatory-before <height>] [--min-launcher 4]
 *        [--notes "..."] (--key-file <pem> | --key-vault <name>) [--offline]
 *        builds the manifest, checks the digest against GitHub's archive of the
 *        same commit (skipped with --offline, before the commit is pushed),
 *        signs it and writes releases/miner-release.json.
 *   node installers/release-tool.mjs cosign --signer <id> (--key-file|--key-vault)
 *        adds another maintainer's signature to the existing release.
 *   node installers/release-tool.mjs verify [file]
 *        checks a release exactly as an installed miner does.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { generateKeyPairSync, createPrivateKey, sign as signRaw } from 'node:crypto';
import {
  RELEASE_SIGNERS, RELEASE_THRESHOLD, releaseMessage, verifyRelease, tarFiles, treeDigest,
} from './launcher/molibra-miner.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'releases', 'miner-release.json');
const VAULT = 'C:/Users/Administrator/Desktop/Server Ops/vault.ps1';
const args = Object.fromEntries(process.argv.slice(3).flatMap((a, i, all) =>
  a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') === false ? all[i + 1] : true]] : []));
const git = (...a) => {
  const r = spawnSync('git', a, { cwd: REPO, encoding: 'buffer', maxBuffer: 512 * 2 ** 20 });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout;
};

/** Every regular file of `commit` as {path, body}, read from git objects (raw bytes). */
export function commitFiles(commit) {
  const list = git('ls-tree', '-r', '-z', '--full-tree', commit).toString('utf8').split('\0').filter(Boolean);
  const entries = [];
  for (const line of list) {
    const [meta, path] = line.split('\t');
    const [mode, type, sha] = meta.split(' ');
    if (type !== 'blob' || mode === '120000') continue;   // submodules and symlinks: not unpacked by the miner either
    entries.push({ path, sha });
  }
  // One git process for every blob.
  const out = spawnSync('git', ['cat-file', '--batch'], { cwd: REPO, input: entries.map((e) => e.sha).join('\n') + '\n',
    maxBuffer: 1024 * 2 ** 20 }).stdout;
  let off = 0;
  for (const e of entries) {
    const nl = out.indexOf(10, off);
    const size = Number(out.toString('utf8', off, nl).split(' ')[2]);
    e.body = out.subarray(nl + 1, nl + 1 + size);
    off = nl + 1 + size + 1;
  }
  return entries;
}

function privateKey() {
  if (args['key-file']) return createPrivateKey(readFileSync(args['key-file'], 'utf8'));
  if (args['key-vault']) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', VAULT, 'get', args['key-vault']],
      { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || !r.stdout.includes('PRIVATE KEY')) throw new Error(`vault has no key named ${args['key-vault']}`);
    return createPrivateKey(r.stdout.trim());
  }
  throw new Error('--key-file <pem> or --key-vault <name> is required');
}
/** The signer id whose public key this private key matches. */
function signerOf(key) {
  const x = key.export({ format: 'jwk' }).x;
  const id = Object.entries(RELEASE_SIGNERS).find(([, v]) => v === x)?.[0];
  if (!id) throw new Error(`this key (public ${x}) is not in RELEASE_SIGNERS`);
  return id;
}

async function githubDigest(commit) {
  const r = await fetch(`https://codeload.github.com/BaronOdon/molibra/tar.gz/${commit}`, { signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${commit} (is it pushed?)`);
  return treeDigest([...tarFiles(gunzipSync(Buffer.from(await r.arrayBuffer())))].filter((e) => !e.dir));
}

const cmd = process.argv[2];
if (cmd === 'keygen') {
  if (!args.out) throw new Error('--out <file.pem> is required');
  if (existsSync(args.out)) throw new Error(`${args.out} exists: refusing to overwrite a key`);
  const { publicKey, privateKey: priv } = generateKeyPairSync('ed25519');
  writeFileSync(args.out, priv.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(JSON.stringify({ publicKeyX: publicKey.export({ format: 'jwk' }).x, file: args.out }));
} else if (cmd === 'digest') {
  const commit = process.argv[3];
  console.log(treeDigest(commitFiles(commit)));
} else if (cmd === 'sign') {
  const commit = git('rev-parse', `${args.commit}^{commit}`).toString().trim();
  const tree = treeDigest(commitFiles(commit));
  if (!args.offline) {
    const gh = await githubDigest(commit);
    if (gh !== tree) throw new Error(`GitHub's archive of ${commit} digests to ${gh}, git's objects to ${tree}: refusing to sign`);
  }
  const seq = Number(args.seq);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('--seq must be a positive integer, higher than the last release');
  if (existsSync(OUT)) {
    const prev = JSON.parse(readFileSync(OUT, 'utf8')).manifest;
    if (prev && seq <= prev.seq) throw new Error(`--seq ${seq} must be higher than the published ${prev.seq}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(args.version ?? ''))) throw new Error('--version x.y.z is required');
  const manifest = {
    product: 'molibra-miner', version: String(args.version), seq, commit, tree,
    publishedAt: new Date().toISOString(),
    rollout: { hours: Number(args['rollout-hours'] ?? 48) },
    mandatory: args['mandatory-before'] ? { beforeHeight: Number(args['mandatory-before']) } : null,
    minLauncher: Number(args['min-launcher'] ?? 4),
    notes: String(args.notes ?? ''),
  };
  const key = privateKey();
  const doc = { manifest, signatures: [{ signer: signerOf(key), sig: signRaw(null, releaseMessage(manifest), key).toString('base64') }] };
  if (RELEASE_THRESHOLD <= 1) verifyRelease(doc);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
  console.log(`signed ${manifest.version} (seq ${seq}) = ${commit.slice(0, 7)} ${tree}; ${doc.signatures.length}/${RELEASE_THRESHOLD} signature(s) -> ${OUT}`);
} else if (cmd === 'cosign') {
  const doc = JSON.parse(readFileSync(OUT, 'utf8'));
  const key = privateKey();
  const id = signerOf(key);
  doc.signatures = [...(doc.signatures ?? []).filter((s) => s.signer !== id),
    { signer: id, sig: signRaw(null, releaseMessage(doc.manifest), key).toString('base64') }];
  writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
  console.log(`${id} signed; ${doc.signatures.length}/${RELEASE_THRESHOLD}`);
} else if (cmd === 'verify') {
  const m = verifyRelease(JSON.parse(readFileSync(process.argv[3] ?? OUT, 'utf8')));
  console.log(`valid: ${m.version} (seq ${m.seq}) = ${m.commit.slice(0, 7)} ${m.tree}`);
} else {
  console.log('usage: keygen | digest <commit> | sign ... | cosign ... | verify [file]  (see the header)');
}
