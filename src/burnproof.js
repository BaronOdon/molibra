/**
 * Molibra - proving that a burn happened on Ethereum.
 *
 * `inbound.js` decides whether honouring a burn is PERMISSIBLE. This file
 * decides whether the burn HAPPENED. Both are necessary and neither
 * substitutes for the other; keeping them apart is why the accounting rules
 * are readable without reading any cryptography.
 *
 * ## What this proves, exactly
 *
 * Given a block's `receiptsRoot` and a Merkle-Patricia proof, it proves that a
 * particular transaction receipt is in that block, and reads the burn out of
 * it. That part is unconditional: every node in the proof is checked by its
 * own keccak256 hash, so a forged receipt cannot survive, and a proof that
 * does not reach the claimed root is refused rather than partially believed.
 *
 * ## ⛔ What this does NOT prove, stated here rather than discovered later
 *
 * It does not prove the `receiptsRoot` belongs to a canonical Ethereum block.
 * Ethereum is proof-of-stake; establishing canonicity means verifying sync
 * committee BLS signatures, which is a light client, not a function. So the
 * header is an INPUT with a declared trust model - see `HeaderSource` below -
 * and the honest description of this bridge is:
 *
 *     trustless    - that this receipt is in a block with this receiptsRoot
 *     trusted      - that a block with this receiptsRoot is canonical
 *
 * Anyone who says a bridge is "trustless" without saying which half they mean
 * is selling something. The two halves are separated here so the claim can be
 * made precisely.
 */

import { RLP } from '@ethereumjs/rlp';
import { keccak256, toHex, fromHex, normalizeAddress } from './crypto.js';

/** keccak256('Transfer(address,address,uint256)') - an ERC-20 burn is a
 *  Transfer to the zero address, which is what WSRO's `burn` emits. */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/* --------------------------------------------------------------- nibbles */

/** Bytes -> nibble array. A trie path is nibbles, never bytes. */
export function toNibbles(bytes) {
  const out = [];
  for (const b of bytes) out.push(b >> 4, b & 0x0f);
  return out;
}

/**
 * Ethereum's hex-prefix encoding. The first nibble carries two facts: whether
 * this node is a leaf or an extension, and whether the path has an odd number
 * of nibbles. Getting the odd-length case wrong is the classic way to write a
 * verifier that works on half its inputs.
 */
export function decodeHexPrefix(bytes) {
  const nibbles = toNibbles(bytes);
  const flag = nibbles[0];
  const isLeaf = flag >= 2;
  const odd = flag % 2 === 1;
  return { isLeaf, path: nibbles.slice(odd ? 1 : 2) };
}

/* ----------------------------------------------------------------- proof */

class ProofError extends Error {}

/**
 * Walk a Merkle-Patricia proof from `root` down to `key`, returning the value
 * stored there.
 *
 * @param {string}       root  0x hex, the receiptsRoot from the block header
 * @param {Uint8Array}   key   the trie key - for a receipts trie, rlp(txIndex)
 * @param {Uint8Array[]} nodes the proof, root node first
 * @returns {Uint8Array} the value at `key`
 * @throws {ProofError}  if any node fails its hash, or the path does not reach
 *                       the key. NEVER returns a partial or "probably" result.
 */
export function verifyProof(root, key, nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new ProofError('empty proof: nothing was proved');
  }
  const path = toNibbles(key);
  let expected = String(root).toLowerCase();
  let i = 0; // how far along `path` we are

  for (let depth = 0; depth < nodes.length; depth++) {
    const raw = nodes[depth];
    // ⛔ The whole security of this walk is here: every node must hash to what
    // its parent said it would. A verifier that skips this for the root, or
    // for embedded short nodes, proves nothing at all.
    const got = toHex(keccak256(raw));
    if (got !== expected) {
      throw new ProofError(
        `proof node ${depth} does not hash to the expected value: `
        + `expected ${expected}, got ${got}`);
    }

    const node = RLP.decode(raw);

    if (node.length === 17) {
      // Branch. Consume one nibble; the 17th slot is the value at this prefix.
      if (i === path.length) {
        const value = node[16];
        if (!value || value.length === 0) throw new ProofError('key ends at an empty branch');
        return value;
      }
      const next = node[path[i]];
      i += 1;
      if (!next || next.length === 0) throw new ProofError('key not present: empty branch slot');
      expected = toHex(next);
      continue;
    }

    if (node.length === 2) {
      const { isLeaf, path: segment } = decodeHexPrefix(node[0]);
      const remaining = path.slice(i);
      // The node's own path segment must be a prefix of what is left, or the
      // key simply is not in this trie.
      if (segment.length > remaining.length
          || segment.some((n, k) => n !== remaining[k])) {
        throw new ProofError('key not present: path diverges from the node');
      }
      i += segment.length;
      if (isLeaf) {
        if (i !== path.length) throw new ProofError('leaf reached with path left over');
        return node[1];
      }
      expected = toHex(node[1]);
      continue;
    }

    throw new ProofError(`malformed trie node with ${node.length} items`);
  }
  throw new ProofError('proof ended before reaching the key');
}

/* --------------------------------------------------------------- receipt */

/**
 * Decode a receipt, typed (EIP-2718) or legacy.
 *
 * A typed receipt is `type || rlp([...])`, NOT rlp of anything. Feeding the
 * whole thing to an RLP decoder yields garbage that sometimes parses, which is
 * worse than failing.
 */
export function decodeReceipt(bytes) {
  const typed = bytes.length > 0 && bytes[0] <= 0x7f;
  const body = typed ? bytes.slice(1) : bytes;
  const type = typed ? bytes[0] : 0;
  const [status, cumulativeGasUsed, logsBloom, logs] = RLP.decode(body);
  return {
    type,
    status: status.length === 0 ? 0 : Number(toHex(status)),
    cumulativeGasUsed: BigInt(toHex(cumulativeGasUsed) === '0x' ? '0x0' : toHex(cumulativeGasUsed)),
    logsBloom: toHex(logsBloom),
    logs: logs.map(([address, topics, data]) => ({
      address: normalizeAddress(toHex(address)),
      topics: topics.map((t) => toHex(t)),
      data: toHex(data),
    })),
  };
}

/** A 32-byte word as an address (the low 20 bytes). */
const topicToAddress = (topic) => normalizeAddress('0x' + String(topic).slice(-40));

/**
 * Find the burn in a receipt: a Transfer from somebody TO THE ZERO ADDRESS,
 * emitted by the expected token contract.
 *
 * ⛔ The contract address is checked. Without it, anybody could deploy their
 * own token, burn a billion of it, and present a perfectly valid proof of a
 * perfectly real burn of something worthless.
 */
export function findBurn(receipt, { contract }) {
  if (receipt.status !== 1) {
    throw new ProofError('the transaction failed: a reverted burn destroyed nothing');
  }
  const want = normalizeAddress(contract);
  for (const log of receipt.logs) {
    if (log.address !== want) continue;
    if ((log.topics[0] ?? '').toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    if (topicToAddress(log.topics[2]) !== ZERO_ADDRESS) continue;
    const amount = BigInt(log.data === '0x' ? '0x0' : log.data);
    if (amount <= 0n) continue;
    return { from: topicToAddress(log.topics[1]), amount };
  }
  throw new ProofError(`no burn of ${want} in this receipt`);
}

/**
 * The whole check, in one call: prove the receipt is in the block, then read
 * the burn out of it.
 *
 * Returns what `InboundLedger.claim` needs and nothing more, so the two halves
 * stay separable.
 */
export function proveBurn({ receiptsRoot, txIndex, proof, contract, ethTxHash, recipient }) {
  const key = RLP.encode(Number(txIndex));
  const value = verifyProof(receiptsRoot, key, proof.map(
    (n) => (n instanceof Uint8Array ? n : fromHex(n))));
  const receipt = decodeReceipt(value);
  const { from, amount } = findBurn(receipt, { contract });
  return {
    ethTxHash,
    amount,
    burnedBy: from,
    // The recipient on Molibra is the claimant's business, not the burn's:
    // the burn says how much was destroyed and by whom, never who should be
    // paid here. Defaulting it to the burner is a convenience, not a rule.
    recipient: recipient ? normalizeAddress(recipient) : from,
  };
}

/**
 * Where a `receiptsRoot` came from, and what believing it costs.
 *
 * ⛔ This is deliberately a named object rather than an implicit assumption.
 * A bridge whose trust model lives in a comment has no trust model.
 */
export class HeaderSource {
  /**
   * @param {'checkpoint'|'light-client'|'operator'} kind
   * @param {object} headers  blockNumber -> receiptsRoot
   */
  constructor(kind, headers = {}) {
    if (!['checkpoint', 'light-client', 'operator'].includes(kind)) {
      throw new Error(`unknown header source: ${kind}`);
    }
    this.kind = kind;
    this.headers = new Map(Object.entries(headers).map(([k, v]) => [String(k), String(v).toLowerCase()]));
  }

  /** True only for a header this source actually carries. */
  receiptsRootFor(blockNumber) {
    return this.headers.get(String(blockNumber)) ?? null;
  }

  /** What a reader must trust to believe anything proved against this source. */
  describe() {
    return {
      kind: this.kind,
      headers: this.headers.size,
      trustless: 'that a receipt is in a block with the given receiptsRoot',
      trusted: this.kind === 'light-client'
        ? 'nothing beyond Ethereum consensus itself'
        : `that the ${this.kind} reported a canonical Ethereum block`,
    };
  }
}

export { ProofError };
