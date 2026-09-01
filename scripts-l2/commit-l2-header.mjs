/**
 * Molibra - commit an EVM L2's receipts root, so tokens there can cross.
 *
 *   node scripts-l2/commit-l2-header.mjs base            # latest, print the payload
 *   node scripts-l2/commit-l2-header.mjs base 50750472
 *   node scripts-l2/commit-l2-header.mjs --list
 *
 * ## Why this is all that was missing
 *
 * The inbound path is already chain-agnostic: `originChainId` is a parameter in
 * `claimKey`, `commitHeader`, `receiptsRootFor`, `foreignTokenId` and
 * `encodeBridgeRegister`, and nothing hardcodes Ethereum. `test/multichain.mjs`
 * proves it across six chains. Every L2 below uses Ethereum's RLP receipts
 * encoding and the same `Transfer` topic, so `burnproof.js` reads their
 * receipts unmodified.
 *
 * So supporting them needs **no consensus change**. What was missing is
 * somebody fetching their receipts roots and committing them. That is this
 * file, and it is a script rather than a contract because it holds no key and
 * decides nothing.
 *
 * ## ⛔⛔ What committing a root MEANS
 *
 * It is an attestation, not a proof. Whoever commits is asserting "chain C at
 * height H had this receipts root", and every claim against that root inherits
 * that assertion. Molibra verifies the Merkle path INTO the root; it cannot
 * verify the root itself without a light client for that chain.
 *
 * ⛔ Consensus already narrows who may do this: only an address that has
 * REGISTERED an asset on chain C may commit chain C's headers. Otherwise a new
 * chain id would be a free way to introduce a root nobody vouched for.
 *
 * ⛔ Prefer a FINALISED block. An optimistic rollup's recent blocks can be
 * reorganised, and a root committed from a block that later vanishes is an
 * attestation to something that never happened. `--confirmations` backs off
 * from the tip; the default is deliberately generous.
 */

import { encodeHeaderCommit } from '../src/bridgemint.js';

/**
 * The EVM chains whose receipts encoding Molibra's prover already reads.
 *
 * ⛔ Chain ids are the real ones and are checked at use: committing under the
 * wrong id would file a root against a chain nobody is watching, and the error
 * would only surface when a claim failed much later.
 */
export const L2S = {
  ethereum: { chainId: 1n, rpc: 'https://ethereum-rpc.publicnode.com', confirmations: 32 },
  base: { chainId: 8453n, rpc: 'https://mainnet.base.org', confirmations: 120 },
  optimism: { chainId: 10n, rpc: 'https://mainnet.optimism.io', confirmations: 120 },
  arbitrum: { chainId: 42161n, rpc: 'https://arb1.arbitrum.io/rpc', confirmations: 240 },
  polygon: { chainId: 137n, rpc: 'https://polygon-rpc.com', confirmations: 128 },
  bsc: { chainId: 56n, rpc: 'https://bsc-dataseed.binance.org', confirmations: 30 },
};

const NODE = process.env.MOLIBRA_NODE ?? 'http://193.123.191.142:8545';

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/**
 * Read a block's receipts root, and REFUSE if the chain does not identify
 * itself as the one expected.
 *
 * ⛔ An RPC endpoint can be repointed, mirrored, or simply wrong. Trusting the
 * name in a config file rather than asking the chain is how a root ends up
 * filed under a chain it did not come from.
 */
export async function receiptsRootOf(name, blockNumber = null) {
  const l2 = L2S[name];
  if (!l2) throw new Error(`unknown chain ${name} — try --list`);

  const reported = BigInt(await rpc(l2.rpc, 'eth_chainId', []));
  if (reported !== l2.chainId) {
    throw new Error(`${l2.rpc} reports chain ${reported}, not ${l2.chainId}. Refusing: a root `
      + 'filed under the wrong chain fails much later, at a claim, with no clue why.');
  }

  const tip = BigInt(await rpc(l2.rpc, 'eth_blockNumber', []));
  const target = blockNumber === null
    ? tip - BigInt(l2.confirmations)
    : BigInt(blockNumber);
  if (target < 0n) throw new Error('chain is shorter than the confirmation depth');
  if (target > tip) throw new Error(`block ${target} is past the tip ${tip}`);

  const block = await rpc(l2.rpc, 'eth_getBlockByNumber', ['0x' + target.toString(16), false]);
  if (!block || !block.receiptsRoot) throw new Error(`no receiptsRoot at ${name} block ${target}`);

  return {
    chain: name,
    chainId: l2.chainId,
    blockNumber: target,
    tip,
    behindTip: tip - target,
    receiptsRoot: block.receiptsRoot,
    blockHash: block.hash,
  };
}

/** The Molibra payload that commits it. */
export function commitPayloadFor({ chainId, blockNumber, receiptsRoot }) {
  return encodeHeaderCommit({ originChainId: chainId, blockNumber, receiptsRoot });
}

/* ------------------------------------------------------------------ cli */

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
    || process.argv[1].endsWith('commit-l2-header.mjs')) {
  const args = process.argv.slice(2);
  if (args.includes('--list') || args.length === 0) {
    console.log('chains Molibra can already read receipts from:\n');
    for (const [k, v] of Object.entries(L2S)) {
      console.log(`  ${k.padEnd(10)} chainId ${String(v.chainId).padEnd(7)} ` +
        `${v.confirmations} confirmations  ${v.rpc}`);
    }
    console.log('\n  node scripts-l2/commit-l2-header.mjs <chain> [block]');
    process.exit(0);
  }

  const name = args[0];
  const block = args[1] ? BigInt(args[1]) : null;
  const info = await receiptsRootOf(name, block);
  const payload = commitPayloadFor(info);

  console.log(`${info.chain} · chainId ${info.chainId}`);
  console.log(`  block         ${info.blockNumber}  (tip ${info.tip}, ${info.behindTip} behind)`);
  console.log(`  blockHash     ${info.blockHash}`);
  console.log(`  receiptsRoot  ${info.receiptsRoot}`);
  console.log(`\n  payload (${(payload.length - 2) / 2} bytes)\n  ${payload}`);
  console.log('\n⛔ Send this from an address that has REGISTERED an asset on that chain;');
  console.log('   consensus refuses a header commit from anyone else.');
  console.log('⛔ Address it to a CONTRACT, never to yourself: a wallet refuses calldata sent');
  console.log('   to an account it manages. Consensus is unaffected — the decoder runs before');
  console.log('   the EVM branch, so the destination is never called.');
  console.log('⛔ Set gas explicitly. eth_estimateGas cannot see a native payload.');
  console.log(`\n   Molibra node: ${NODE}`);
}
