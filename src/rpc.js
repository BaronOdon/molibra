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
import { toQuantity, normalizeAddress, keccak256, recoverAddress, fromHex, toHex, bytesToBig } from './crypto.js';
import { intrinsicGas } from './tx.js';
import { serializeBlock, encodeHeader } from './block.js';
import { PURPOSE_LABELS } from './token.js';
import { MAX_REQUEST_BYTES, MAX_BLOCK_RANGE, MAX_PEERS } from './limits.js';
import { transactionProof, verifyTransactionProof } from './proof.js';
import { simulate } from './evm.js';
import { MOLI_BURN_ACTIVATION } from './moliburn.js';
import { accountLine, STATE_MERKLE_ACTIVATION } from './stateproof.js';
import { RateLimiter, clientKey, costOfPath, costOfMethod } from './ratelimit.js';

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
    tokenId: receipt.tokenId ?? null,
    tokenAmount: receipt.tokenAmount ?? null,
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

    /**
     * Keccak-256 of arbitrary bytes.
     *
     * Part of the standard method set and it was missing, which is the kind of
     * gap that only surfaces when something actually calls it: the settlement
     * page used it to derive a function selector and failed with "method not
     * found" at the moment the operator pressed the button. Every node already
     * has this hash function; not exposing it was an omission, not a decision.
     */
    web3_sha3: ([data]) => toHex(keccak256(fromHex(data ?? '0x'))),

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

    /**
     * ⛔ These three were stubbed while there was no EVM, and stayed stubbed
     * after there was one. A contract that mints correctly and cannot be READ
     * is invisible: `balanceOf` is an `eth_call`, so a wallet shown a bridged
     * asset would report zero, and an explorer would show an empty account
     * where the token lives. Consensus was right and the window onto it was
     * closed.
     */
    eth_getCode: ([address, tag]) => {
      resolveBlock(tag);
      const code = chain.state.getCode(normalizeAddress(address));
      return code && code.length ? toHex(code) : '0x';
    },

    eth_getStorageAt: ([address, slot, tag]) => {
      resolveBlock(tag);
      return chain.state.getStorage(normalizeAddress(address), slot);
    },

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

    eth_estimateGas: async ([call]) => {
      const data = call?.data ?? call?.input ?? '0x';
      const base = intrinsicGas({ data });

      /**
       * ⛔⛔ A CREATE has no `to`, and this used to fall straight through to the
       * intrinsic cost — so deploying a contract was quoted at the price of its
       * calldata and nothing else. A 4,660-byte contract costs ~932,000 gas in
       * code deposit alone at 200 gas per byte; the estimate came back 91,436.
       * Every wallet that trusted it sent a transaction that ran out of gas,
       * and out-of-gas presents to the user as "reverted", which points at the
       * contract instead of at this line.
       *
       * Found by a real deploy failing from the swap page, not by a test.
       */
      const isCreate = !call?.to && data && data !== '0x';
      if (isCreate) {
        const r = await simulate(chain.state, {
          from: call.from ? normalizeAddress(call.from) : '0x' + '00'.repeat(20),
          to: null,
          value: call.value ? BigInt(call.value) : 0n,
          data: fromHex(data),
          gasLimit: BigInt(chain.genesis.blockGasLimit),
          chainId: BigInt(chain.chainId),
          blockNumber: chain.head.header.number,
          timestamp: BigInt(chain.head.header.timestamp),
        });
        if (r.failed) throw new RpcError(INVALID_PARAMS, `the deployment reverts: ${r.error}`);
        return toQuantity(base + (r.gasUsed * 11n) / 10n);
      }

      if (!call?.to || !chain.state.hasCode(call.to)) return toQuantity(base);
      const r = await simulate(chain.state, {
        from: call.from ? normalizeAddress(call.from) : '0x' + '00'.repeat(20),
        to: normalizeAddress(call.to),
        value: call.value ? BigInt(call.value) : 0n,
        data: fromHex(data),
        gasLimit: BigInt(chain.genesis.blockGasLimit),
        chainId: BigInt(chain.chainId),
        blockNumber: chain.head.header.number,
        timestamp: BigInt(chain.head.header.timestamp),
      });
      // A tenth on top: the estimate is against the CURRENT head, and the
      // transaction will run against a later one. Returning the exact figure
      // makes every estimate a transaction that only just fits.
      return toQuantity(base + (r.gasUsed * 11n) / 10n);
    },

    /**
     * Read-only execution, against a clone. This is how a wallet reads
     * `balanceOf`, `symbol`, `decimals` and every other view function - so
     * without it a bridged asset exists in consensus and nowhere a person can
     * see it.
     */
    eth_call: async ([call, tag]) => {
      resolveBlock(tag);
      if (!call?.to || !chain.state.hasCode(call.to)) return '0x';
      const r = await simulate(chain.state, {
        from: call.from ? normalizeAddress(call.from) : '0x' + '00'.repeat(20),
        to: normalizeAddress(call.to),
        value: call.value ? BigInt(call.value) : 0n,
        data: fromHex(call.data ?? call.input ?? '0x'),
        gasLimit: BigInt(chain.genesis.blockGasLimit),
        chainId: BigInt(chain.chainId),
        blockNumber: chain.head.header.number,
        timestamp: BigInt(chain.head.header.timestamp),
      });
      // A reverted call is an ERROR, not an empty answer. A wallet that reads
      // '0x' back from a revert shows a zero balance rather than a failure,
      // which is the kind of wrong that looks like working.
      if (r.failed) throw new RpcError(INTERNAL_ERROR, `execution reverted: ${r.error}`);
      return toHex(r.returnValue);
    },

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

  /**
   * ⛔ One limiter for the whole server, per client address. §8.5 said the RPC
   * had no meaningful rate limiting; that was tolerable while the audience was
   * a known set of nodes and stops being tolerable the moment a public trading
   * page points browsers at the same host.
   */
  // Canonical on the node, so the audit routes reach the SAME limiter rather
  // than a second one that has counted nothing. handleAudit only receives
  // `node`, and a per-server local was invisible to it.
  const limiter = node.rateLimiter ?? new RateLimiter();
  node.rateLimiter = limiter;

  const refuse = (res, retryAfter) => {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfter),
    });
    res.end(JSON.stringify({
      error: 'rate limit exceeded',
      retryAfter,
      why: 'this node bounds how much work one client can ask for; the limit is '
        + 'per second and bursts are allowed',
    }));
  };

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
      // Cost is per ROUTE: a state proof rebuilds the whole Merkle tree and is
      // not the same unit of work as reading a balance.
      const path = (req.url ?? '/').split('?')[0];
      const verdict = limiter.take(clientKey(req), costOfPath(path));
      if (!verdict.ok) return refuse(res, verdict.retryAfter);
      return handleAudit(node, req, res);
    }

    // Bounded, and bounded WHILE reading rather than after. A body is
    // attacker-controlled and arrives in pieces; the only moment at which
    // refusing it costs nothing is before the next piece is buffered.
    let body = '';
    let size = 0;
    let oversized = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) { oversized = true; break; }
      body += chunk;
    }
    if (oversized) {
      req.destroy();
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `request body exceeds ${MAX_REQUEST_BYTES} bytes` }));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'invalid JSON' } }));
      return;
    }

    // ⛔ Charged AFTER parsing, because the cost depends on the method asked
    // for, and a batch is charged for every call in it - otherwise one request
    // carrying two hundred eth_calls would cost the same as one balance read,
    // which is the obvious way around a per-request limiter.
    {
      const calls = Array.isArray(payload) ? payload : [payload];
      const cost = calls.reduce((sum, c) => sum + costOfMethod(c?.method), 0);
      const verdict = limiter.take(clientKey(req), cost);
      if (!verdict.ok) return refuse(res, verdict.retryAfter);
    }

    // ⛔ An explicit allowlist, not a prefix match: everything else falls
    // through to JSON-RPC. A handler added below without a path added HERE is
    // dead code that answers "method not found" - which is exactly what
    // happened to /molibra/announce on its first outing.
    const POSTABLE = new Set([
      '/molibra/submit-block', '/molibra/submit-tx', '/molibra/verify-proof',
      '/molibra/airdrop', '/molibra/earn', '/molibra/grant', '/molibra/announce',
    ]);
    if (POSTABLE.has(req.url)) {
      return handlePeerPost(node, req.url, payload, res);
    }

    // ⛔ Awaited. `eth_call` and `eth_estimateGas` run the EVM, so they are
    // async; a dispatcher that returned the promise would serialise `{}` and
    // every contract read would come back empty rather than failing.
    const respond = async (request) => {
      const id = request?.id ?? null;
      const handler = handlers[request?.method];
      if (!handler) {
        return { jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `method not found: ${request?.method}` } };
      }
      try {
        return { jsonrpc: '2.0', id, result: await handler(request.params ?? []) };
      } catch (error) {
        const code = error instanceof RpcError ? error.code : INTERNAL_ERROR;
        return { jsonrpc: '2.0', id, error: { code, message: error.message } };
      }
    };

    const result = Array.isArray(payload)
      ? await Promise.all(payload.map(respond))
      : await respond(payload);
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

  /**
   * The front door.
   *
   * ⛔ '/' is the SITE; '/molibra' stays the identity JSON. Nothing fetches the
   * bare root expecting JSON - every page and syncFrom names '/molibra' or a
   * route beneath it - so this takes the root without moving anybody's API.
   * A chain whose whole claim is that you need not trust it should be able to
   * say so at its own address, rather than answering a browser with a struct.
   */
  if (path === '/') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  if (path === '/molibra') {
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
      // ⛔⛔ Flag days, stated rather than buried in source. Below its
      // activation a moliBurn payload is NOT decoded as a burn - it takes the
      // ordinary path and destroys nothing, which is exactly what a node on
      // the old code does with it, and exactly what makes it dangerous to a
      // reader who cannot see the number. A page that offers to destroy MOLI
      // has to be able to check first, and so does anybody auditing why a
      // burn did nothing.
      activations: {
        moliBurn: {
          height: Number(MOLI_BURN_ACTIVATION),
          active: chain.height >= MOLI_BURN_ACTIVATION,
          blocksAway: chain.height >= MOLI_BURN_ACTIVATION
            ? 0 : Number(MOLI_BURN_ACTIVATION - chain.height),
        },
        stateMerkle: {
          height: Number(STATE_MERKLE_ACTIVATION),
          active: chain.height >= STATE_MERKLE_ACTIVATION,
          blocksAway: chain.height >= STATE_MERKLE_ACTIVATION
            ? 0 : Number(STATE_MERKLE_ACTIVATION - chain.height),
        },
      },
      // A COUNT of distinct clients in the last 15 minutes - never the
      // addresses. A chain whose claim is that participation is voluntary and
      // never inferred has no business publishing who reads it.
      //
      // It exists for flag days. Changing a consensus constant is only safe
      // once every node has upgraded, and "is anybody else running one?" was
      // unanswerable from outside: `peers` is what this node dials OUT to and
      // says nothing about who dials in. A floor, not a census - buckets are
      // evicted under pressure and a reader who never asks is invisible, so a
      // low number is "no evidence of others", never "there are none".
      readers: { distinct: node.rateLimiter?.activeClients() ?? 0, windowSeconds: 900 },
      attribution: chain.genesis.attribution,
      theories: chain.genesis.theories,
      peers: [...node.peers],
      // MOLI destroyed to be minted on another chain. It is the number a reader
      // checks a bridged token's totalSupply against - which is only meaningful
      // if the chain states it, rather than the bridge stating it about itself.
      outbound: {
        burned: chain.state.outbound.burned.toString(),
        byRecipient: Object.fromEntries(
          [...chain.state.outbound.byRecipient].map(([k, v]) => [k, v.toString()]),
        ),
      },
      endpoints: ['/molibra/head', '/molibra/blocks?from=&to=&decoded=1', '/molibra/block/{numberOrHash}?decoded=1', '/molibra/tx/{hash}', '/molibra/theories', '/molibra/peers', '/molibra/bridge', '/molibra/settle', '/molibra/inbound', '/molibra/pool', '/molibra/bridgedmoli'],
    });
  }

  if (path === '/molibra/head') {
    return json(res, 200, serializeBlock(chain.head));
  }

  /**
   * An inclusion proof for one account's line in the state.
   *
   *   /molibra/state-proof/0x…
   *
   * ⛔ Honest about what it is worth right now. Until STATE_MERKLE_ACTIVATION,
   * the Merkle root is NOT the root in any block header, so a proof verifies
   * against `root` here and against nothing on the chain. `consensus` says
   * which of the two roots the current height actually commits to, so a caller
   * cannot mistake a preview for a guarantee.
   */
  if (path.startsWith('/molibra/state-proof/')) {
    const address = path.slice('/molibra/state-proof/'.length);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return json(res, 400, { error: 'expected /molibra/state-proof/0x<20-byte address>' });
    }
    const line = accountLine(chain.state, normalizeAddress(address));
    if (!line) {
      return json(res, 404, {
        error: 'this account contributes no line to the state',
        why: 'an account with no balance and no nonce is skipped by the root, '
          + 'so there is nothing to prove rather than an empty proof',
      });
    }
    const proof = chain.state.proofForLine(line);
    const height = chain.height;
    return json(res, 200, {
      address: normalizeAddress(address),
      height: Number(height),
      line,
      ...proof,
      rootConcat: chain.state.rootConcat(),
      consensus: height >= STATE_MERKLE_ACTIVATION ? 'merkle' : 'concat',
      committedInHeader: height >= STATE_MERKLE_ACTIVATION,
      activation: Number(STATE_MERKLE_ACTIVATION),
      verifier: 'keccak leaves, keccak(left‖right), odd nodes promoted — the same '
        + 'construction MolibraSettlement.merkleRoot already verifies on Ethereum',
    });
  }

  if (path === '/molibra/peers') {
    return json(res, 200, { peers: [...node.peers] });
  }

  /**
   * What has crossed the bridge, and what a stranger must trust to believe it.
   *
   * Written to be read BY SOMEBODY WHO TRUSTS NOTHING. Every number here is
   * recomputable from the two chains: sum the burns on the origin chain
   * against the committed roots, sum what exists here, and check the total
   * against the original supply. The `registrar` is the one input that is not
   * arithmetic - it is whose word the committed headers are - which is exactly
   * why it is printed next to the numbers rather than buried in a design note.
   */
  if (path === '/molibra/bridge') {
    const { inbound } = chain.state;
    const assets = [...inbound.assets.keys()].map((id) => ({ id, ...inbound.report(id) }));
    return json(res, 200, {
      assets,
      claimsHonoured: inbound.claimed.size,
      headers: [...inbound.headers.entries()].map(([k, v]) => {
        const [chainId, blockNumber] = k.split(':');
        return { chainId, blockNumber, receiptsRoot: v.receiptsRoot, committedBy: v.by };
      }),
      trustModel: {
        trustless: 'that a burn is in a block with the committed receiptsRoot, that it burned '
          + "the asset's own origin contract, and that it is paid exactly once",
        trusted: 'that a block with that receiptsRoot is canonical on the origin chain - the '
          + 'word of the registrar named above, permanently on this chain and refutable by '
          + 'anyone running a node on that one',
      },
      howToVerify: 'compare every receiptsRoot here against the real block on the origin chain; '
        + 'then sum the burns and check them against the minted totals.',
    });
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

  /**
   * The settlement page: deploy, anchor, release. An OPERATOR page - it holds
   * no key and every transaction is signed in the reader's own wallet.
   *
   * ⛔ Served from disk on every request, so an edit is live without a restart.
   * The ROUTE is not: a handler added to a running node is dead code until it
   * is restarted, which is why this one was curled against a fresh process
   * rather than the one that happened to be up.
   */
  if (path === '/molibra/settle') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'settle.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  /**
   * The inbound leg: register the asset, burn on Ethereum, commit the header,
   * claim on Molibra. The other half of the settlement page's journey.
   */
  if (path === '/molibra/inbound') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'inbound.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  /**
   * The MOLI/WSRO pair: deploy the pool and seed it. The page prints the price
   * the deposit will set next to the button that sets it.
   */
  if (path === '/molibra/pool') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'pool.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  /**
   * MOLI on Ethereum: burn here, mint there, against a proof of the burn.
   * ⛔ One-way, and backed by the bonded anchor rather than verified work -
   * both said on the page itself, where a reader can see them.
   */
  /**
   * The public trading page. Anyone may connect a wallet and swap against the
   * MOLI/WSRO pool. It holds no key and custodies nothing.
   */
  if (path === '/molibra/swap') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'swap.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  /**
   * Moliscan - the explorer.
   *
   * It adds no index and no cache: every view is assembled in the browser from
   * routes this node already answers exactly. An explorer that built its own
   * index would be asking to be trusted about what it had indexed, which is
   * the one thing this chain declines to ask for.
   */
  /**
   * The mark. Served as SVG from this node - no CDN, no binary asset in the
   * repo, and it scales from a 16px tab to an iOS home screen from one file.
   * /favicon.ico is answered with the same bytes because browsers request it
   * blind whether or not a page declares one, and a 404 there is the blank
   * square that makes a live network look unfinished.
   */
  if (path === '/icon.svg' || path === '/favicon.ico') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'icon.svg');
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  if (path === '/molibra/moliscan') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'moliscan.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  if (path === '/molibra/chart') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'chart.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  if (path === '/molibra/whitepaper') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'whitepaper.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  /**
   * The paper itself, as it is written.
   *
   * The rendered page reads THIS, so the document a visitor sees is the file in
   * the repository rather than a copy of it that drifted. Served as markdown so
   * it can be diffed against the repo by anyone who wants to check that.
   */
  if (path === '/molibra/whitepaper.md') {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'WHITEPAPER.md');
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  if (path === '/molibra/bridgedmoli') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'bridgedmoli.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  // The browser wallet, and the crypto it needs.
  //
  // Served from THIS node out of node_modules rather than pulled from a CDN.
  // A page that mints somebody's private key must not fetch its own maths from
  // a third party who can change it without telling anyone; self-hosting also
  // means the page works with no internet beyond the node itself.
  if (path === '/molibra/wallet.js') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'wallet.js');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  // The one wallet guard every page shares. Same reason as above: served from
  // this node, never a CDN.
  if (path === '/molibra/mobilewallet.js') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'mobilewallet.js');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  if (path.startsWith('/molibra/vendor/')) {
    const rest = path.slice('/molibra/vendor/'.length);
    const slash = rest.indexOf('/');
    const pkg = slash === -1 ? rest : rest.slice(0, slash);
    let file = slash === -1 ? '' : rest.slice(slash + 1);
    // Only these two packages, only their ESM builds, and no traversal out of
    // them. An open static route rooted in node_modules is a file-read
    // primitive wearing a helpful hat.
    if (!['hashes', 'curves'].includes(pkg) || !file || file.includes('..') || file.includes('\\')) {
      return json(res, 404, { error: 'not found' });
    }
    if (!file.endsWith('.js')) file += '.js'; // bare specifiers carry no extension
    if (!/^[A-Za-z0-9._\/-]+$/.test(file)) return json(res, 404, { error: 'not found' });
    const base = join(dirname(fileURLToPath(import.meta.url)), '..',
      'node_modules', '@noble', pkg, 'esm');
    const target = join(base, file);
    if (!target.startsWith(base)) return json(res, 404, { error: 'not found' });
    try {
      const body = readFileSync(target, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(body);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
    return;
  }

  // --- the WSRO/WETH broker ------------------------------------------------
  // Served from the node for the same reason every other page here is: a page
  // that moves money must not fetch its own arithmetic from a third party.
  if (path === '/molibra/broker') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'broker.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  // --- the bridge test rig ------------------------------------------------
  //
  // ⛔ Served at /molibra/bridgeout, NOT /molibra/bridge. It shipped on that
  // path on 30 Aug (1578de1); on 31 Aug (a52817e) the inbound-registrar JSON
  // took the same path EARLIER in this file and shadowed it. Two branches, one
  // string, first one wins - and the page went dead on the public site while
  // the front page kept linking to it and the test suite kept passing, because
  // "is there a route for this path" was true the whole time. inbound.html
  // fetches the JSON at /molibra/bridge, so the JSON is the one that stays.
  if (path === '/molibra/bridgeout') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'bridge.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  if (path.startsWith('/molibra/bridge/artifact/')) {
    const name = path.slice('/molibra/bridge/artifact/'.length);
    if (!/^[A-Za-z0-9_]+$/.test(name)) return json(res, 404, { error: 'not found' });
    try {
      const file = join(dirname(fileURLToPath(import.meta.url)), '..',
        'bridge', 'artifacts', `${name}.json`);
      return json(res, 200, JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return json(res, 404, {
        error: 'not compiled yet - run: node bridge/build-and-test.mjs',
      });
    }
  }

  // The exact bytes the block hash is taken over. A verifier elsewhere must
  // re-hash these itself; handing them over means one encoder rather than two
  // that have to agree forever.
  if (path.startsWith('/molibra/header-rlp/')) {
    const id = path.slice('/molibra/header-rlp/'.length);
    const block = id.startsWith('0x') ? chain.blockByHash(id) : chain.blockByNumber(Number(id));
    if (!block) return json(res, 404, { error: 'block not found' });
    return json(res, 200, { blockHash: block.hash, rlp: encodeHeader(block.header) });
  }

  // A run of header RLPs, which is what a relay on another chain consumes.
  // Capped by the same range limit as any other bulk read.
  if (path === '/molibra/headers-rlp') {
    const from = Math.max(0, Number(url.searchParams.get('from') ?? 0));
    const asked = Math.min(Number(url.searchParams.get('to') ?? chain.height), Number(chain.height));
    const to = Math.min(asked, from + MAX_BLOCK_RANGE - 1);
    const out = [];
    for (let i = from; i <= to; i++) {
      const block = chain.blockByNumber(i);
      if (!block) break;
      out.push({ number: i, blockHash: block.hash, rlp: encodeHeader(block.header) });
    }
    return json(res, 200, { from, to, truncated: to < asked, headers: out });
  }

  // Selector helper for a page that has no hash function of its own. Takes
  // text, returns its keccak - it reads nothing and decides nothing.
  if (path === '/molibra/keccak') {
    const text = url.searchParams.get('text') ?? '';
    return json(res, 200, { text, hash: toHex(keccak256(new TextEncoder().encode(text))) });
  }

  if (path === '/molibra/create') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'create.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  if (path === '/molibra/chalk') {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'web', 'chalk.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  if (path === '/molibra/issuer') {
    return json(res, 200, node.issuer
      ? node.issuer.describe()
      : { error: 'no issuer enabled on this node' });
  }

  // A puzzle to solve, bound to the address that will receive the grant.
  // The refusal - "you already hold enough to speak" - is returned as a
  // reason, so the page can say which rule stopped it rather than shrug.
  if (path === '/molibra/earn') {
    if (!node.issuer) return json(res, 400, { error: 'no issuer enabled on this node' });
    const address = url.searchParams.get('address');
    if (!address) return json(res, 400, { error: 'address is required' });
    try {
      return json(res, 200, node.issuer.challengeFor(address));
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
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
      // What it IS, said first, because everything else means something
      // different depending on the answer.
      kindLabel: t.kind === 'asset'
        ? 'asset: held and sent, like a token on any other chain'
        : 'question: held to speak with, and burned when spent',
      // minted - remaining is the burn, and the burn is the tally. Under
      // `weighted` the units burned and the number of expressions differ, so
      // both are served: never let a reader infer a count from an amount.
      remaining: (BigInt(t.minted) - BigInt(t.burned ?? 0)).toString(),
      unitsBurned: String(t.burned ?? '0'),
      expressionsCast: String(t.expressions ?? '0'),
      supplyPolicy: BigInt(t.maxSupply) === 0n
        ? 'uncapped: minted on demand, because questions never stop being created'
        : `capped at ${t.maxSupply}`,
      distribution: t.issuable
        ? 'issuable by the creator, one-directional: a holder can never pass a unit on'
        : 'fixed at creation',
      // The purpose is served in the vocabulary of the mark it is scoped by,
      // because a reader in Brazil needs to know whether they are looking at
      // aferição de mercado or at matéria eleitoral, and those are the words
      // the rule uses.
      purposeLabel: PURPOSE_LABELS[t.purpose] ?? t.purpose,
      warnings: [
        t.kind === 'asset' && t.transferable
          ? 'TRANSFERABLE ASSET: this token has a market and therefore a price. '
            + 'It carries no voting semantics and must never be used as one.'
          : null,
        t.voteMode === 'weighted'
          ? 'WEIGHTED: one unit burned is one unit of weight. This is '
            + 'plutocratic by construction.'
          : null,
        t.electoral
          ? 'MATÉRIA ELEITORAL: this token can never be made transferable, and '
            + 'a question on electoral preference carries its own registration '
            + 'duties that this chain does not discharge.'
          : null,
        // Said plainly on every non-electoral token, because the whole point
        // of declaring a purpose is that the declaration constrains use.
        !t.electoral
          ? `DECLARED PURPOSE: ${PURPOSE_LABELS[t.purpose] ?? t.purpose}. This is `
            + 'not an electoral poll and must not be presented or used as a '
            + 'measure of electoral preference.'
          : null,
        // The naming rule, served with the record. Under the TSE resolutions
        // an enquete and a pesquisa are regulated objects; this is neither,
        // and the words must not be used for it anywhere.
        t.purpose === 'purchase'
          ? 'EXPRESSÃO PÚBLICA DE COMPRA: a purchase, made public by the person '
            + 'who made it. It is NOT an enquete and NOT a pesquisa, and must '
            + 'not be called or presented as either.'
          : null,
        t.transferable ? 'TRANSFERABLE: this token has a market.' : null,
        // Dilution only bites where holdings buy weight. Under single,
        // quantum and capped a wallet's voice is the same size however much
        // it holds, so uncapped issuance dilutes nothing.
        t.issuable && t.voteMode === 'weighted'
          ? 'UNCAPPED WEIGHT: the creator may issue more units at will, and in '
            + 'this mode units are weight - every holder can be diluted at any moment.'
          : null,
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
    const from = Math.max(0, Number(url.searchParams.get('from') ?? 0));
    const asked = Math.min(Number(url.searchParams.get('to') ?? chain.height), Number(chain.height));
    // Capped, and the cap is reported rather than silently applied - a caller
    // that does not notice a truncated range syncs a partial chain and thinks
    // it is done. `truncated` plus the real `to` is what lets syncFrom page.
    const to = Math.min(asked, from + MAX_BLOCK_RANGE - 1);
    const decoded = url.searchParams.get('decoded') === '1';
    const blocks = [];
    for (let i = from; i <= to; i++) {
      const block = chain.blockByNumber(i);
      if (!block) break;
      blocks.push(decoded ? blockForExplorer(chain, block) : serializeBlock(block));
    }
    return json(res, 200, { from, to, truncated: to < asked, height: Number(chain.height), blocks });
  }

  if (path.startsWith('/molibra/block/')) {
    const id = path.slice('/molibra/block/'.length);
    const block = id.startsWith('0x') ? chain.blockByHash(id) : chain.blockByNumber(Number(id));
    if (!block) return json(res, 404, { error: 'block not found' });
    const decoded = url.searchParams.get('decoded') === '1';
    return json(res, 200, decoded ? blockForExplorer(chain, block) : serializeBlock(block));
  }

  // An inclusion proof anyone can check without trusting this node. The
  // foundation of connecting to another network - and the only half of that
  // job that holds nothing and moves nothing.
  if (path.startsWith('/molibra/proof/')) {
    const hash = path.slice('/molibra/proof/'.length);
    const proof = transactionProof(chain, hash);
    if (!proof) return json(res, 404, { error: 'no mined transaction with that hash' });
    return json(res, 200, { ...proof, verdict: verifyTransactionProof(proof) });
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

async function handlePeerPost(node, path, payload, res) {
  try {
    if (path === '/molibra/airdrop') {
      if (!node.treasury) throw new Error('treasury not enabled on this node');
      const verified = verifyLinkingProof(node, payload.code ?? payload);
      return json(res, 200, { ok: true, claim: node.treasury.claim(verified) });
    }
    // Redeem a solved puzzle. This is the button on the chalk page.
    if (path === '/molibra/earn') {
      if (!node.issuer) throw new Error('no issuer enabled on this node');
      return json(res, 200, { ok: true, grant: node.issuer.redeem(payload) });
    }
    // A grant against a linking proof. This is the button IN THE APP - the app
    // never solves a puzzle, because mining inside a mobile app is banned by
    // Apple 3.1.5(ii) and by Google Play, and the store position is what the
    // whole compliance argument rests on.
    if (path === '/molibra/grant') {
      if (!node.issuer) throw new Error('no issuer enabled on this node');
      const verified = verifyLinkingProof(node, payload.code ?? payload);
      return json(res, 200, { ok: true, grant: node.issuer.grantForProof(verified) });
    }
    if (path === '/molibra/verify-proof') {
      return json(res, 200, { ok: true, proof: verifyLinkingProof(node, payload.code ?? payload) });
    }
    /**
     * A peer telling us where to reach it, so we can push blocks to it rather
     * than leaving it to poll.
     *
     * ⛔ This is a public endpoint that grows a set this node iterates over on
     * every mined block, so it is capped and shape-checked. Without the cap, a
     * stranger could enlarge the peer set until every block broadcast becomes
     * an outbound flood - turning this node into someone else's amplifier.
     * Announcing is an optimisation; refusing one costs nothing but latency.
     */
    if (path === '/molibra/announce') {
      const url = String(payload?.url ?? '').replace(/\/$/, '');
      if (!/^https?:\/\/[^\s/]+$/i.test(url)) {
        return json(res, 400, { error: 'url must be http(s)://host:port' });
      }
      if (url === node.rpcUrl) return json(res, 200, { peers: node.peers.size, self: true });
      if (node.peers.has(url)) return json(res, 200, { peers: node.peers.size, known: true });
      if (node.peers.size >= MAX_PEERS) {
        return json(res, 429, { error: `peer set full (${MAX_PEERS})`, peers: node.peers.size });
      }
      node.addPeer(url);
      return json(res, 200, { peers: node.peers.size, added: url });
    }

    if (path === '/molibra/submit-block') {
      await node.acceptPeerBlock(payload.block ?? payload);
      return json(res, 200, { ok: true, height: Number(node.chain.height) });
    }
    node.chain.submitRaw(payload.raw ?? payload);
    return json(res, 200, { ok: true });
  } catch (error) {
    return json(res, 400, { ok: false, error: error.message });
  }
}
