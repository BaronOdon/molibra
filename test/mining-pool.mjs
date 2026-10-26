/**
 * The public mining pool, end to end against a real node.
 *
 * A node runs on the real genesis; the pool server takes templates from it,
 * miners grind shares through the HTTP API, found blocks land on the node's
 * chain paying the pool, mature, are split by PPLNS, and the pool pays the
 * miners with real transactions that the chain mines. Then the checks that
 * matter: what must NOT happen - a block template served to the internet, a
 * share credited twice, a share for someone else's job, credits that add up
 * to more than the block paid.
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { Node } from '../src/node.js';
import { PoolCore } from '../src/pool.js';
import { PoolServer, createPoolHttp } from '../src/poolserver.js';
import { keccak256, bigToBytes, bytesToBig, concatBytes, fromHex, privateToAddress, toChecksumAddress } from '../src/crypto.js';

const GENESIS_PATH = join(import.meta.dirname, '..', 'genesis.json');
const genesis = JSON.parse(readFileSync(GENESIS_PATH, 'utf8'));
const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const SOLO = '0x3333333333333333333333333333333333333333';
const NODE_PORT = 18631;
const POOL_PORT = 18632;
const NODE = `http://127.0.0.1:${NODE_PORT}`;
const POOL = `http://127.0.0.1:${POOL_PORT}/pool`;

let passed = 0;
let failed = 0;
const check = (name, ok, note = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  ${note}` : ''}`);
  ok ? passed++ : failed++;
};
const post = async (url, body, headers = {}) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
/** Grind one share for a job, like the miner does. */
const grind = (job, start = 0n) => {
  const digest = fromHex(job.digest);
  const target = BigInt(job.shareTarget);
  for (let n = start; ; n++) {
    if (bytesToBig(keccak256(concatBytes(digest, bigToBytes(n)))) < target) return n;
  }
};

const dir = mkdtempSync(join(tmpdir(), 'molibra-mining-pool-'));
let node = null;
let http = null;
let pool = null;
try {
  console.log('the block template is for the local pool only\n');
  node = new Node({ genesisPath: GENESIS_PATH, dataDir: join(dir, 'node') });
  await node.ready;
  await node.start({ host: '127.0.0.1', port: NODE_PORT });
  for (let i = 0; i < 5; i++) await node.chain.mine(SOLO);

  const KEY = randomBytes(32).toString('hex');
  const POOL_ADDR = toChecksumAddress(privateToAddress(KEY));

  let r = await fetch(`${NODE}/molibra/block-template?coinbase=${POOL_ADDR}`);
  const tpl = await r.json();
  check('loopback gets a template', r.status === 200 && tpl.header.miner.toLowerCase() === POOL_ADDR.toLowerCase());
  check('it builds on the head', BigInt(tpl.header.number) === node.chain.head.header.number + 1n);
  r = await fetch(`${NODE}/molibra/block-template?coinbase=${POOL_ADDR}`, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  check('⛔ a request that came through the proxy is refused', r.status === 403);
  r = await fetch(`${NODE}/molibra/block-template`);
  check('a template without a coinbase is refused', r.status === 400);

  console.log('\nshares, vardiff and blocks through the HTTP API');
  pool = new PoolServer({
    nodeUrl: NODE, address: POOL_ADDR, privateKey: KEY, dataDir: join(dir, 'pool'), genesis,
    chainId: BigInt(genesis.chainId),
    options: { maturity: 2, minPayout: 10n ** 16n, core: { startShareDifficulty: 512n, minShareDifficulty: 256n } },
    log: { log() {}, error() {} },
  });
  await pool.refreshWork(true);
  http = createPoolHttp(pool);
  await new Promise((ok) => http.listen(POOL_PORT, '127.0.0.1', ok));

  const page = await fetch(POOL);
  check('the pool page is served', page.status === 200 && (await page.text()).includes('<html'));

  let job = (await post(`${POOL}/api/job`, { address: ALICE, worker: 'rig1' })).body;
  check('a job carries a digest and a share target', /^0x[0-9a-f]{64}$/.test(job.digest) && BigInt(job.shareTarget) > 0n);
  const job2 = (await post(`${POOL}/api/job`, { address: BOB })).body;
  check('two miners never grind the same digest', job.digest !== job2.digest);

  let nonce = grind(job);
  let res = (await post(`${POOL}/api/share`, { jobId: job.jobId, nonce: nonce.toString(), address: ALICE })).body;
  check('a valid share is accepted', res.ok === true, JSON.stringify(res).slice(0, 80));
  res = (await post(`${POOL}/api/share`, { jobId: job.jobId, nonce: nonce.toString(), address: ALICE })).body;
  check('⛔ the same share twice is refused', res.ok === false && /duplicate/.test(res.reason));
  res = (await post(`${POOL}/api/share`, { jobId: job.jobId, nonce: grind(job, nonce + 1n).toString(), address: BOB })).body;
  check('⛔ a share for someone else\'s job is refused', res.ok === false && /another address/.test(res.reason));
  res = (await post(`${POOL}/api/share`, { jobId: job.jobId, nonce: '18446744073709551616', address: ALICE })).body;
  check('⛔ a nonce past 64 bits is refused', res.ok === false && /range/.test(res.reason));

  // Mine until the pool has found 4 blocks, both miners working.
  const startHeight = node.chain.height;
  let found = 0;
  let guard = 0;
  while (found < 4 && guard++ < 4000) {
    for (const who of [ALICE, BOB]) {
      const j = (await post(`${POOL}/api/job`, { address: who })).body;
      const n = grind(j, BigInt(Math.floor(Math.random() * 1e9)));
      const s = (await post(`${POOL}/api/share`, { jobId: j.jobId, nonce: n.toString(), address: who })).body;
      if (s.block) {
        found++;
        await pool.refreshWork(true);
      }
    }
  }
  check('the pool finds blocks', found >= 4, `${found} blocks`);
  check('they are on the node\'s chain, paying the pool',
    node.chain.height >= startHeight + BigInt(found)
      && node.chain.head.header.miner.toLowerCase() === POOL_ADDR.toLowerCase());
  const head = node.chain.head;
  check('a pool block carries the MOLIPOOL tag in extraData', head.header.extraData.startsWith('0x4d4f4c49504f4f4c'));

  const stats = await (await fetch(`${POOL}/api/stats`)).json();
  check('stats report fee 1% and PPLNS', stats.feePercent === 1 && stats.scheme === 'PPLNS');
  check('stats count the blocks', stats.blocksFound === found);
  check('the share difficulty never exceeds the block difficulty',
    [...pool.core.workers.values()].every((w) => w.difficulty <= pool.core.blockDifficulty));

  console.log('\nmaturity and payouts');
  for (const b of pool.state.blocks) {
    const sum = Object.values(b.credits).reduce((s, v) => s + BigInt(v), 0n) + BigInt(b.fee);
    if (sum !== BigInt(b.reward)) check(`block ${b.height} credits + fee = reward`, false, `${sum} vs ${b.reward}`);
  }
  check('⛔ no block credits more than it paid (credits + fee = reward)', true);
  const feeShare = Number(BigInt(pool.state.blocks[0].fee) * 10000n / BigInt(pool.state.blocks[0].reward)) / 100;
  check('the fee is 1% of the block reward', feeShare >= 1 && feeShare < 1.01, `${feeShare}%`);

  await pool.confirmBlocks();
  check('the newest block, not yet `maturity` deep, is still pending', pool.state.blocks[0].status === 'pending');
  const creditedEarly = pool.state.blocks.filter((b) => b.status === 'confirmed')
    .every((b) => node.chain.height - BigInt(b.height) >= 2n);
  check('only blocks `maturity` deep were credited', creditedEarly);
  for (let i = 0; i < 3; i++) await node.chain.mine(SOLO);
  await pool.confirmBlocks();
  const confirmed = pool.state.blocks.filter((b) => b.status === 'confirmed').length;
  check('blocks mature after `maturity` confirmations', confirmed === found, `${confirmed}/${found}`);
  const aliceBal = BigInt(pool.state.balances[ALICE] ?? 0);
  const bobBal = BigInt(pool.state.balances[BOB] ?? 0);
  check('both miners are credited', aliceBal > 0n && bobBal > 0n);

  const sent = await pool.payout();
  check('payouts are signed and sent', sent.length === 2, `${sent.length} sent`);
  check('balances are debited on send', BigInt(pool.state.balances[ALICE]) === 0n && BigInt(pool.state.balances[BOB]) === 0n);
  await node.chain.mine(SOLO);
  check('⭐ the chain pays Alice what the pool owed her', node.chain.head.state.balanceOf?.(ALICE.toLowerCase()) === aliceBal
    || BigInt(await (await post(NODE, { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [ALICE, 'latest'] })).body.result) === aliceBal);
  await pool.checkPayments();
  check('the payouts are marked confirmed', pool.state.payments.filter((p) => p.status === 'confirmed').length === 2);
  const again = await pool.payout();
  check('⛔ nothing is paid twice', again.length === 0);

  const me = await (await fetch(`${POOL}/api/miner/${ALICE}`)).json();
  check('the miner page shows what was paid', BigInt(me.paid) === aliceBal && me.payments.length === 1 && !('raw' in me.payments[0]));

  console.log('\nrestarts and the PPLNS split');
  pool.save();
  const reloaded = new PoolServer({ nodeUrl: NODE, address: POOL_ADDR, privateKey: KEY, dataDir: join(dir, 'pool'), genesis, log: { log() {}, error() {} } });
  check('a restart keeps balances, payments and the share log',
    reloaded.state.payments.length === pool.state.payments.length && reloaded.core.shares.length === pool.core.shares.length);

  const core = new PoolCore({ poolAddress: POOL_ADDR });
  core.shares = [
    { address: ALICE, difficulty: 300n, at: 0 },
    { address: BOB, difficulty: 100n, at: 1 },
    { address: ALICE, difficulty: 100n, at: 2 },
  ];
  const split = core.splitReward(1000n, 150n); // window = 2 x 150 = 300: Alice 100 + Bob 100 + the newest 100 of Alice's 300
  check('PPLNS counts only the last N work', split.credits.get(ALICE) === 660n && split.credits.get(BOB) === 330n,
    `alice ${split.credits.get(ALICE)} bob ${split.credits.get(BOB)}`);
  check('rounding dust goes to the fee, never over the reward',
    split.fee + split.credits.get(ALICE) + split.credits.get(BOB) === 1000n);
  check('with no shares, nobody is credited', new PoolCore({ poolAddress: POOL_ADDR }).splitReward(1000n, 10n).credits.size === 0);

  const capped = new PoolCore({ poolAddress: POOL_ADDR, maxJobs: 3, maxWorkers: 2, maxWorkersPerAddress: 1 });
  capped.setTemplate(tpl);
  for (let i = 0; i < 5; i++) capped.newJob(ALICE, 'w');
  check('⛔ open jobs are capped (oldest evicted)', capped.jobs.size === 3);
  let perAddr = false;
  try { capped.newJob(ALICE, 'second'); } catch { perAddr = true; }
  check('⛔ workers per address are capped', perAddr);
  capped.newJob(BOB, 'w');
  let total = false;
  try { capped.newJob(SOLO, 'w'); } catch { total = true; }
  check('⛔ total workers are capped', total);

  let wrongKey = false;
  try {
    new PoolServer({ nodeUrl: NODE, address: ALICE, privateKey: KEY, dataDir: join(dir, 'x'), genesis });
  } catch { wrongKey = true; }
  check('⛔ a key that does not derive the pool address is refused', wrongKey);
} catch (error) {
  console.error(error);
  failed++;
} finally {
  pool?.stop();
  http?.close();
  await node?.stop?.();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
