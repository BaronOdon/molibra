/**
 * Molibra bridge bot - the logic, against mocked Ethereum RPCs and a mocked
 * Molibra node whose state is a REAL `State` driven by `applyTransaction`.
 *
 *   claims   discovery, already-claimed skip, no anchor, window not passed,
 *            one EXPLICIT low-tip type-2 send, dry-run sends nothing,
 *            idempotent restart (no second claim)
 *   returns  RPC disagreement aborts, below the flag day is dry-run, the full
 *            HEADER_COMMIT -> MOLI_RETURN path through consensus, cap-exceeded
 *            handoff to the operator, operator root uncapped, root conflict,
 *            idempotent restart mid-flight, a stuck tx superseded at its nonce
 *   signer   the EIP-1559 encoder against a vector checked with @ethereumjs/tx
 */

import { RLP } from '@ethereumjs/rlp';

import { State, applyTransaction } from '../src/state.js';
import { signTransaction, decodeTransaction, intrinsicGas } from '../src/tx.js';
import { generatePrivateKey, toHex, fromHex, keccak256, privateToAddress } from '../src/crypto.js';
import { encodeMoliBurn } from '../src/moliburn.js';
import { encodeHeaderCommit } from '../src/bridgemint.js';
import { TRANSFER_TOPIC } from '../src/burnproof.js';
import { buildTrie, encodeReceipt } from '../src/ethreceipts.js';
import { sel, SELECTORS } from '../src/bmoliclaim.js';
import { signEip1559, decodeEip1559 } from '../src/eth1559.js';
import {
  MOLI_RETURN_ADDRESS, BMOLI_CONTRACT, ETH_HEADER_AUTHORITY, ETH_HEADER_BOT,
  BOT_HEADER_ACTIVATION, BOT_RETURN_CAP, returnKey,
} from '../src/molireturn.js';
import { BridgeBot } from '../bots/bridge-core.mjs';

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

const E18 = 10n ** 18n;
const GWEI = 10n ** 9n;
const H = BOT_HEADER_ACTIVATION;
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const pad = (a) => '0x' + a.slice(2).padStart(64, '0');
const hexq = (v) => '0x' + BigInt(v).toString(16);
const key = () => toHex(generatePrivateKey()).slice(2);
const addr = (k) => privateToAddress(k);

/* ------------------------------------------------------------ mock Ethereum */

class MockEth {
  constructor() {
    this.blocks = new Map();       // n -> { hash, root, receipts }
    this.txs = new Map();          // hash -> { n, i }
    this.claimed = new Set();
    this.anchors = new Map();      // molibra height -> { anchored, usable, at }
    this.claimRevert = null;
    this.sent = [];
    this.latest = 26_200_000n;
    this.base = 100_000_000n;      // 0.1 gwei
    this.balance = 10n ** 16n;
    this.nonce = 5n;
  }

  /** One block whose transaction `index` carries `logs`, filler around it. */
  addBlock(n, ethTx, logs, index = 1, size = 3) {
    const receipts = [];
    for (let i = 0; i < size; i++) {
      const own = i === index;
      receipts.push({
        type: '0x2', status: '0x1', cumulativeGasUsed: hexq(21000 * (i + 1)), logsBloom: '0x' + '00'.repeat(256),
        transactionHash: own ? ethTx : '0x' + word(1000 + i + Number(n % 1000n)), transactionIndex: hexq(i),
        blockNumber: hexq(n),
        logs: own ? logs.map((l, j) => ({ ...l, blockNumber: hexq(n), transactionHash: ethTx,
          transactionIndex: hexq(i), logIndex: hexq(j), removed: false })) : [],
      });
    }
    const trie = buildTrie(receipts.map((r, i) => [RLP.encode(i), encodeReceipt(r)]));
    this.blocks.set(n, { hash: '0x' + word(n * 7n), root: trie.root, receipts });
    this.txs.set(ethTx, { n, i: index });
  }

  transferToVault(n, ethTx, from, amount, opts = {}) {
    this.addBlock(n, ethTx, [{ address: opts.contract ?? BMOLI_CONTRACT,
      topics: [TRANSFER_TOPIC, pad(from), pad(opts.to ?? MOLI_RETURN_ADDRESS)], data: '0x' + word(amount) }]);
  }

  rpc = async (method, params) => {
    switch (method) {
      case 'eth_chainId': return '0x1';
      case 'eth_blockNumber': return hexq(this.latest);
      case 'eth_getTransactionReceipt': {
        const t = this.txs.get(params[0]);
        if (t) return this.blocks.get(t.n).receipts[t.i];
        const s = this.sent.find((x) => x.hash === params[0]);
        return s?.mined ? { status: s.mined } : null;
      }
      case 'eth_getBlockByNumber': {
        if (params[0] === 'latest') return { baseFeePerGas: hexq(this.base), number: hexq(this.latest) };
        const b = this.blocks.get(BigInt(params[0]));
        return b ? { hash: b.hash, receiptsRoot: b.root, number: params[0] } : null;
      }
      case 'eth_getBlockReceipts': return this.blocks.get(BigInt(params[0]))?.receipts ?? null;
      case 'eth_getLogs': {
        const { fromBlock, toBlock, address, topics } = params[0];
        const out = [];
        for (const [n, b] of this.blocks) {
          if (n < BigInt(fromBlock) || n > BigInt(toBlock)) continue;
          for (const r of b.receipts) {
            for (const l of r.logs) {
              if (l.address !== address || l.topics[0] !== topics[0] || l.topics[2] !== topics[2]) continue;
              out.push(l);
            }
          }
        }
        return out;
      }
      case 'eth_call': {
        const { data } = params[0];
        if (data.startsWith(SELECTORS.claimed)) return '0x' + word(this.claimed.has('0x' + data.slice(10)) ? 1 : 0);
        if (data.startsWith(SELECTORS.status)) {
          const a = this.anchors.get(BigInt('0x' + data.slice(10))) ?? { anchored: false, usable: false, at: 0n };
          return '0x' + word(a.anchored ? 1 : 0) + word(a.usable ? 1 : 0) + word(a.at) + word(0);
        }
        if (data.startsWith(SELECTORS.claim)) {
          if (this.claimRevert) {
            const e = new Error('eth_call: execution reverted');
            e.data = sel(this.claimRevert);
            e.code = 3;
            throw e;
          }
          return '0x';
        }
        throw new Error('unexpected eth_call');
      }
      case 'eth_estimateGas': return hexq(120_000);
      case 'eth_getBalance': return hexq(this.balance);
      case 'eth_getTransactionCount': return hexq(this.nonce);
      default: throw new Error(`MockEth: ${method}`);
    }
  };

  send = async (method, params) => {
    const t = decodeEip1559(params[0]);
    this.sent.push({ ...t, raw: params[0] });
    return t.hash;
  };
}

/* --------------------------------------------------------- mock Molibra node */

class MockNode {
  constructor({ height, botKeyAddress, publishBotRules = true }) {
    this.state = new State();
    this.height = BigInt(height);
    this.blocks = new Map();        // height -> [raw]
    this.mempool = [];
    this.included = new Map();      // hash -> height
    this.botKeyAddress = botKeyAddress;
    this.publishBotRules = publishBotRules;
    this.proofs = new Map();
    this.submitted = [];
  }

  /** The test bot key stands in for ETH_HEADER_BOT, whose real key is not in the repo. */
  as(tx) { return tx.from === this.botKeyAddress ? { ...tx, from: ETH_HEADER_BOT } : tx; }

  async mine(count = 1) {
    for (let k = 0; k < count; k++) {
      this.height += 1n;
      const included = [];
      for (const raw of [...this.mempool]) {
        const tx = this.as(decodeTransaction(raw, 20226));
        try {
          await applyTransaction(this.state, tx, intrinsicGas(tx), '0x' + '44'.repeat(20), this.height);
          included.push(raw);
          this.included.set(tx.hash, this.height);
          this.mempool = this.mempool.filter((r) => r !== raw);
        } catch { /* refused: stays in the mempool, as on a real node */ }
      }
      if (included.length) this.blocks.set(this.height, included);
    }
  }

  /** Put a transaction in a block directly (history the bot scans). */
  async include(raw, height) {
    const tx = this.as(decodeTransaction(raw, 20226));
    await applyTransaction(this.state, tx, intrinsicGas(tx), '0x' + '44'.repeat(20), BigInt(height));
    this.blocks.set(BigInt(height), [...(this.blocks.get(BigInt(height)) ?? []), raw]);
    this.included.set(tx.hash, BigInt(height));
    this.proofs.set(tx.hash, { blockNumber: Number(height), canonicalOnThisNode: true, raw,
      siblings: [], headerRlp: '0xc0' });
    return tx.hash;
  }

  get = async (path) => {
    const u = new URL('http://x' + path);
    if (path === '/molibra') {
      const o = this.state.outbound;
      return {
        height: this.height.toString(),
        activations: this.publishBotRules ? { botHeaders: { height: Number(H) } } : {},
        outbound: { burned: o.burned.toString(), outstanding: o.outstanding().toString(),
          ...(this.publishBotRules ? { botCap: { bot: ETH_HEADER_BOT,
            usedInWindow: o.botWindowUsed(this.height + 1n, 5760n).toString() } } : {}) },
      };
    }
    if (u.pathname === '/molibra/blocks') {
      const from = BigInt(u.searchParams.get('from'));
      const to = BigInt(u.searchParams.get('to'));
      const last = to > from + 511n ? from + 511n : to;
      const blocks = [];
      for (let n = from; n <= last && n <= this.height; n++) {
        const txs = this.blocks.get(n) ?? [];
        blocks.push({ header: { number: n.toString(), gasUsed: txs.length ? '21000' : '0' }, transactions: txs });
      }
      return { from: Number(from), to: Number(last), blocks };
    }
    if (path === '/molibra/bridge') {
      return { headers: [...this.state.inbound.headers.entries()].map(([k, v]) => {
        const [chainId, blockNumber] = k.split(':');
        return { chainId, blockNumber, receiptsRoot: v.receiptsRoot, committedBy: v.by };
      }) };
    }
    if (path.startsWith('/molibra/tx/')) {
      const h = path.slice(12);
      return this.included.has(h) ? { transaction: { hash: h }, receipt: { status: '0x1' } } : { error: 'transaction not found' };
    }
    if (path.startsWith('/molibra/proof/')) return this.proofs.get(path.slice(15)) ?? { error: 'no mined transaction' };
    throw new Error(`MockNode GET ${path}`);
  };

  rpc = async (method, params) => {
    const who = (a) => (String(a).toLowerCase() === this.botKeyAddress ? ETH_HEADER_BOT : a);
    switch (method) {
      case 'eth_chainId': return '0x4f02';
      case 'eth_gasPrice': return hexq(GWEI);
      case 'eth_getBalance': return hexq(this.state.balanceOf(who(params[0])));
      case 'eth_getTransactionCount': return hexq(this.state.nonceOf(who(params[0])));
      case 'eth_sendRawTransaction': {
        const tx = decodeTransaction(params[0], 20226);
        if (!this.mempool.includes(params[0])) this.mempool.push(params[0]);
        this.submitted.push(params[0]);
        return tx.hash;
      }
      default: throw new Error(`MockNode rpc ${method}`);
    }
  };
}

/* ---------------------------------------------------------------- helpers */

const BOT_KEY = key();
const BOT_ADDR = addr(BOT_KEY);
const RELAYER_KEY = key();
const RELAYER = addr(RELAYER_KEY);
const ALICE_KEY = key();
const ALICE = addr(ALICE_KEY);

function makeBot({ node, eth, cross = null, state = {}, dryRun = false, clock }) {
  const logs = [];
  const bot = new BridgeBot({
    io: { molibra: node, eth: { rpc: eth.rpc, cross: [{ name: 'cross', rpc: cross ?? eth.rpc }], logs: eth.rpc, send: eth.send } },
    keys: { headerBot: BOT_KEY, ethRelayer: RELAYER_KEY },
    state, save: () => {}, log: (level, event, f) => logs.push({ level, event, ...f }),
    now: clock ?? (() => Date.parse('2026-10-05T00:00:00Z')),
    // Fee gating has its own tests (test/express-anchor.mjs); these exercise the legs themselves.
    config: { dryRun, expectHeaderBot: BOT_ADDR, ethStartBlock: 26_100_000n, requireFees: false },
  });
  bot.logs = logs;
  return bot;
}
const roundTrip = (s) => JSON.parse(JSON.stringify(s));

/* ================================================================ claims */

console.log('claims: discovery, skips, one low-tip send');
{
  const node = new MockNode({ height: H - 1000n, botKeyAddress: BOT_ADDR });
  node.state.credit(ALICE, 2_000n * E18);
  const burn = (amount, nonce) => toHex(signTransaction({ nonce, gasPrice: GWEI, gasLimit: 100_000n,
    to: '0x' + '12'.repeat(20), value: 0n, data: encodeMoliBurn(ALICE, amount) }, ALICE_KEY, 20226n));
  const b1 = await node.include(burn(1n * E18, 0n), H - 1500n);
  const b2 = await node.include(burn(500n * E18, 1n), H - 1400n);
  const b3 = await node.include(burn(300n * E18, 2n), H - 1300n);
  const b4 = await node.include(burn(200n * E18, 3n), H - 1200n);
  const recent = await node.include(burn(5n * E18, 4n), H - 1010n);   // within MAX_REORG_DEPTH of the tip
  const eth = new MockEth();
  eth.claimed.add(b1);                                          // claimed long ago
  eth.anchors.set(H - 1300n, { anchored: true, usable: false, at: 26_190_000n });
  eth.anchors.set(H - 1200n, { anchored: true, usable: true, at: 26_180_000n });
  eth.anchors.set(H - 1400n, { anchored: true, usable: true, at: 26_180_000n });

  const state = { molibraScan: { next: (H - 2000n).toString() } };
  const bot = makeBot({ node, eth, state });
  await bot.tick();
  const s = bot.state.burns;
  check('every burn below the reorg depth is discovered', Boolean(s[b1] && s[b2] && s[b3] && s[b4]));
  check('⛔ a burn inside the reorg depth is not recorded yet', !s[recent]);
  check('already claimed on Ethereum -> claimed, nothing sent', s[b1].status === 'claimed');
  check('anchored but window open -> waits, nothing sent', s[b3].status === 'challenge-window',
    `usable at ${s[b3].usableAtEthBlock}`);
  check('⛔ exactly ONE claim sent per tick', eth.sent.length === 1, `${eth.sent.length} sent`);
  const t = eth.sent[0];
  check('it is the OLDEST claimable burn', s[b2].status === 'sent' && s[b4].status === 'ready');
  check('sent from the relayer, to bMOLI, on chain 1', t.from === RELAYER && t.to === BMOLI_CONTRACT && t.chainId === 1n);
  check('⛔ with an EXPLICIT 0.05 gwei tip', t.maxPriorityFeePerGas === 50_000_000n, `${t.maxPriorityFeePerGas} wei`);
  check('⛔ and maxFee = base*2 + tip', t.maxFeePerGas === eth.base * 2n + 50_000_000n, `${t.maxFeePerGas} wei`);
  check('the calldata is a claim()', t.data.startsWith(SELECTORS.claim));

  // Restart: a new bot from the saved state must not send a second claim.
  const bot2 = makeBot({ node, eth, state: roundTrip(bot.state) });
  await bot2.tick();
  const distinct = () => new Set(eth.sent.map((x) => x.hash)).size;
  check('⛔ after a restart the in-flight claim is not sent again (only the same bytes rebroadcast)',
    distinct() === 1, `${distinct()} distinct, ${eth.sent.length} broadcasts`);
  eth.claimed.add(b2);
  eth.sent[0].mined = '0x1';
  await bot2.tick();
  check('once mined it is claimed, and the next burn goes', bot2.state.burns[b2].status === 'claimed'
    && bot2.state.burns[b4].status === 'sent' && distinct() === 2);

  eth.claimRevert = 'AlreadyClaimed()';
  const bot3 = makeBot({ node, eth, state: { molibraScan: { next: (H - 2000n).toString() } } });
  await bot3.tick();
  check('a pre-flight AlreadyClaimed is read by name -> claimed', bot3.state.burns[b4].status === 'claimed');
  eth.claimRevert = null;

  const eth2 = new MockEth();
  eth2.anchors.set(H - 1400n, { anchored: true, usable: true, at: 1n });
  const dry = makeBot({ node, eth: eth2, state: { molibraScan: { next: (H - 2000n).toString() } }, dryRun: true });
  await dry.tick();
  check('⛔ --dry-run signs and reads back, and sends NOTHING', eth2.sent.length === 0
    && dry.state.burns[b2].status === 'ready' && /DRY-RUN/.test(dry.state.burns[b2].note));
  check('an unanchored burn is handed to a person', dry.pendingItems().some((i) => i.molibraTx === b1
    && i.status === 'awaiting-anchor'));
}

/* =============================================================== returns */

console.log('\nreturns: disagreement, flag day, the full path, the cap');

async function returnWorld({ height = H + 10n, publishBotRules = true } = {}) {
  const node = new MockNode({ height, botKeyAddress: BOT_ADDR, publishBotRules });
  node.state.credit(ALICE, 30_000n * E18);
  node.state.credit(ETH_HEADER_BOT, 1n * E18);
  node.state.credit(ETH_HEADER_AUTHORITY, 1n * E18);
  // 20,000 MOLI went out, so up to that may come back.
  await applyTransaction(node.state, { from: ALICE, to: ALICE, value: 0n, nonce: 0n, gasPrice: 0n,
    gasLimit: 100_000n, data: encodeMoliBurn(ALICE, 20_000n * E18) }, 21_000n, '0x' + '44'.repeat(20), 100_000n);
  return { node, eth: new MockEth() };
}
const startAt = (n) => ({ molibraScan: { next: (n - 50n).toString() } });

{
  const { node, eth } = await returnWorld();
  eth.transferToVault(26_150_000n, '0x' + 'a1'.repeat(32), ALICE, 10n * E18);
  const liar = async (m, p) => {
    const r = await eth.rpc(m, p);
    return m === 'eth_getBlockByNumber' && r?.receiptsRoot ? { ...r, receiptsRoot: '0x' + 'ee'.repeat(32) } : r;
  };
  const bot = makeBot({ node, eth, cross: liar, state: startAt(node.height) });
  await bot.tick();
  const r = bot.state.returns['0x' + 'a1'.repeat(32)];
  check('⛔⛔ two RPCs disagree on the root -> aborted, nothing submitted',
    r.status === 'rpc-disagreement' && node.submitted.length === 0, r.status);
  check('and it is written for a person', bot.pendingItems().some((i) => i.status === 'rpc-disagreement'));
}

{
  const { node, eth } = await returnWorld({ height: H - 100n });
  eth.transferToVault(26_150_000n, '0x' + 'a2'.repeat(32), ALICE, 10n * E18);
  const bot = makeBot({ node, eth, state: startAt(node.height) });
  const s = await bot.tick();
  check('⛔ below the flag day the return leg is dry-run automatically', !s.returnsLive
    && node.submitted.length === 0 && bot.state.returns['0x' + 'a2'.repeat(32)].status === 'ready');
}

{
  const { node, eth } = await returnWorld({ publishBotRules: false });
  eth.transferToVault(26_150_000n, '0x' + 'a3'.repeat(32), ALICE, 10n * E18);
  const bot = makeBot({ node, eth, state: startAt(node.height) });
  const s = await bot.tick();
  check('⛔ a node that does not publish the bot rules gets nothing sent', !s.returnsLive && node.submitted.length === 0);
}

{
  const { node, eth } = await returnWorld();
  const tx = '0x' + 'a4'.repeat(32);
  eth.transferToVault(26_149_000n, tx, ALICE, 3_000n * E18);
  eth.transferToVault(26_149_995n, '0x' + 'a5'.repeat(32), ALICE, 2_500n * E18);
  eth.latest = 26_150_005n;    // the second is 10 deep: under 12, not yet
  let bot = makeBot({ node, eth, state: startAt(node.height) });
  await bot.tick();
  check('⛔ a transfer under 12 confirmations is not picked up', !bot.state.returns['0x' + 'a5'.repeat(32)]);
  check('the bot commits the root first, from its own key', node.submitted.length === 1
    && bot.state.returns[tx].status === 'header-sent');

  // Restart mid-flight: nothing new is sent while the header is unconfirmed.
  bot = makeBot({ node, eth, state: roundTrip(bot.state) });
  await bot.tick();
  check('⛔ after a restart mid-flight no second commit is built', node.submitted.length === 1
    || node.submitted.every((r) => r === node.submitted[0]));

  await node.mine();
  check('the root is on Molibra, by the bot', node.state.inbound.headerFor(1n, 26_149_000n)?.by === ETH_HEADER_BOT);
  const before = node.state.balanceOf(ALICE);
  await bot.tick();
  check('then the MOLI_RETURN', bot.state.returns[tx].status === 'return-sent');
  await node.mine();
  check('⭐ consensus pays the SENDER on the bot root', node.state.balanceOf(ALICE) === before + 3_000n * E18);
  check('and counts it in the window', node.state.outbound.botWindowUsed(node.height, 5760n) === 3_000n * E18);
  await bot.tick();
  check('next pass sees it returned', bot.state.returns[tx].status === 'returned');

  eth.latest = 26_160_000n;
  await bot.tick();
  const r5 = bot.state.returns['0x' + 'a5'.repeat(32)];
  check('⛔⛔ a return the rolling cap would refuse is NOT sent', r5.status === 'waiting-cap'
    && !node.submitted.some((raw) => decodeTransaction(raw, 20226).data === r5.commitData),
    `${r5.status}, used ${r5.usedInWindow}`);
  const item = bot.pendingItems().find((i) => i.ethTx === '0x' + 'a5'.repeat(32));
  check('it is handed to the operator with the uncapped way through', Boolean(item?.operatorCommit
    && item.page.includes('/molibra/return?commit=')));

  // The operator commits that root: uncapped from then on.
  await applyTransaction(node.state, { from: ETH_HEADER_AUTHORITY, to: ETH_HEADER_AUTHORITY, value: 0n,
    nonce: node.state.nonceOf(ETH_HEADER_AUTHORITY), gasPrice: 0n, gasLimit: 100_000n,
    data: encodeHeaderCommit({ originChainId: 1n, blockNumber: 26_149_995n, receiptsRoot: eth.blocks.get(26_149_995n).root }) },
  30_000n, '0x' + '44'.repeat(20), node.height);
  const a = node.state.balanceOf(ALICE);
  await bot.tick();
  await node.mine();
  check('⭐ on an operator root the bot relays the return, uncapped', node.state.balanceOf(ALICE) === a + 2_500n * E18);
}

{
  const { node, eth } = await returnWorld();
  const tx = '0x' + 'a6'.repeat(32);
  eth.transferToVault(26_150_000n, tx, ALICE, 6_000n * E18);
  const bot = makeBot({ node, eth, state: startAt(node.height) });
  await bot.tick();
  check('⛔ one return above the cap is the operator\'s, nothing sent',
    bot.state.returns[tx].status === 'needs-operator' && node.submitted.length === 0);
}

{
  const { node, eth } = await returnWorld();
  const tx = '0x' + 'a7'.repeat(32);
  eth.transferToVault(26_150_000n, tx, ALICE, 10n * E18);
  await applyTransaction(node.state, { from: ETH_HEADER_AUTHORITY, to: ETH_HEADER_AUTHORITY, value: 0n,
    nonce: 0n, gasPrice: 0n, gasLimit: 100_000n,
    data: encodeHeaderCommit({ originChainId: 1n, blockNumber: 26_150_000n, receiptsRoot: '0x' + '0f'.repeat(32) }) },
  30_000n, '0x' + '44'.repeat(20), node.height);
  const bot = makeBot({ node, eth, state: startAt(node.height) });
  await bot.tick();
  check('⛔⛔ a committed root that differs from the RPCs -> root-conflict, nothing sent',
    bot.state.returns[tx].status === 'root-conflict' && node.submitted.length === 0);
}

{
  // A header tx that consensus keeps refusing is superseded at the same nonce.
  const { node, eth } = await returnWorld();
  const tx = '0x' + 'a8'.repeat(32);
  eth.transferToVault(26_150_000n, tx, ALICE, 10n * E18);
  let now = Date.parse('2026-10-05T00:00:00Z');
  const bot = makeBot({ node, eth, state: startAt(node.height), clock: () => now });
  await bot.tick();
  const first = decodeTransaction(node.submitted[0], 20226);
  node.mempool = [];                       // lost: never mined
  await bot.tick();
  check('inside the resend window the SAME bytes are rebroadcast', node.submitted.length === 2
    && node.submitted[1] === node.submitted[0]);
  now += 25 * 60_000;
  await bot.tick();
  const third = decodeTransaction(node.submitted.at(-1), 20226);
  check('⛔ after it, the next send re-uses the confirmed nonce (supersedes)', third.nonce === first.nonce,
    `nonce ${third.nonce}`);
  await node.mine();
  check('and that one is mined', node.state.inbound.headerFor(1n, 26_150_000n)?.by === ETH_HEADER_BOT);
}

/* ================================================================ signer */

console.log('\nthe EIP-1559 signer');
{
  // Golden vector, checked against @ethereumjs/tx 10 on 2 Oct 2026 (same sender, same hash).
  const k = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
  const raw = signEip1559({ chainId: 1n, nonce: 7n, maxPriorityFeePerGas: 50_000_000n, maxFeePerGas: 612_345_678n,
    gasLimit: 150_000n, to: BMOLI_CONTRACT, value: 0n,
    data: '0x28f2d6f50000000000000000000000000000000000000000000000000000000000001234' }, k);
  const d = decodeEip1559(raw);
  check('the signed bytes match the ethereumjs-checked vector', toHex(keccak256(fromHex(raw)))
    === '0x93a7020a58b529e84ffacdc114a52015f72d99fbd6398d0c49d9aa922ee9fef1');
  check('and recover the signer', d.from === '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23');
}
check('the spent-key helper agrees with consensus', typeof returnKey(1n, 2n) === 'string' && BOT_RETURN_CAP === 5_000n * E18);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
