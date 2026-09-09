/**
 * Timestamp the Molibra anchor digest into Bitcoin, via OpenTimestamps.
 *
 *   node ots-stamp.mjs --height 46140 --hash 0x9b2b... --work 61803156786
 *   node ots-stamp.mjs --upgrade            complete proofs whose calendars have confirmed
 *   node ots-stamp.mjs --list               what has been stamped and what is still pending
 *
 * ## Why Bitcoin as well as Ethereum, and what the difference is
 *
 * The Ethereum anchor is ENFORCING: nodes read `MolibraAnchor` and refuse to
 * reorg below the height it names. This is EVIDENTIARY: it produces a file that
 * anyone can check, years later, against Bitcoin's own headers, without trusting
 * us, our contract, or this code. Two independent proof systems make the audit
 * argument much harder to wave away, and this chain exists to be audited.
 *
 * ⛔ Do NOT wire this into consensus. Nodes take their floor from Ethereum,
 * which they can read directly. A Bitcoin proof cannot be checked on-chain here
 * without an SPV header client, and adding one to chase a second enforcing
 * anchor would buy a great deal of surface for very little.
 *
 * ## Why it costs nothing
 *
 * OpenTimestamps calendars aggregate digests from everybody into one Merkle
 * tree and commit the root in a single Bitcoin transaction. Our stamp rides in
 * that tree, so the marginal cost is zero. Publishing our own OP_RETURN instead
 * would cost roughly $58/year at the 1 sat/vB floor - and Bitcoin fees are the
 * most volatile number in the whole plan, so that figure should not be relied
 * on. Free and standard beats cheap and bespoke.
 *
 * ## ⛔ Stamp the SAME bytes Ethereum commits to
 *
 * The digest comes from `anchorDigest()` in src/anchor.js - the identical
 * encoder the contract's `digest()` re-implements and the test harness runs both
 * ways against each other. A second digest format would be a second thing to
 * get wrong, and the whole value of a second witness is that it attests to the
 * same fact.
 *
 * ## ⛔ A stamp is not finished when it is submitted
 *
 * The calendars return a PENDING proof: a path from our digest to a commitment
 * they promise to publish. It becomes a Bitcoin proof only once that
 * commitment is confirmed, typically within an hour or two. Until then the file
 * proves nothing about Bitcoin, and saying otherwise would be a claim rather
 * than evidence. `--upgrade` is what completes it, and it is a separate run for
 * exactly that reason.
 *
 * No dependencies: the calendar protocol is an HTTP POST of 32 raw bytes, and
 * the .ots container is assembled here. The repo runs on two dependencies and
 * this does not add a third.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { anchorDigest } from './src/anchor.js';
import { fromHex, toHex } from './src/crypto.js';

/**
 * ⛔ What the .ots file declares must be TRUE, or the proof attests to
 * something other than what we stamped.
 *
 * A detached OpenTimestamps proof says "the <op> of the original data is this
 * digest". `anchorDigest()` is Keccak-256, and OTS has no Keccak file-hash op -
 * so stamping the Keccak digest while declaring OP_SHA256 would be a false
 * statement that standard tooling could never reproduce. Instead the datum we
 * stamp is SHA-256 OF the anchor digest bytes, which makes the declaration
 * exactly true and lets any verifier reconstruct it:
 *
 *     sha256( keccak256("molibra:anchor:v1" ‖ hash ‖ height ‖ work ) )
 *
 * Both values are recorded in the sidecar JSON so the chain from anchor to
 * proof is reproducible without this script.
 */
const sha256 = (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) =>
  a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') === false ? all[i + 1] : true]] : []));

const OUT_DIR = args.dir ?? join(HERE, 'timestamps');

/**
 * The public calendars. More than one on purpose: each is an independent
 * promise to publish, and a stamp that rides in several trees survives any one
 * of them going away. They are not trusted - a calendar that lies produces a
 * proof that simply fails to verify against Bitcoin.
 */
const CALENDARS = [
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
  'https://finney.calendar.eternitywall.com',
  'https://btc.calendar.catallaxy.com',
];

// --- the .ots container ------------------------------------------------------
// Format per the OpenTimestamps specification. Written out rather than pulled
// in, because it is about thirty lines and the alternative is a dependency.
const MAGIC = new Uint8Array([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d,
  0x70, 0x73, 0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2,
  0xe8, 0x84, 0xe8, 0x92, 0x94,
]);
const VERSION = 1;
const OP_SHA256 = 0x08;
const SEPARATOR = 0xff;
/** Tag identifying an attestation the calendar has not yet published. */
const PENDING_TAG = '83dfe30d2ef90c8e';
/** Tag identifying an attestation committed to a Bitcoin block. */
const BITCOIN_TAG = '0588960d73d71901';

/** Base-128 varuint, low group first, high bit as the continuation flag. */
function varuint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Uint8Array.from(out);
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * Assemble the detached proof: magic, version, the hash op and digest that the
 * proof is ABOUT, then each calendar's returned path.
 *
 * ⛔ Branches are separated by 0xff before every fragment except the last. Put
 * the separator after the last one and the parser reads a branch that is not
 * there; omit it between two and the second is read as a continuation of the
 * first. Neither fails loudly - both produce a file that verifies as something
 * other than what was stamped.
 */
function assembleOts(digest, fragments) {
  const parts = [MAGIC, varuint(VERSION), Uint8Array.from([OP_SHA256]), digest];
  fragments.forEach((frag, i) => {
    if (i < fragments.length - 1) parts.push(Uint8Array.from([SEPARATOR]));
    parts.push(frag);
  });
  return concat(...parts);
}

/** True once the proof carries a Bitcoin attestation rather than only pending ones. */
function isComplete(ots) {
  return toHex(ots).slice(2).includes(BITCOIN_TAG);
}

async function submit(calendar, digest) {
  const r = await fetch(`${calendar}/digest`, {
    method: 'POST',
    body: digest,
    headers: {
      'Content-Type': 'application/octet-stream',
      Accept: 'application/vnd.opentimestamps.v1',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = new Uint8Array(await r.arrayBuffer());
  if (body.length === 0) throw new Error('empty response');
  return body;
}

// --- commands ----------------------------------------------------------------

async function stamp() {
  const height = args.height;
  const blockHash = args.hash;
  const cumulativeWork = args.work;
  if (!height || !blockHash || !cumulativeWork) {
    throw new Error('need --height, --hash and --work (all three from ONE read of /molibra)');
  }
  // ⛔ The same encoder the Ethereum contract commits to. Not a re-implementation.
  const anchorHex = anchorDigest({ height, blockHash, cumulativeWork });
  const digest = sha256(fromHex(anchorHex));
  const digestHex = toHex(digest);
  console.log(`anchor         : height ${height}`);
  console.log(`anchor digest  : ${anchorHex}   (keccak256, as Ethereum stores)`);
  console.log(`stamped digest : ${digestHex}   (sha256 of the above)`);

  const fragments = [];
  for (const c of CALENDARS) {
    try {
      const frag = await submit(c, digest);
      fragments.push(frag);
      console.log(`  ✓ ${new URL(c).host}  ${frag.length} bytes`);
    } catch (error) {
      // ⛔ One calendar refusing is not a failure: the stamp rides in whichever
      //    trees accepted it. Zero accepting IS a failure, and is caught below.
      const parts = [error.message];
      for (let e = error.cause; e; e = e.cause) parts.push(e.code ?? e.message);
      console.warn(`  ⛔ ${new URL(c).host}  ${parts.filter(Boolean).join(' <- ')}`);
    }
  }
  if (fragments.length === 0) throw new Error('no calendar accepted the digest - nothing stamped');

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const ots = assembleOts(digest, fragments);
  const file = join(OUT_DIR, `molibra-${height}.ots`);
  writeFileSync(file, ots);
  writeFileSync(join(OUT_DIR, `molibra-${height}.json`), JSON.stringify({
    height: String(height), blockHash, cumulativeWork: String(cumulativeWork),
    anchorDigest: anchorHex, digest: digestHex, digestAlgorithm: 'sha256(keccak256)',
    calendars: fragments.length,
    stampedAt: new Date().toISOString(), complete: false,
  }, null, 2));

  console.log(`\nwrote ${file}  (${ots.length} bytes, ${fragments.length} calendar(s))`);
  console.log('⛔ PENDING - this proves nothing about Bitcoin yet. The calendars publish');
  console.log('   their commitment within an hour or two; run --upgrade after that.');
}

async function upgrade() {
  if (!existsSync(OUT_DIR)) { console.log('nothing stamped yet'); return; }
  const pending = readdirSync(OUT_DIR).filter((f) => f.endsWith('.ots'))
    .filter((f) => !isComplete(readFileSync(join(OUT_DIR, f))));
  if (pending.length === 0) { console.log('no pending proofs'); return; }

  for (const f of pending) {
    const meta = JSON.parse(readFileSync(join(OUT_DIR, f.replace('.ots', '.json')), 'utf8'));
    let upgraded = false;
    for (const c of CALENDARS) {
      try {
        const r = await fetch(`${c}/timestamp/${meta.digest.replace(/^0x/, '')}`, {
          headers: { Accept: 'application/vnd.opentimestamps.v1' },
          signal: AbortSignal.timeout(30000),
        });
        // 404 is the ordinary "not published yet" answer, not an error.
        if (r.status === 404) continue;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = new Uint8Array(await r.arrayBuffer());
        if (!toHex(body).slice(2).includes(BITCOIN_TAG)) continue;
        writeFileSync(join(OUT_DIR, f), assembleOts(fromHex(meta.digest), [body]));
        writeFileSync(join(OUT_DIR, f.replace('.ots', '.json')),
          JSON.stringify({ ...meta, complete: true, upgradedAt: new Date().toISOString() }, null, 2));
        console.log(`✓ ${f} upgraded from ${new URL(c).host} - now attests to a Bitcoin block`);
        upgraded = true;
        break;
      } catch { /* try the next calendar */ }
    }
    if (!upgraded) console.log(`· ${f} still pending`);
  }
}

function list() {
  if (!existsSync(OUT_DIR)) { console.log('nothing stamped yet'); return; }
  const files = readdirSync(OUT_DIR).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) { console.log('nothing stamped yet'); return; }
  for (const f of files) {
    const m = JSON.parse(readFileSync(join(OUT_DIR, f), 'utf8'));
    const done = isComplete(readFileSync(join(OUT_DIR, f.replace('.json', '.ots'))));
    console.log(`${done ? '✓ bitcoin ' : '· pending '} height ${String(m.height).padStart(8)}  ${m.stampedAt}`);
  }
}

try {
  if (args.upgrade) await upgrade();
  else if (args.list) list();
  else await stamp();
} catch (error) {
  const parts = [error.message];
  for (let e = error.cause; e; e = e.cause) parts.push(e.code ?? e.message);
  console.error(`[ots-stamp] ${parts.filter(Boolean).join(' <- ')}`);
  process.exitCode = 1;
}
