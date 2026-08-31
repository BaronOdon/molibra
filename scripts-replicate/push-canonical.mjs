/**
 * Replicate the canonical chain onto another node.
 *
 * ⛔ The chain on THIS machine is canonical. Moving to another node means
 * REPLICATING FIRST - never promoting an empty node and letting the history
 * go. See the skill `preserve-operator-value`.
 *
 * This pushes every block outbound to the target's public /molibra/submit-block,
 * so it needs no inbound reachability, no tunnel and no file copy. The target
 * verifies each block itself; nothing here asks it to take anything on trust.
 *
 * The target may already have a lighter chain of its own. That is fine and is
 * the point: once the pushed branch carries more work, the target reorgs onto
 * it by its own fork-choice rule. We do not tell it which chain to prefer; we
 * give it the blocks and let it decide.
 *
 *   node scripts-replicate/push-canonical.mjs http://host:8545 [--from N]
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Chain } from '../src/chain.js';
import { serializeBlock } from '../src/block.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts-replicate/push-canonical.mjs http://host:8545 [--from N]');
  process.exit(1);
}
const fromArg = process.argv.indexOf('--from');
let start = fromArg > 0 ? BigInt(process.argv[fromArg + 1]) : 1n;

const post = async (path, body) => {
  const r = await fetch(target + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const head = async () => {
  const r = await fetch(target + '/molibra');
  const j = await r.json();
  return { height: BigInt(j.height), td: BigInt(j.totalDifficulty) };
};

console.log('loading the canonical chain from disk…');
const chain = await new Chain(Chain.loadGenesis(join(ROOT, 'genesis.json')), join(ROOT, 'data')).init();
console.log(`  local height ${chain.height}, totalDifficulty ${chain.head.totalDifficulty}`);

const before = await head();
console.log(`  target height ${before.height}, totalDifficulty ${before.td}`);
if (before.td >= chain.head.totalDifficulty) {
  console.log('the target already carries at least as much work; nothing to replicate.');
  process.exit(0);
}

let sent = 0;
let refused = 0;
const t0 = Date.now();
for (let n = start; n <= chain.height; n++) {
  const block = chain.blockByNumber(n);
  if (!block) { console.error(`  missing block ${n} locally - stopping`); break; }
  const { status, body } = await post('/molibra/submit-block', { block: serializeBlock(block) });
  if (status === 200) sent++;
  else {
    refused++;
    // The first few may be refused as duplicates of the target's own genesis
    // branch; a sustained run of refusals is a real problem, so say so.
    if (refused <= 3 || refused % 250 === 0) {
      console.error(`  block ${n} refused (${status}): ${body.error ?? ''}`);
    }
    if (refused > 50 && sent === 0) {
      console.error('nothing is being accepted - stopping rather than hammering the node');
      break;
    }
  }
  if (n % 500n === 0n) {
    const now = await head();
    const rate = sent / ((Date.now() - t0) / 1000);
    console.log(`  ${n}/${chain.height}  target now at ${now.height}  (${rate.toFixed(1)} blk/s)`);
  }
}

const after = await head();
console.log(`\nsent ${sent}, refused ${refused}`);
console.log(`target: height ${before.height} -> ${after.height}, td ${before.td} -> ${after.td}`);
console.log(after.td >= chain.head.totalDifficulty
  ? '✅ the target now carries the canonical chain'
  : '⚠ the target has NOT adopted it - do not switch anything over yet');
