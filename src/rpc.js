/**
 * Molibra - JSON-RPC and the public audit endpoints.
 *
 * The RPC method set is the one a standard wallet actually calls, so Molibra
 * can be added as a custom network with no bespoke client. The /molibra/*
 * routes are the audit surface: headers, blocks and transactions, readable by
 * anyone, replicable by any node.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { toQuantity, normalizeAddress, keccak256, recoverAddress, fromHex, bytesToBig } from './crypto.js';
import { intrinsicGas } from './tx.js';
import { serializeBlock } from './block.js';

const CLIENT_VERSION = 'Molibra/v0.1.0';

/** JSON-RPC error codes. */
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function txToRpc(tx, block, index) {
  return {
    hash: tx.hash,
    nonce: toQuantity(tx.nonce),
    blockHash: block ? block.hash : null,
    blockNumber: block ? toQuantity(block.header.number) : null,
    transactionIndex: index === null || index === undefined ? null : toQuantity(index),
    from: tx.from,
    to: tx.to,
    value: toQuantity(tx.value),
    gas: toQuantity(tx.gasLimit),
    gasPrice: toQuantity(tx.gasPrice),
    input: tx.data,
    v: toQuantity(tx.v),
    r: toQuantity(tx.r),
    s: toQuantity(tx.s),
    type: '0x0',
    chainId: toQuantity(BigInt((tx.v - 35n) / 2n)),
  };
}

function blockToRpc(block, fullTransactions) {
  const h = block.header;
  return {
    number: toQuantity(h.number),
    hash: block.hash,
    parentHash: h.parentHash,
    nonce: '0x' + BigInt(h.nonce ?? 0).toString(16).padStart(16, '0'),
    sha3Uncles: '0x' + '00'.repeat(32),
    logsBloom: '0x' + '00'.repeat(256),
    transactionsRoot: h.txRoot,
    stateRoot: h.stateRoot,
    receiptsRoot: h.txRoot,
    miner: h.miner,
    difficulty: toQuantity(h.difficulty),
    totalDifficulty: toQuantity(block.totalDifficulty ?? h.difficulty),
    extraData: h.extraData ?? '0x',
    size: toQuantity(JSON.stringify(serializeBlock(block)).length),
    gasLimit: toQuantity(h.gasLimit),
    gasUsed: toQuantity(h.gasUsed),
    timestamp: toQuantity(h.timestamp),
    uncles: [],
    transactions: fullTransactions
      ? block.transactions.map((tx, i) => txToRpc(tx, block, i))
      : block.transactions.map((tx) => tx.hash),
  };
}

/**
 * Explorer view of a block.
 *
 * The default payload of the audit block routes is the REPLICATION format -
 * transactions as raw RLP hex, which is what `appendSerialized` consumes on a
 * joining node. An explorer cannot read that without an RLP decoder, so
 * `?decoded=1` opts into decoded transaction objects instead. The replication
 * shape is deliberately left untouched: changing it would silently break sync.
 */
function blockForExplorer(chain, block) {
  const serialized = serializeBlock(block);
  return {
    ...serialized,
    totalDifficulty: block.totalDifficulty !== undefined ? String(block.totalDifficulty) : undefined,
    canonical: chain.isCanonical(block.hash),
    transactions: block.transactions.map((tx, index) => txToRpc(tx, block, index)),
  };
}

function receiptToRpc(receipt) {
  return {
    transactionHash: receipt.transactionHash,
    transactionIndex: toQuantity(receipt.transactionIndex),
    blockHash: receipt.blockHash,
    blockNumber: toQuantity(receipt.blockNumber),
    from: receipt.from,
    to: receipt.to,
    cumulativeGasUsed: toQuantity(receipt.cumulativeGasUsed),
    gasUsed: toQuantity(receipt.gasUsed),
    effectiveGasPrice: toQuantity(receipt.effectiveGasPrice),
    contractAddress: receipt.contractAddress,
    logs: receipt.logs,
    logsBloom: '0x' + '00'.repeat(256),
    status: toQuantity(receipt.status),
    type: '0x0',
    // Expression fields, present only on a VOTE-tagged transaction. Kept out of
    // the standard Ethereum receipt shape a wallet expects by being null
    // everywhere else, so no client has to special-case them.
    voteKey: receipt.voteKey ?? null,
    pollId: receipt.pollId ?? null,
  };
}

export function createRpcHandlers(node) {
  const { chain } = node;

  /** Resolve "latest" | "earliest" | "pending" | 0x-quantity to a block. */
  function resolveBlock(tag) {
    if (tag === undefined || tag === null || tag === 'latest' || tag === 'pending' || tag === 'safe' || tag === 'finalized') {
      return chain.head;
    }
    if (tag === 'earliest') return chain.blockByNumber(0);
    const number = BigInt(tag);
    const block = chain.blockByNumber(number);
    if (!block) throw new RpcError(INVALID_PARAMS, `unknown block ${tag}`);
    return block;
  }

  return {
    web3_clientVersion: () => CLIENT_VERSION,
    net_version: () => String(chain.chainId),
    net_listening: () => true,
    net_peerCount: () => toQuantity(node.peers.size),
    eth_chainId: () => toQuantity(chain.chainId),
    eth_syncing: () => false,
    eth_mining: () => node.mining,
    eth_accounts: () => [],
    eth_coinbase: () => node.miner ?? null,
    eth_blockNumber: () => toQuantity(chain.height),
    eth_gasPrice: () => toQuantity(node.minGasPrice),
    eth_maxPriorityFeePerGas: () => toQuantity(0n),
    eth_protocolVersion: () => '0x41',

    eth_getBalance: ([address, tag]) => {
      resolveBlock(tag);
      return toQuantity(chain.state.balanceOf(normalizeAddress(address)));
    },

    eth_getTransactionCount: ([address, tag]) => {
      const from = normalizeAddress(address);
      if (tag === 'pending') return toQuantity(chain.pendingNonce(from));
      resolveBlock(tag);
      return toQuantity(chain.state.nonceOf(from));
    },

    // No EVM in v0.1: every address is an externally owned account.
    eth_getCode: () => '0x',
    eth_getStorageAt: () => '0x' + '00'.repeat(32),

    eth_getBlockByNumber: ([tag, full]) => {
      const block = tag === 'latest' || tag === 'pending' ? chain.head : chain.blockByNumber(BigInt(tag));
      return block ? blockToRpc(block, Boolean(full)) : null;
    },

    eth_getBlockByHash: ([hash, full]) => {
      const block = chain.blockByHash(hash);
      return block ? blockToRpc(block, Boolean(full)) : null;
    },

    eth_getBlockTransactionCountByNumber: ([tag]) => {
      const block = resolveBlock(tag);
      return toQuantity(block.transactions.length);
    },

    eth_getTransactionByHash: ([hash]) => {
      const found = chain.transactionByHash(hash);
      return found ? txToRpc(found.tx, found.block, found.index) : null;
    },

    eth_getTransactionReceipt: ([hash]) => {
      const receipt = chain.receiptFor(hash);
      return receipt ? receiptToRpc(receipt) : null;
    },

    eth_sendRawTransaction: ([raw]) => {
      try {
        const hash = chain.submitRaw(raw);
        node.broadcastTransaction(raw);
        return hash;
      } catch (error) {
        throw new RpcError(INVALID_PARAMS, error.message);
      }
    },

    eth_estimateGas: ([call]) => {
      const data = call?.data ?? call?.input ?? '0x';
      return toQuantity(intrinsicGas({ data }));
    },

    // Value transfers only in v0.1, so a call has no return data.
    eth_call: () => '0x',

    eth_feeHistory: ([count]) => {
      const blocks = Number(BigInt(count ?? '0x1'));
      return {
        oldestBlock: toQuantity(chain.height),
        baseFeePerGas: Array(blocks + 1).fill(toQuantity(0n)),
        gasUsedRatio: Array(blocks).fill(0),
        reward: Array(blocks).fill([toQuantity(0n)]),
      };
    },
  };
}

export function startRpcServer(node, { host, port }) {
  const handlers = createRpcHandlers(node);

  const server = createServer(async (req, res) => {
    // Browser wallets are cross-origin by nature.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'GET') {
      return handleAudit(node, req, res);
    }

    let body = '';
    for await (const chunk of req) body += chunk;

    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'invalid JSON' } }));
      return;
    }

    if (req.url === '/molibra/submit-block' || req.url === '/molibra/submit-tx' || req.url === '/molibra/verify-proof' || req.url === '/molibra/airdrop') {
      return handlePeerPost(node, req.url, payload, res);
    }

    const respond = (request) => {
      const id = request?.id ?? null;
      const handler = handlers[request?.method];
      if (!handler) {
        return { jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `method not found: ${request?.method}` } };
      }
      try {
        return { jsonrpc: '2.0', id, result: handler(request.params ?? []) };
      } catch (error) {
        const code = error instanceof RpcError ? error.code : INTERNAL_ERROR;
        return { jsonrpc: '2.0', id, error: { code, message: error.message } };
      }
    };

    const result = Array.isArray(payload) ? payload.map(respond) : respond(payload);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

// ------------------------------------------------------------- audit routes

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

function handleAudit(node, req, res) {
  const { chain } = node;
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/' || path === '/molibra') {
    return json(res, 200, {
      client: CLIENT_VERSION,
      chain: chain.genesis.name,
      symbol: chain.genesis.symbol,
      chainId: chain.chainId,
      height: Number(chain.height),
      head: chain.head.hash,
      totalDifficulty: chain.totalDifficulty.toString(),
      knownBlocks: chain.byHash.size,
      lastReorg: chain.lastReorg,
      attribution: chain.genesis.attribution,
      theories: chain.genesis.theories,
      peers: [...node.peers],
      endpoints: ['/molibra/head', '/molibra/blocks?from=&to=&decoded=1', '/molibra/block/{numberOrHash}?decoded=1', '/molibra/tx/{hash}', '/molibra/theories', '/molibra/peers'],
    });
  }

  if (path === '/molibra/head') {
    return json(res, 200, serializeBlock(chain.head));
  }

  if (path === '/molibra/peers') {
    return json(res, 200, { peers: [...node.peers] });
  }

  if (path === '/molibra/treasury') {
    return json(res, 200, node.treasury
      ? node.treasury.describe()
      : { error: 'treasury not enabled on this node' });
  }

  if (path === '/molibra/connect') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'connect.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  if (path === '/molibra/challenge') {
    const nonce = '0x' + randomBytes(16).toString('hex');
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    node.challenges.set(nonce, Date.parse(expires));
    return json(res, 200, { nonce, expires });
  }

  if (path === '/molibra/tokens' || path.startsWith('/molibra/token/')) {
    // The disclosure rules are served with the data, not left to the client:
    // mode, supply, burn count and the two warnings travel together, because
    // the reason the mode is on-chain is that a reader always knows whether
    // they are looking at one-person-one-voice or at weight bought with money.
    const describe = (t) => ({
      ...t,
      remaining: (BigInt(t.supply) - BigInt(t.burned ?? 0)).toString(),
      expressionsCast: String(t.burned ?? '0'),
      warnings: [
        t.voteMode === 'weighted'
          ? 'WEIGHTED: one unit burned is one unit of weight. This is '
            + 'plutocratic by construction.'
          : null,
        t.electoral
          ? 'ELECTORAL SUBJECT: this token can never be made transferable.'
          : null,
        t.transferable ? 'TRANSFERABLE: this token has a market.' : null,
      ].filter(Boolean),
    });

    if (path === '/molibra/tokens') {
      return json(res, 200, {
        count: chain.state.tokens.size,
        tokens: [...chain.state.tokens.values()].map(describe),
      });
    }
    const id = path.slice('/molibra/token/'.length);
    const found = chain.state.getToken(id);
    return found
      ? json(res, 200, describe(found))
      : json(res, 404, { error: 'token not found' });
  }

  if (path === '/molibra/theories') {
    return json(res, 200, {
      attribution: chain.genesis.attribution,
      theories: chain.genesis.theories,
      sealedInGenesisExtraData: chain.head ? chain.blockByNumber(0).header.extraData : null,
    });
  }

  if (path === '/molibra/blocks') {
    const from = Number(url.searchParams.get('from') ?? 0);
    const to = Math.min(Number(url.searchParams.get('to') ?? chain.height), Number(chain.height));
    const decoded = url.searchParams.get('decoded') === '1';
    const blocks = [];
    for (let i = Math.max(0, from); i <= to; i++) {
      const block = chain.blockByNumber(i);
      blocks.push(decoded ? blockForExplorer(chain, block) : serializeBlock(block));
    }
    return json(res, 200, { from, to, blocks });
  }

  if (path.startsWith('/molibra/block/')) {
    const id = path.slice('/molibra/block/'.length);
    const block = id.startsWith('0x') ? chain.blockByHash(id) : chain.blockByNumber(Number(id));
    if (!block) return json(res, 404, { error: 'block not found' });
    const decoded = url.searchParams.get('decoded') === '1';
    return json(res, 200, decoded ? blockForExplorer(chain, block) : serializeBlock(block));
  }

  if (path.startsWith('/molibra/tx/')) {
    const hash = path.slice('/molibra/tx/'.length);
    const found = chain.transactionByHash(hash);
    if (!found) return json(res, 404, { error: 'transaction not found' });
    return json(res, 200, {
      transaction: txToRpc(found.tx, found.block, found.index),
      receipt: chain.receiptFor(hash) ? receiptToRpc(chain.receiptFor(hash)) : null,
    });
  }

  return json(res, 404, { error: 'not found' });
}

/** EIP-191 personal_sign digest. */
function personalSignHash(message) {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix, 0);
  joined.set(body, prefix.length);
  return keccak256(joined);
}

/**
 * Verify a linking proof produced by the connect page.
 * Recovers the signer and checks the challenge is one we issued, unused and
 * unexpired. Proves control of an address; grants nothing and moves nothing.
 */
export function verifyLinkingProof(node, code) {
  const padded = code.replace(/-/g, '+').replace(/_/g, '/');
  const { m: message, s: signature, a: claimed } = JSON.parse(
    Buffer.from(padded, 'base64').toString('utf8'),
  );

  const sig = fromHex(signature);
  if (sig.length !== 65) throw new Error('signature must be 65 bytes');
  const r = bytesToBig(sig.slice(0, 32));
  const s = bytesToBig(sig.slice(32, 64));
  let v = sig[64];
  if (v >= 27) v -= 27;

  const signer = recoverAddress(personalSignHash(message), r, s, v);
  if (!signer) throw new Error('signature does not recover');
  if (signer !== normalizeAddress(claimed)) throw new Error('signature does not match the claimed address');

  const fields = Object.fromEntries(
    message.split('\n').filter((l) => l.includes(': '))
      .map((l) => [l.slice(0, l.indexOf(': ')).trim(), l.slice(l.indexOf(': ') + 2).trim()]),
  );
  if (Number(fields.chainId) !== node.chain.chainId) throw new Error('proof is for another chain');
  if (normalizeAddress(fields.address) !== signer) throw new Error('address in the message does not match the signer');

  const expiry = Date.parse(fields.expires);
  if (!Number.isFinite(expiry) || expiry < Date.now()) throw new Error('proof has expired');

  const issued = node.challenges.get(fields.nonce);
  if (issued === undefined) throw new Error('unknown or already-used challenge');
  node.challenges.delete(fields.nonce); // single use

  return {
    address: signer,
    appAccount: fields['app account'],
    balance: node.chain.state.balanceOf(signer).toString(),
    nonce: fields.nonce,
    verifiedAt: new Date().toISOString(),
  };
}

function handlePeerPost(node, path, payload, res) {
  try {
    if (path === '/molibra/airdrop') {
      if (!node.treasury) throw new Error('treasury not enabled on this node');
      const verified = verifyLinkingProof(node, payload.code ?? payload);
      return json(res, 200, { ok: true, claim: node.treasury.claim(verified) });
    }
    if (path === '/molibra/verify-proof') {
      return json(res, 200, { ok: true, proof: verifyLinkingProof(node, payload.code ?? payload) });
    }
    if (path === '/molibra/submit-block') {
      node.acceptPeerBlock(payload.block ?? payload);
      return json(res, 200, { ok: true, height: Number(node.chain.height) });
    }
    node.chain.submitRaw(payload.raw ?? payload);
    return json(res, 200, { ok: true });
  } catch (error) {
    return json(res, 400, { ok: false, error: error.message });
  }
}
