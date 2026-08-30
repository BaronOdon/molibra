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
import { MAX_REQUEST_BYTES, MAX_BLOCK_RANGE } from './limits.js';
import { transactionProof, verifyTransactionProof } from './proof.js';

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

    const POSTABLE = new Set([
      '/molibra/submit-block', '/molibra/submit-tx', '/molibra/verify-proof',
      '/molibra/airdrop', '/molibra/earn', '/molibra/grant',
    ]);
    if (POSTABLE.has(req.url)) {
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

  // --- the bridge test rig ------------------------------------------------
  if (path === '/molibra/bridge') {
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

function handlePeerPost(node, path, payload, res) {
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
