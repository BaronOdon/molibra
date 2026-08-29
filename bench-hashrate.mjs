// Measures single-core seal hashrate using the chain's own primitives, then
// reports what difficulty that implies at the 15 s target.
//
// Not a toy benchmark: it hashes exactly what mineHeader hashes, so the number
// is the real bound on how hard this network is to out-run.
//
//   node bench-hashrate.mjs [seconds]
import { keccak256, concatBytes, bigToBytes } from './src/crypto.js';

const SECONDS = Number(process.argv[2] ?? 5);
const TARGET_BLOCK_SECONDS = 15;

// A representative 32-byte seal digest; content is irrelevant to the rate.
const digest = keccak256(new TextEncoder().encode('molibra-benchmark-digest'));

let hashes = 0n;
let nonce = 0n;
const started = process.hrtime.bigint();
const deadline = started + BigInt(SECONDS) * 1_000_000_000n;

while (process.hrtime.bigint() < deadline) {
  // Batch so the clock read does not dominate the loop.
  for (let i = 0; i < 2000; i++) {
    keccak256(concatBytes(digest, bigToBytes(nonce)));
    nonce++;
  }
  hashes += 2000n;
}

const elapsedNs = Number(process.hrtime.bigint() - started);
const rate = Number(hashes) / (elapsedNs / 1e9);

const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

console.log(`single-core hashrate : ${fmt(rate)} H/s`);
console.log(`equilibrium difficulty at ${TARGET_BLOCK_SECONDS}s, per core:`);
for (const cores of [1, 2, 4, 5, 6]) {
  const d = rate * cores * TARGET_BLOCK_SECONDS;
  console.log(`  ${cores} core(s) : difficulty ~${fmt(d)}   (${fmt(rate * cores)} H/s total)`);
}
