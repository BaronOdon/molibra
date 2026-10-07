/**
 * The fast (inventory) leg of the bridge bot, against in-memory chains.
 * Nothing touches a network: both chains are mocks that answer the exact calls
 * bots/fastbridge-core.mjs makes, and every payout is decoded and checked.
 */
import { readFileSync } from 'node:fs';
import { FastBridge, FAST_DEFAULTS, quote, erc20PayoutData, sourceOfErc20Payout } from '../bots/fastbridge-core.mjs';
import { signTransaction, decodeTransaction } from '../src/tx.js';
import { decodeEip1559 } from '../src/eth1559.js';
import { generatePrivateKey, privateToAddress, toHex, normalizeAddress } from '../src/crypto.js';
import { BMOLI_CONTRACT } from '../src/molireturn.js';
import { TRANSFER_TOPIC } from '../src/burnproof.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
};
const WEI = 10n ** 18n;
const lower = (s) => String(s).toLowerCase();
const hex = (n) => '0x' + BigInt(n).toString(16);
const pad = (a) => '0x' + lower(a).replace(/^0x/, '').padStart(64, '0');
const keyHex = () => toHex(generatePrivateKey());
const addrOf = (k) => lower(normalizeAddress(privateToAddress(k.replace(/^0x/, ''))));
const randHash = () => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');

/* ------------------------------------------------------------- the mocks */

function world() {
  const invKey = keyHex();
  const inv = addrOf(invKey);
  const W = {
    invKey, inv,
    // Molibra
    m: { height: 1000n, blocks: new Map(), txs: new Map(), balance: new Map([[inv, 50_000n * WEI]]), nonce: new Map(), sent: [] },
    // Ethereum
    e: { block: 5000n, logs: [], receipts: new Map(), txs: new Map(), bmoli: new Map([[inv, 50_000n * WEI]]),
      eth: new Map([[inv, 10n ** 17n]]), code: new Map(), nonce: new Map(), sent: [],
      // A LOW price by default so the 1-MOLI floor or 0.5% decides; tests of gas set the real one.
      perEth: 33_332, baseFee: 0n },
    nodeHashOverride: null,
  };
  const blockHash = (n) => '0x' + n.toString(16).padStart(64, 'b');
  W.molibraBlock = (n, txRaws) => {
    W.m.blocks.set(n, { header: { number: n.toString(), hash: blockHash(n), gasUsed: '1' }, transactions: txRaws });
    for (const raw of txRaws) {
      const tx = decodeTransaction(raw, 20226n);
      W.m.txs.set(tx.hash, { transaction: { blockNumber: hex(n), blockHash: blockHash(n), from: tx.from, to: tx.to, value: hex(tx.value), input: tx.data }, receipt: { status: '0x1' } });
    }
  };
  W.userSendsMoli = (userKey, amount, at) => {
    const raw = toHex(signTransaction({ nonce: 0n, gasPrice: 1n, gasLimit: 21000n, to: inv, value: amount, data: '0x' }, userKey.replace(/^0x/, ''), 20226n));
    W.molibraBlock(at, [raw]);
    return decodeTransaction(raw, 20226n).hash;
  };
  W.userSendsBmoli = (from, amount, at) => {
    const h = randHash();
    const bh = '0x' + at.toString(16).padStart(64, 'e');
    const log = { address: BMOLI_CONTRACT, topics: [TRANSFER_TOPIC, pad(from), pad(inv)], data: hex(amount),
      blockNumber: hex(at), blockHash: bh, transactionHash: h, logIndex: '0x0' };
    W.e.logs.push(log);
    W.e.receipts.set(h, { status: '0x1', blockHash: bh, logs: [log] });
    return h;
  };
  W.mineEthPayouts = () => {
    for (const raw of W.e.sent.splice(0)) {
      const tx = decodeEip1559(raw);
      const to = '0x' + tx.data.slice(34, 74); const amount = BigInt('0x' + tx.data.slice(74, 138));
      W.e.block += 1n;
      const log = { address: BMOLI_CONTRACT, topics: [TRANSFER_TOPIC, pad(tx.from), pad(to)], data: hex(amount),
        blockNumber: hex(W.e.block), blockHash: '0x' + W.e.block.toString(16).padStart(64, 'f'), transactionHash: tx.hash, logIndex: '0x0' };
      W.e.logs.push(log);
      W.e.receipts.set(tx.hash, { status: '0x1', blockHash: log.blockHash, logs: [log] });
      W.e.txs.set(tx.hash, { input: tx.data });
      W.e.bmoli.set(tx.from, (W.e.bmoli.get(tx.from) ?? 0n) - amount);
      W.e.bmoli.set(lower(to), (W.e.bmoli.get(lower(to)) ?? 0n) + amount);
      W.e.nonce.set(tx.from, (W.e.nonce.get(tx.from) ?? 0n) + 1n);
    }
  };
  W.mineMolibraPayouts = () => {
    const raws = W.m.sent.splice(0);
    if (!raws.length) return;
    W.m.height += 1n;
    W.molibraBlock(W.m.height, raws);
    for (const raw of raws) {
      const tx = decodeTransaction(raw, 20226n);
      W.m.balance.set(lower(tx.from), (W.m.balance.get(lower(tx.from)) ?? 0n) - tx.value);
      W.m.balance.set(lower(tx.to), (W.m.balance.get(lower(tx.to)) ?? 0n) + tx.value);
      W.m.nonce.set(lower(tx.from), (W.m.nonce.get(lower(tx.from)) ?? 0n) + 1n);
    }
  };
  const molibraGet = async (path, nodeName = 'a') => {
    if (path === '/molibra') return { height: W.m.height.toString() };
    if (path.startsWith('/molibra/blocks')) {
      const u = new URL('http://x' + path); const from = BigInt(u.searchParams.get('from')); const to = BigInt(u.searchParams.get('to'));
      const blocks = []; for (let n = from; n <= to; n++) if (W.m.blocks.has(n)) blocks.push(W.m.blocks.get(n));
      return { from: from.toString(), to: to.toString(), blocks: blocks.length ? blocks : (from <= to ? [{ header: { number: to.toString(), gasUsed: '0' }, transactions: [] }] : []) };
    }
    if (path.startsWith('/molibra/tx/')) return W.m.txs.get(path.slice(12)) ?? { error: 'transaction not found' };
    if (path.startsWith('/molibra/block/')) {
      const n = BigInt(path.slice(15)); const b = W.m.blocks.get(n);
      if (!b) return { error: 'not found' };
      return { header: { ...b.header, hash: nodeName === 'b' && W.nodeHashOverride ? W.nodeHashOverride : b.header.hash } };
    }
    throw new Error('mock molibra: ' + path);
  };
  const molibraRpc = async (method, params) => {
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_getBalance') return hex(W.m.balance.get(lower(params[0])) ?? 0n);
    if (method === 'eth_getTransactionCount') return hex(W.m.nonce.get(lower(params[0])) ?? 0n);
    if (method === 'eth_sendRawTransaction') { W.m.sent.push(params[0]); return decodeTransaction(params[0], 20226n).hash; }
    throw new Error('mock molibra rpc: ' + method);
  };
  const ethRpc = async (method, params) => {
    if (method === 'eth_blockNumber') return hex(W.e.block);
    if (method === 'eth_getLogs') {
      const f = params[0]; const lo = BigInt(f.fromBlock); const hi = BigInt(f.toBlock);
      return W.e.logs.filter((l) => BigInt(l.blockNumber) >= lo && BigInt(l.blockNumber) <= hi
        && f.topics.every((t, i) => t === null || lower(t) === lower(l.topics[i])));
    }
    if (method === 'eth_getTransactionReceipt') return W.e.receipts.get(params[0]) ?? null;
    if (method === 'eth_getTransactionByHash') return W.e.txs.get(params[0]) ?? null;
    if (method === 'eth_call') {
      const d = params[0].data;
      if (lower(params[0].to) === lower(FAST_DEFAULTS.stateView)) return pad(sqrtOf(W.e.perEth)) + '0'.repeat(64 * 3);
      if (d.startsWith('0x70a08231')) return pad(hex(W.e.bmoli.get('0x' + d.slice(-40)) ?? 0n));
      if (d.startsWith('0xa9059cbb')) return pad('0x1');
      throw new Error('mock eth_call ' + d.slice(0, 10));
    }
    if (method === 'eth_getBlockByNumber') return { baseFeePerGas: hex(W.e.baseFee) };
    if (method === 'eth_getBalance') return hex(W.e.eth.get(lower(params[0])) ?? 0n);
    if (method === 'eth_getTransactionCount') return hex(W.e.nonce.get(lower(params[0])) ?? 0n);
    if (method === 'eth_getCode') return W.e.code.get(lower(params[0])) ?? '0x';
    throw new Error('mock eth rpc: ' + method);
  };
  W.io = {
    molibra: { get: (p) => molibraGet(p, 'a'), rpc: molibraRpc },
    molibraNodes: [{ name: 'a', get: (p) => molibraGet(p, 'a') }, { name: 'b', get: (p) => molibraGet(p, 'b') }],
    eth: { rpc: ethRpc, logs: ethRpc, send: async (m, p) => { W.e.sent.push(p[0]); return decodeEip1559(p[0]).hash; } },
  };
  return W;
}
/** sqrtPriceX96 for `perEth` bMOLI per ETH. */
const sqrtOf = (perEth) => hex(BigInt(Math.round(Math.sqrt(perEth) * 2 ** 48)) << 48n);
const GWEI = 1_000_000_000n;

// The payout scenarios run with sweeping out of the way (inventory caps far above
// any balance here); the sweep has its own section at the end.
const NO_SWEEP = { maxInventoryMoliWei: 10n ** 30n, maxInventoryBmoliWei: 10n ** 30n };
function bridge(W, state = {}, config = {}, log = () => {}) {
  return new FastBridge({ io: W.io, key: W.invKey, state, save: () => {}, log, config: { ...NO_SWEEP, ...config } });
}

/* ------------------------------------------------------------------ pure */
console.log('\n1. the pure parts\n');
{
  const q = quote(100n * WEI);
  check('fee is 0.5% with a 1-MOLI floor: 100 MOLI pays 99', q.fee === 1n * WEI && q.out === 99n * WEI);
  const q2 = quote(1000n * WEI);
  check('1,000 MOLI pays 995 (0.5%)', q2.fee === 5n * WEI && q2.out === 995n * WEI);
  check('below the fee pays nothing', quote(WEI / 2n).out === 0n);
  const src = randHash(); const d = erc20PayoutData('0x' + '12'.repeat(20), 7n, src);
  check('the ERC-20 payout carries the source hash and reads it back', sourceOfErc20Payout(d) === lower(src));
  check('defaults: 12 Molibra / 3 Ethereum confirmations, 2,000 per transfer, 10,000 per hour',
    FAST_DEFAULTS.molibraConfirmations === 12n && FAST_DEFAULTS.ethConfirmations === 3n
    && FAST_DEFAULTS.maxPerTransferWei === 2_000n * WEI && FAST_DEFAULTS.maxPerHourWei === 10_000n * WEI);
}

/* --------------------------------------------------------- MOLI -> bMOLI */
console.log('\n2. MOLI -> bMOLI\n');
{
  const W = world(); const state = {}; const fb = bridge(W, state);
  await fb.tick();   // the fresh state starts at the tips
  check('a fresh state starts at the tips (history is never re-paid)', state.molibraNext === '1001' && state.ethNext === '5001');
  const user = keyHex(); const ua = addrOf(user);
  const src = W.userSendsMoli(user, 100n * WEI, 1001n);
  W.m.height = 1005n; await fb.tick();
  check('not recorded before 12 confirmations', !state.items[src]);
  W.m.height = 1013n; await fb.tick();
  check('recorded at 12 confirmations', state.items[src]?.dir === 'm2b');
  check('and a bMOLI payout was sent in the same tick', state.items[src]?.status === 'sent' && W.e.sent.length === 1);
  const tx = decodeEip1559(W.e.sent[0]);
  check('the payout goes to the bMOLI contract from the inventory', lower(tx.to) === lower(BMOLI_CONTRACT) && tx.from === W.inv);
  check('it pays the sender amount - fee (99 bMOLI) and carries the source hash',
    tx.data.slice(34, 74) === ua.slice(2) && BigInt('0x' + tx.data.slice(74, 138)) === 99n * WEI && sourceOfErc20Payout(tx.data) === lower(src));
  check('chain id 1, value 0, low explicit tip', tx.chainId === 1n && tx.value === 0n && tx.maxPriorityFeePerGas === 50_000_000n);
  W.mineEthPayouts(); await fb.tick();
  check('paid once its receipt is in', state.items[src].status === 'paid' && W.e.bmoli.get(ua) === 99n * WEI);
  await fb.tick();
  check('and never sent again', W.e.sent.length === 0);
}

/* --------------------------------------------------------- bMOLI -> MOLI */
console.log('\n3. bMOLI -> MOLI\n');
{
  const W = world(); const state = {}; const fb = bridge(W, state);
  await fb.tick();
  const ua = addrOf(keyHex());
  const src = W.userSendsBmoli(ua, 500n * WEI, 5001n);
  W.e.block = 5002n; await fb.tick();
  check('not recorded before 3 Ethereum confirmations', !state.items[src]);
  W.e.block = 5004n; await fb.tick();
  check('recorded at 3 confirmations and MOLI sent', state.items[src]?.status === 'sent' && W.m.sent.length === 1);
  const tx = decodeTransaction(W.m.sent[0], 20226n);
  check('the MOLI payout: inventory -> sender, 497.5 MOLI, data = source hash',
    lower(tx.from) === W.inv && lower(tx.to) === ua && tx.value === 4975n * WEI / 10n && lower(tx.data) === lower(src));
  W.mineMolibraPayouts(); await fb.tick();
  check('paid once mined', state.items[src].status === 'paid' && W.m.balance.get(ua) === 4975n * WEI / 10n);
}

/* ----------------------------------------------- the user pays every cost */
console.log('\n3b. the fee covers the payout gas\n');
{
  check('quote() takes the larger of 0.5%, 2 x gas and the floor', quote(1_000n * WEI, FAST_DEFAULTS, 60n * WEI).fee === 120n * WEI
    && quote(1_000n * WEI, FAST_DEFAULTS, 1n * WEI).fee === 5n * WEI);
  const W = world(); W.e.perEth = 333_322; W.e.baseFee = 1n * GWEI;   // real price, a 1-gwei base fee
  const state = {}; const fb = bridge(W, state);
  await fb.tick();
  const g = await fb.gasCosts();
  // 90,000 gas x (2 x 1 gwei + 0.05 gwei) = 0.0001845 ETH x 333,322 = ~61.5 MOLI
  check('the Ethereum payout gas, in MOLI, read live (~61.5 at 1 gwei)', g.m2b > 61n * WEI && g.m2b < 62n * WEI, (Number(g.m2b) / 1e18).toFixed(2));
  const src = W.userSendsMoli(keyHex(), 1_000n * WEI, 1001n);
  W.m.height = 1013n; await fb.tick();
  const tx = decodeEip1559(W.e.sent[0]);
  const paid = BigInt('0x' + tx.data.slice(74, 138));
  check('1,000 MOLI pays 1,000 - 2 x gas (~877): the user, not the operator, pays the gas',
    paid === 1_000n * WEI - BigInt(state.items[src].feeWei) && BigInt(state.items[src].feeWei) > 2n * 61n * WEI, (Number(paid) / 1e18).toFixed(2));
  const small = W.userSendsMoli(keyHex(), 100n * WEI, 1014n);
  W.m.height = 1026n; await fb.tick();
  check('a transfer smaller than 2 x gas: below-fee, nothing sent', state.items[small].status === 'below-fee');
}
{
  const W = world(); const state = {}; const fb = bridge(W, state);
  await fb.tick();
  const src = W.userSendsMoli(keyHex(), 100n * WEI, 1001n);
  W.e.perEth = 333_322; W.e.baseFee = 0n;          // recorded at a calm moment
  W.m.height = 1013n;
  const realPayouts = fb.payouts.bind(fb); fb.payouts = async () => {};   // record now, pay next tick
  await fb.tick(); fb.payouts = realPayouts;
  const fee = BigInt(state.items[src].feeWei);
  W.e.baseFee = 5n * GWEI;                          // then gas spikes past that fee
  await fb.tick();
  check('a gas spike past the fee the transfer carries: it WAITS (the operator never absorbs gas)',
    state.items[src].status === 'waiting-gas' && W.e.sent.length === 0, 'fee ' + (Number(fee) / 1e18).toFixed(2) + ' MOLI');
  check('and it is on the pending list with the reason', fb.pendingItems().some((p) => p.sourceTx === src && /never absorbs/.test(p.why)));
  W.e.baseFee = 0n; await fb.tick();
  check('gas back down: paid, with the fee fixed at recording', state.items[src].status === 'sent'
    && BigInt('0x' + decodeEip1559(W.e.sent[0]).data.slice(74, 138)) === 100n * WEI - fee);
}

/* --------------------------------------------------------------- limits */
console.log('\n4. limits and inventory\n');
{
  const W = world(); const state = {}; const fb = bridge(W, state);
  await fb.tick();
  const big = W.userSendsMoli(keyHex(), 3_000n * WEI, 1001n);
  W.m.height = 1013n; await fb.tick();
  check('above the per-transfer limit: NOT paid, flagged for the operator', state.items[big].status === 'over-limit' && W.e.sent.length === 0);
  check('and it is in the pending list with the reason', fb.pendingItems().some((p) => p.sourceTx === big && /per-transfer/.test(p.why)));
}
{
  const W = world(); W.e.bmoli.set(W.inv, 10n * WEI);
  const state = {}; const fb = bridge(W, state);
  await fb.tick();
  const src = W.userSendsMoli(keyHex(), 100n * WEI, 1001n);
  W.m.height = 1013n; await fb.tick();
  check('not enough bMOLI in the inventory: insufficient-inventory, nothing sent', state.items[src].status === 'insufficient-inventory' && W.e.sent.length === 0);
  W.e.bmoli.set(W.inv, 1_000n * WEI); await fb.tick();
  check('refilled: paid on the next tick', state.items[src].status === 'sent' && W.e.sent.length === 1);
}
{
  const W = world(); const state = {}; const fb = bridge(W, state, { maxPerHourWei: 3_000n * WEI });
  await fb.tick();
  const a = W.userSendsMoli(keyHex(), 2_000n * WEI, 1001n);
  const b = W.userSendsMoli(keyHex(), 2_000n * WEI, 1002n);
  W.m.height = 1014n; await fb.tick();
  W.mineEthPayouts(); await fb.tick();
  check('the rolling hourly limit holds the second transfer back', state.items[a].status === 'paid' && state.items[b].status === 'waiting-limit');
}

/* -------------------------------------------------- never pay twice */
console.log('\n5. never pay twice\n');
{
  const W = world(); const state = {}; const fb = bridge(W, state);
  await fb.tick();
  const src = W.userSendsMoli(keyHex(), 100n * WEI, 1001n);
  W.m.height = 1013n; await fb.tick(); W.mineEthPayouts();
  // A restart that lost the payout record but not the item (the worst case).
  const lost = JSON.parse(JSON.stringify(state));
  Object.assign(lost.items[src], { status: 'confirmed', payoutTx: undefined, payoutRaw: undefined, sentAt: undefined });
  const fb2 = bridge(W, lost); await fb2.tick();
  check('a lost payout record is found ON CHAIN by its source hash: paid, nothing re-sent',
    lost.items[src].status === 'paid' && W.e.sent.length === 0, lost.items[src].note ?? '');
}
{
  const W = world(); const state = {}; const fb = bridge(W, state);
  await fb.tick();
  const src = W.userSendsBmoli(addrOf(keyHex()), 50n * WEI, 5001n);
  W.e.block = 5004n; await fb.tick(); W.mineMolibraPayouts();
  const lost = JSON.parse(JSON.stringify(state));
  Object.assign(lost.items[src], { status: 'confirmed', payoutTx: undefined, payoutRaw: undefined, sentAt: undefined });
  const fb2 = bridge(W, lost); await fb2.tick();
  check('the same on Molibra: the earlier MOLI payout is found by its data, nothing re-sent',
    lost.items[src].status === 'paid' && W.m.sent.length === 0);
}

/* --------------------------------------------------- anomalies */
console.log('\n6. anomalies pause the leg\n');
{
  const W = world(); const state = {}; const fb = bridge(W, state, { dryRun: true });
  await fb.tick();
  const src = W.userSendsMoli(keyHex(), 100n * WEI, 1001n);
  W.m.height = 1013n; await fb.tick();
  W.m.txs.delete(src);   // the source vanished after confirmation
  await fb.tick();
  check('a source that vanished after confirmation: reorged + the leg PAUSED', state.items[src].status === 'reorged' && Boolean(state.paused));
  const before = W.e.sent.length; const s = await fb.tick();
  check('while paused nothing is scanned or paid', W.e.sent.length === before && Boolean(s.paused));
  check('the pause is in the pending list', fb.pendingItems().some((p) => p.status === 'paused'));
}
{
  const W = world(); const state = {}; const fb = bridge(W, state);
  await fb.tick();
  W.userSendsMoli(keyHex(), 100n * WEI, 1001n);
  W.nodeHashOverride = '0x' + 'ab'.repeat(32);
  W.m.height = 1013n; await fb.tick();
  check('two Molibra nodes disagreeing about the source block: paused, nothing paid', Boolean(state.paused) && W.e.sent.length === 0);
}
{
  const W = world(); const state = {}; const fb = bridge(W, state);
  await fb.tick();
  const routerAddr = addrOf(keyHex()); W.e.code.set(routerAddr, '0x6080');
  const src = W.userSendsBmoli(routerAddr, 50n * WEI, 5001n);
  W.e.block = 5004n; await fb.tick();
  check('bMOLI from a CONTRACT: no MOLI sent to that address, flagged', state.items[src].status === 'contract-sender' && W.m.sent.length === 0);
}
{
  const W = world(); const state = {}; let calls = 0;
  W.io.molibra.get = async () => { calls++; throw new Error('down'); };
  const fb = bridge(W, state);
  await fb.tick(); await fb.tick(); await fb.tick();
  check('three ticks unable to read the chains: paused', Boolean(state.paused) && calls >= 3);
}

/* ------------------------------------------------------------- dry-run */
console.log('\n7. dry-run\n');
{
  const W = world(); const state = {}; const fb = bridge(W, state, { dryRun: true });
  await fb.tick();
  const src = W.userSendsMoli(keyHex(), 100n * WEI, 1001n);
  W.m.height = 1013n; await fb.tick();
  check('dry-run: signed and read back, NOT sent', state.items[src].status === 'ready' && W.e.sent.length === 0 && /DRY-RUN/.test(state.items[src].note));
}

/* ------------------------------------------------- the service wiring */
console.log('\n8. the service and the page\n');
{
  const svc = readFileSync(new URL('../bots/bridge-bot.mjs', import.meta.url), 'utf8');
  check('the service runs the fast leg only with its key', svc.includes('k.fastInventory') && svc.includes('new FastBridge'));
  check('STOP-FAST pauses only the fast leg', svc.includes("'STOP-FAST'") && svc.includes('fast.tick()'));
  check('payouts go to an append-only ledger too', svc.includes('fast-payouts'));
  const rpc = readFileSync(new URL('../src/rpc.js', import.meta.url), 'utf8');
  check('the node serves /molibra/rapido and /molibra/fastbridge.json', rpc.includes("'/molibra/rapido'") && rpc.includes("'/molibra/fastbridge.json'"));
  const page = readFileSync(new URL('../src/web/rapido.html', import.meta.url), 'utf8');
  const cfg = JSON.parse(readFileSync(new URL('../src/web/fastbridge.json', import.meta.url), 'utf8'));
  check('fastbridge.json publishes the inventory, fee and limits', /^0x[0-9a-f]{40}$/.test(cfg.inventory) && cfg.feeBp === 50 && cfg.maxPerTransfer === '2000');
  check('the published limits equal the bot defaults',
    BigInt(cfg.maxPerTransfer) * WEI === FAST_DEFAULTS.maxPerTransferWei && BigInt(cfg.maxPerHour) * WEI === FAST_DEFAULTS.maxPerHourWei
    && BigInt(cfg.maxPerDay) * WEI === FAST_DEFAULTS.maxPerDayWei && cfg.molibraConfirmations === 12 && cfg.ethConfirmations === 3);
  check('the page reads fastbridge.json and never uses innerHTML', page.includes('/molibra/fastbridge.json') && !/innerHTML/.test(page));
  check('the page adds bMOLI to the wallet when it arrives', page.includes('wallet_watchAsset'));
}

/* ------------------------------------------- inventory sweep (6 Oct review) */
{
  const max = 15_000n * WEI; const bp = 11_000n;
  check('sweep: at or below max + 10% nothing moves', FastBridge.excess(16_500n * WEI, max, bp) === 0n && FastBridge.excess(10_000n * WEI, max, bp) === 0n);
  check('sweep: above the trigger the excess over max goes, gas included, never below max',
    FastBridge.excess(20_000n * WEI, max, bp, 1n * WEI) === 4_999n * WEI);
  check('sweep: a gas cost larger than the excess sends nothing', FastBridge.excess(16_501n * WEI, max, bp, 2_000n * WEI) === 0n);
  check('sweep defaults: 15,000 MOLI and 15,000 bMOLI, 110% trigger, cold wallet = the operator',
    FAST_DEFAULTS.maxInventoryMoliWei === max && FAST_DEFAULTS.maxInventoryBmoliWei === max && FAST_DEFAULTS.sweepTriggerBp === bp
    && FAST_DEFAULTS.coldWallet === '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a');
  const W = world(); const logs = [];
  const fb = bridge(W, {}, { dryRun: true, maxInventoryMoliWei: 1n * WEI, maxInventoryBmoliWei: 1n * WEI }, (lvl, ev, d) => logs.push({ ev, ...d }));
  let threw = null;
  try { await fb.sweep({ live: false, ethSent: false, molibraSent: false }); } catch (e) { threw = e.message; }
  check('sweep (dry run) on a funded inventory: logged, nothing sent', !threw && logs.some((l) => l.ev === 'fast-sweep-dry-run'), threw ?? logs.map((l) => l.ev).join(','));
  const W2 = world(); const sent = [];
  const fb2 = bridge(W2, {}, { maxInventoryMoliWei: 1n * WEI, maxInventoryBmoliWei: 1n * WEI });
  try { await fb2.sweep({ live: true, ethSent: true, molibraSent: true }); } catch (e) { sent.push(e.message); }
  check('⛔ no sweep on a chain where this tick already sent a payout (no nonce races)', sent.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
