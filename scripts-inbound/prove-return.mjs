/**
 * Molibra - build a MOLI return from a REAL bMOLI transfer on Ethereum.
 *
 * Given the Ethereum hash of a transaction that sent bMOLI to the keyless
 * return vault, this produces the two payloads Molibra needs to release MOLI:
 *
 *     HEADER_COMMIT   the block's receiptsRoot - signed by the header
 *                     authority (the operator), and only by them
 *     MOLI_RETURN     the Merkle-Patricia proof - signed by ANYONE; the MOLI
 *                     goes to the sender the proof names, not to the signer
 *
 * ⛔⛔ It verifies before it emits: the receipts trie is rebuilt from every
 * receipt in the block and checked against the real header (src/ethreceipts.js),
 * then the exact consensus check (`proveReturn`) runs over the proof, and the
 * outstanding balance is read from a live node - so what is printed has
 * already passed every rule it will meet on chain.
 *
 *   node scripts-inbound/prove-return.mjs <ethTxHash>
 */

import { ethRpc, receiptProof } from '../src/ethreceipts.js';
import { encodeHeaderCommit } from '../src/bridgemint.js';
import {
  proveReturn, encodeMoliReturn, returnKey, MOLI_RETURN_ADDRESS, BMOLI_CONTRACT,
  ETH_HEADER_AUTHORITY, BRIDGE_V2_ACTIVATION,
} from '../src/molireturn.js';

const NODE = process.env.MOLIBRA_NODE ?? 'https://molibra.org';
const TX = process.argv[2];
if (!/^0x[0-9a-fA-F]{64}$/.test(TX ?? '')) {
  console.error('usage: node scripts-inbound/prove-return.mjs <ethTxHash>');
  process.exit(2);
}

const fmt = (wei) => (Number(wei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 });

console.log('Molibra - proving a bMOLI return\n');
console.log(`vault   ${MOLI_RETURN_ADDRESS}  (keyless)`);
console.log(`bMOLI   ${BMOLI_CONTRACT}\n`);

const p = await receiptProof(ethRpc(process.env.ETH_RPC ? [process.env.ETH_RPC] : undefined), TX);
console.log(`Ethereum block ${p.blockNumber}, index ${p.txIndex}`);
console.log(`receiptsRoot   ${p.receiptsRoot}  ⭐ rebuilt and MATCHES the header\n`);

const { bySender, total } = proveReturn({ receiptsRoot: p.receiptsRoot, txIndex: p.txIndex, proof: p.proof });
console.log('proved by the same code consensus runs:');
for (const [from, amount] of bySender) console.log(`  ${fmt(amount)} MOLI back to ${from}`);

const status = await (await fetch(NODE + '/molibra')).json();
const outstanding = BigInt(status.outbound?.outstanding ?? status.outbound?.burned ?? 0);
const height = BigInt(status.height);
console.log(`\nnode ${NODE}: height ${height}, outstanding ${fmt(outstanding)} MOLI`);
if (total > outstanding) {
  console.error(`\n⛔ ${fmt(total)} is more than the ${fmt(outstanding)} outstanding: consensus will refuse it.`);
  process.exit(1);
}
if (height < BRIDGE_V2_ACTIVATION) {
  console.log(`⚠ returns are honoured from block ${BRIDGE_V2_ACTIVATION}; `
    + `${BRIDGE_V2_ACTIVATION - height} blocks to go. Submitted earlier, the return is ordinary data and moves nothing.`);
}

const commit = encodeHeaderCommit({ originChainId: 1n, blockNumber: p.blockNumber, receiptsRoot: p.receiptsRoot });
const ret = encodeMoliReturn({ blockNumber: p.blockNumber, txIndex: p.txIndex, proof: p.proof });
console.log(`\n=== 1. HEADER_COMMIT — signed by ${ETH_HEADER_AUTHORITY} only ===\n${commit}`);
console.log(`\n=== 2. MOLI_RETURN — signed by anyone (${(ret.length - 2) / 2} bytes) ===\n${ret}`);
console.log(`\nreturn key ${returnKey(p.blockNumber, p.txIndex)}`);
console.log(`\npage: ${NODE}/molibra/return?commit=${commit}&ret=${ret}`);
