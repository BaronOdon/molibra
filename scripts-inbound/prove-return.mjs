/**
 * Molibra - build a MOLI return from a REAL bMOLI transfer on Ethereum.
 *
 * Given the Ethereum hash of a transaction that sent bMOLI to the keyless
 * return vault, this produces the two payloads Molibra needs to release MOLI:
 *
 *     HEADER_COMMIT   the block's receiptsRoot - signed by the header
 *                     authority (the operator), or from the header-bot flag
 *                     day by the header bot, whose roots are capped
 *     MOLI_RETURN     the Merkle-Patricia proof - signed by ANYONE; the MOLI
 *                     goes to the sender the proof names, not to the signer
 *
 * ⛔⛔ It verifies before it emits (src/returnproof.js, shared with the bridge
 * bot): the receipts trie is rebuilt and checked against the real header, the
 * block's root is re-read from an independent RPC, the exact consensus check
 * (`proveReturn`) runs over the proof, and the outstanding balance is read from
 * a live node - so what is printed has already passed every rule it will meet.
 *
 *   node scripts-inbound/prove-return.mjs <ethTxHash>
 *   ETH_RPC=… ETH_CROSS_RPC=… node scripts-inbound/prove-return.mjs <ethTxHash>
 */

import { ethRpc } from '../src/ethreceipts.js';
import { buildReturn } from '../src/returnproof.js';
import {
  MOLI_RETURN_ADDRESS, BMOLI_CONTRACT, ETH_HEADER_AUTHORITY, BRIDGE_V2_ACTIVATION,
} from '../src/molireturn.js';

const NODE = process.env.MOLIBRA_NODE ?? 'https://molibra.org';
const CROSS = process.env.ETH_CROSS_RPC ?? 'https://gateway.tenderly.co/public/mainnet';
const TX = process.argv[2];
if (!/^0x[0-9a-fA-F]{64}$/.test(TX ?? '')) {
  console.error('usage: node scripts-inbound/prove-return.mjs <ethTxHash>');
  process.exit(2);
}

const fmt = (wei) => (Number(wei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 });

console.log('Molibra - proving a bMOLI return\n');
console.log(`vault   ${MOLI_RETURN_ADDRESS}  (keyless)`);
console.log(`bMOLI   ${BMOLI_CONTRACT}\n`);

const r = await buildReturn({
  rpc: ethRpc(process.env.ETH_RPC ? [process.env.ETH_RPC] : undefined),
  cross: CROSS ? [{ name: CROSS, rpc: ethRpc([CROSS]) }] : [],
  ethTxHash: TX,
});
console.log(`Ethereum block ${r.blockNumber}, index ${r.txIndex}`);
console.log(`receiptsRoot   ${r.receiptsRoot}  ⭐ rebuilt and MATCHES the header`);
for (const c of r.crossChecked) console.log(`               ⭐ and ${c} reports the same block`);

console.log('\nproved by the same code consensus runs:');
for (const [from, amount] of r.bySender) console.log(`  ${fmt(amount)} MOLI back to ${from}`);

const status = await (await fetch(NODE + '/molibra')).json();
const outstanding = BigInt(status.outbound?.outstanding ?? status.outbound?.burned ?? 0);
const height = BigInt(status.height);
console.log(`\nnode ${NODE}: height ${height}, outstanding ${fmt(outstanding)} MOLI`);
if (r.total > outstanding) {
  console.error(`\n⛔ ${fmt(r.total)} is more than the ${fmt(outstanding)} outstanding: consensus will refuse it.`);
  process.exit(1);
}
if (height < BRIDGE_V2_ACTIVATION) {
  console.log(`⚠ returns are honoured from block ${BRIDGE_V2_ACTIVATION}; `
    + `${BRIDGE_V2_ACTIVATION - height} blocks to go. Submitted earlier, the return is ordinary data and moves nothing.`);
}

console.log(`\n=== 1. HEADER_COMMIT — signed by ${ETH_HEADER_AUTHORITY} (uncapped) ===\n${r.commitData}`);
console.log(`\n=== 2. MOLI_RETURN — signed by anyone (${(r.returnData.length - 2) / 2} bytes) ===\n${r.returnData}`);
console.log(`\nreturn key ${r.key}`);
console.log(`\npage: ${NODE}/molibra/return?commit=${r.commitData}&ret=${r.returnData}`);
