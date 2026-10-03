/**
 * Molibra - everything needed to return one bMOLI transfer, built and checked.
 * CLIENT-SIDE ONLY (a mining node makes no outbound HTTP).
 *
 * Shared by scripts-inbound/prove-return.mjs (the operator, by hand) and
 * bots/bridge-bot.mjs (the header bot), so both emit the same payloads from
 * the same checks:
 *
 *   1. the receipts trie is rebuilt from every receipt in the block and must
 *      equal the block's own receiptsRoot (src/ethreceipts.js);
 *   2. ⛔ that block's receiptsRoot AND hash are read again from every
 *      cross-check RPC, which must be independent providers. Any disagreement
 *      throws RpcDisagreement and nothing is emitted: the root is the one input
 *      consensus takes on trust, so it is never taken from one source alone;
 *   3. the proof is run through `proveReturn`, the exact function consensus
 *      runs, so what is emitted has already passed the rule it will meet.
 */
import { receiptProof } from './ethreceipts.js';
import { encodeHeaderCommit } from './bridgemint.js';
import { proveReturn, encodeMoliReturn, returnKey, ETH_CHAIN_ID } from './molireturn.js';

export class RpcDisagreement extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'RpcDisagreement';
    this.details = details;
  }
}

/**
 * @param {object}   o
 * @param {Function} o.rpc        primary Ethereum caller (method, params) => result
 * @param {Array<{name: string, rpc: Function}>} [o.cross]  independent callers
 * @param {string}   o.ethTxHash  the Ethereum tx that sent bMOLI to the vault
 */
export async function buildReturn({ rpc, cross = [], ethTxHash }) {
  const p = await receiptProof(rpc, ethTxHash);
  const tag = '0x' + p.blockNumber.toString(16);
  const checked = [];
  for (const c of cross) {
    const b = await c.rpc('eth_getBlockByNumber', [tag, false]);
    const root = String(b?.receiptsRoot ?? '').toLowerCase();
    const hash = String(b?.hash ?? '').toLowerCase();
    if (root !== p.receiptsRoot || hash !== String(p.blockHash).toLowerCase()) {
      throw new RpcDisagreement(
        `Ethereum block ${p.blockNumber}: ${c.name} says root ${root || '(none)'} hash ${hash || '(none)'}, `
        + `the primary says root ${p.receiptsRoot} hash ${p.blockHash}. Nothing is emitted.`,
        { blockNumber: p.blockNumber.toString(), primary: { root: p.receiptsRoot, hash: p.blockHash },
          [c.name]: { root, hash } });
    }
    checked.push(c.name);
  }
  const { bySender, total } = proveReturn({ receiptsRoot: p.receiptsRoot, txIndex: p.txIndex, proof: p.proof });
  return {
    ethTxHash: String(ethTxHash).toLowerCase(),
    blockNumber: p.blockNumber,
    txIndex: p.txIndex,
    blockHash: p.blockHash,
    receiptsRoot: p.receiptsRoot,
    proof: p.proof,
    bySender,
    total,
    key: returnKey(p.blockNumber, p.txIndex),
    crossChecked: checked,
    commitData: encodeHeaderCommit({
      originChainId: ETH_CHAIN_ID, blockNumber: p.blockNumber, receiptsRoot: p.receiptsRoot,
    }),
    returnData: encodeMoliReturn({ blockNumber: p.blockNumber, txIndex: p.txIndex, proof: p.proof }),
  };
}
