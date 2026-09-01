/**
 * The L2 header committer.
 *
 * ⛔ This script decides which chain a receipts root gets filed under. Getting
 * that wrong does not fail here — it fails much later, at somebody's claim,
 * with no clue why. So the checks are about the chain id, the confirmation
 * depth, and the payload round-tripping.
 *
 * Network is not required: the pure parts are tested offline, and the live
 * fetch is exercised by running the script.
 */

import { L2S, commitPayloadFor } from '../scripts-l2/commit-l2-header.mjs';
import { decodeHeaderCommit } from '../src/bridgemint.js';

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('L2 header commits\n');

/* -------------------------------------------------------- the registry */

// ⛔ Real chain ids, not plausible ones. A wrong id files a root against a
// chain nobody is watching.
const KNOWN = { ethereum: 1n, base: 8453n, optimism: 10n, arbitrum: 42161n, polygon: 137n, bsc: 56n };
for (const [name, id] of Object.entries(KNOWN)) {
  check(`${name} carries its real chain id`, L2S[name]?.chainId === id, `${L2S[name]?.chainId}`);
}
check('every entry has an RPC and a confirmation depth',
  Object.values(L2S).every((v) => typeof v.rpc === 'string' && v.confirmations > 0));
check('⛔ no two chains share an id',
  new Set(Object.values(L2S).map((v) => String(v.chainId))).size === Object.keys(L2S).length,
  'a collision would silently merge two chains\' headers');

// Optimistic rollups can reorganise; a root from a block that later vanishes
// is an attestation to something that never happened.
check('⛔ rollups wait longer than Ethereum does',
  L2S.base.confirmations > L2S.ethereum.confirmations
  && L2S.arbitrum.confirmations > L2S.ethereum.confirmations,
  'a reorged block makes the committed root a statement about nothing');

/* ---------------------------------------------------------- the payload */

const ROOT = '0x' + 'be'.repeat(32);
for (const [name, cfg] of Object.entries(L2S)) {
  const p = commitPayloadFor({ chainId: cfg.chainId, blockNumber: 12345n, receiptsRoot: ROOT });
  const d = decodeHeaderCommit(p);
  check(`a ${name} commit round-trips`,
    d.originChainId === cfg.chainId && d.blockNumber === 12345n && d.receiptsRoot === ROOT);
}

const a = commitPayloadFor({ chainId: 8453n, blockNumber: 1n, receiptsRoot: ROOT });
const b = commitPayloadFor({ chainId: 10n, blockNumber: 1n, receiptsRoot: ROOT });
check('⛔⛔ the same block number on two chains produces DIFFERENT payloads', a !== b,
  'if these matched, one chain\'s root could be filed as another\'s');

check('the payload is a fixed 100 bytes', (a.length - 2) / 2 === 100, `${(a.length - 2) / 2}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
