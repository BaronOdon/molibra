/**
 * MoliSaleCurve on Molibra's own EVM, against the REAL MolibraPool the
 * factory on /molibra/memes deploys.
 *
 *   1. curve maths: monotonic price, exact sums, rounding in the curve's favour
 *   2. buying: minOut / maxPrice, refunds, sell-out at exactly 5x
 *   3. the deposit: every MOLI paid lands in the pool, at the pool's ratio,
 *      with exact shares; the LP shares stay in the curve and nothing can move them
 *   4. manipulation: pool skewed out of band refuses; pump-buy-dump loses;
 *      front-running a curve buy loses; re-entry through the refund is refused
 *   5. no owner, no withdraw, no plain sends
 *   6. the three real coins at their real parities: opening and sell-out price
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { State } from '../src/state.js';
import { runEvm, simulate } from '../src/evm.js';
import { keccak256, toHex, fromHex } from '../src/crypto.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const CURVE = JSON.parse(read('contracts/artifacts/MoliSaleCurve.json'));
const MEME = JSON.parse(read('contracts/artifacts/MemeToken.json'));
const ATTACK = JSON.parse(read('contracts/artifacts/CurveReenter.test.json'));
const SANDWICH = JSON.parse(read('contracts/artifacts/CurveSandwich.test.json'));
const CURVE_V1 = JSON.parse(read('contracts/artifacts/MoliSaleCurve.v1-vulnerable.test.json'));
const page = read('src/web/memes.html');
const REG = JSON.parse(read('src/web/markets.json'));
const FACTORY = page.match(/const FACTORY_BYTECODE = '([^']*)';/)[1];

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

const enc = new TextEncoder();
const sel = (s) => toHex(keccak256(enc.encode(s))).slice(0, 10);
const word = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const addr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const big = (b) => (b && b.length ? BigInt(toHex(b)) : 0n);
const UNIT = 10n ** 18n;
const MAXU = (1n << 256n) - 1n;
const f = (w, p = 4) => (Number(w) / 1e18).toLocaleString('en-US', { maximumFractionDigits: p });
const errName = (ret) => {
  const h = toHex(ret).slice(0, 10);
  for (const n of ['OutOfBand(uint256,uint256)', 'Slippage()', 'NotFunded()', 'SoldOut()', 'Reentrant()', 'TransferFailed()',
    'NoDirectSends()', 'PoolNotSeeded()', 'BadPool()', 'BadParams()', 'Expired()', 'Imbalanced()', 'Insufficient()']) {
    if (sel(n) === h) return n.split('(')[0];
  }
  return h;
};

const OP = '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a';
const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const EVE = '0x3333333333333333333333333333333333333333';
const GAS = 8_000_000n;

let state;
let clock = 1_790_000_000n;
async function tx(from, to, data, value = 0n) {
  const r = await runEvm(state, { from, to, data, value, gasLimit: GAS, timestamp: clock, blockNumber: 200_000n });
  if (!r.failed) state.bumpNonce(from);
  return r;
}
async function deploy(from, bytecode, args = '') {
  const r = await tx(from, null, bytecode + args);
  if (r.failed) throw new Error('deploy failed: ' + r.error + ' ' + errName(r.returnValue));
  return r.createdAddress;
}
const view = async (to, data) => big((await simulate(state, { from: ALICE, to, data, gasLimit: GAS, timestamp: clock })).returnValue);
const view2 = async (to, data) => {
  const h = toHex((await simulate(state, { from: ALICE, to, data, gasLimit: GAS, timestamp: clock })).returnValue).slice(2);
  return h.match(/.{64}/g).map((w) => BigInt('0x' + w));
};
const bal = (tok, who) => view(tok, sel('balanceOf(address)') + addr(who));
const reserves = (pool) => view2(pool, sel('reserves()'));
const encCtor = (name, sym, desc, supply, holder) => {
  const s = (x) => { const h = Buffer.from(x).toString('hex'); return word(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64 || 64, '0'); };
  const parts = [s(name), s(sym), s(desc)];
  let off = 5 * 32; const heads = [];
  for (const p of parts) { heads.push(word(off)); off += p.length / 2; }
  return heads.join('') + word(supply) + addr(holder) + parts.join('');
};

/** One coin, set up the way /molibra/memes does it: token, pool at parity, curve funded with 95%. */
async function setup({ supply, p0, seedMoli = 3000n * UNIT, fund = true, curveShare = 95n, bytecode = CURVE.bytecode, unlockAt = 1792972800n }) {
  state = new State();
  for (const a of [OP, ALICE, BOB, EVE]) state.credit(a, 10n ** 30n);
  const token = await deploy(OP, MEME.bytecode, encCtor('Test Meme', 'TST', 'meme', supply, OP));
  const factory = await deploy(OP, FACTORY);
  await tx(OP, factory, sel('create(address)') + addr(token));
  const pool = '0x' + toHex(await (await simulate(state, { from: OP, to: factory, data: sel('poolOf(address)') + addr(token), gasLimit: GAS })).returnValue).slice(-40);
  const seedTok = (seedMoli * UNIT) / p0;
  await tx(OP, token, sel('approve(address,uint256)') + addr(pool) + word(seedTok));
  const sq = (n) => { let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
  const r = await tx(OP, pool, sel('addLiquidity(uint256,uint256)') + word(seedTok) + word(sq(seedMoli * seedTok) - 1000n), seedMoli);
  if (r.failed) throw new Error('seed failed ' + errName(r.returnValue));
  const S = (supply * curveShare) / 100n;
  const curve = await deploy(OP, bytecode, addr(token) + addr(pool) + word(S) + word(p0) + addr(OP) + word(unlockAt));
  if (fund) await tx(OP, token, sel('transfer(address,uint256)') + addr(curve) + word(S));
  return { token, pool, curve, S, p0 };
}
const buy = (c, from, moli, minOut = 0n, maxPrice = MAXU, deadline = MAXU) =>
  tx(from, c.curve, sel('buy(uint256,uint256,uint256)') + word(minOut) + word(maxPrice) + word(deadline), moli);
const curveView = (c, s, ...args) => view(c.curve, sel(s) + args.map(word).join(''));
/** Buy tokens in the POOL with MOLI (the cheap side when the pool is below the curve). */
const poolBuy = (c, from, moli) => tx(from, c.pool, sel('swapMoliForToken(uint256)') + word(1n), moli);
async function poolSell(c, from, amount) {
  await tx(from, c.token, sel('approve(address,uint256)') + addr(c.pool) + word(amount));
  return tx(from, c.pool, sel('swapTokenForMoli(uint256,uint256)') + word(amount) + word(1n));
}
const sold = (c) => curveView(c, 'sold()');

/* =============================================================== 1. maths */
console.log('1. curve maths\n');
const BOLSO_P0 = 248_362_000_000_000_000_000n;       // ~248.362 MOLI per BOLSO, as an example
let c = await setup({ supply: 1_000_000_000n * UNIT, p0: BOLSO_P0 });
{
  const S = c.S, p0 = c.p0;
  check('opening price is exactly p0', await curveView(c, 'priceAt(uint256)', 0n) === p0);
  check('sell-out price is exactly 5 x p0', await curveView(c, 'priceAt(uint256)', S) === 5n * p0);
  let prev = 0n, mono = true;
  for (let i = 0n; i <= 20n; i++) { const p = await curveView(c, 'priceAt(uint256)', (S * i) / 20n); if (p < prev) mono = false; prev = p; }
  check('price never falls as x grows (21 points)', mono);
  const whole = await curveView(c, 'cost(uint256,uint256)', 0n, S);
  check('cost of the whole sale = 3 x p0 x S (area under a 1x..5x line), rounded up',
    whole === (3n * p0 * S + UNIT - 1n) / UNIT, `${f(whole, 0)} MOLI`);
  // Splitting a purchase can never make it cheaper: ceil(a)+ceil(b) >= ceil(a+b), and at most 1 wei more.
  let exact = true;
  for (const [x, a, b] of [[0n, 1n, 1n], [12345n, 10n ** 20n, 7n], [S / 3n, S / 7n, S / 11n], [S - 10n, 3n, 7n]]) {
    const ab = await curveView(c, 'cost(uint256,uint256)', x, a + b);
    const sum = await curveView(c, 'cost(uint256,uint256)', x, a) + await curveView(c, 'cost(uint256,uint256)', x + a, b);
    if (!(sum >= ab && sum <= ab + 1n)) exact = false;
  }
  check('two purchases cost the same as one, to the wei, never less (rounding favours the curve)', exact);
  check('one token unit is never free', await curveView(c, 'cost(uint256,uint256)', 0n, 1n) >= 1n);
}

/* =============================================================== 2. buying */
console.log('\n2. buying\n');
{
  c = await setup({ supply: 1_000_000_000n * UNIT, p0: BOLSO_P0, fund: false });
  let r = await buy(c, ALICE, 100n * UNIT);
  check('⛔ nothing sells before the curve is funded', r.failed && errName(r.returnValue) === 'NotFunded');
  await tx(OP, c.token, sel('transfer(address,uint256)') + addr(c.curve) + word(c.S));

  const [rm0, rt0] = await reserves(c.pool);
  const q = await view2(c.curve, sel('quote(uint256)') + word(100n * UNIT));
  r = await buy(c, ALICE, 100n * UNIT, q[0] + 1n);
  check('⛔ minOut above what the MOLI buys is refused', r.failed && errName(r.returnValue) === 'Slippage');
  r = await buy(c, ALICE, 100n * UNIT, 0n, c.p0);
  check('⛔ maxPrice at the current price is refused (the buy moves it)', r.failed && errName(r.returnValue) === 'Slippage');
  r = await buy(c, ALICE, 100n * UNIT, 0n, MAXU, clock - 1n);
  check('⛔ an expired deadline is refused', r.failed && errName(r.returnValue) === 'Expired');

  const before = state.balanceOf(ALICE);
  r = await buy(c, ALICE, 100n * UNIT, q[0]);
  const got = await bal(c.token, ALICE);
  check('a 100 MOLI buy delivers exactly the quote', !r.failed && got === q[0], `${f(got, 6)} tokens, gas ${r.gasUsed}`);
  check('  and pays exactly cost(0, out), rounded up', q[1] === await curveView(c, 'cost(uint256,uint256)', 0n, q[0]) && state.balanceOf(ALICE) === before - q[1]);

  /* ---- 3. the deposit */
  const [rm1, rt1] = await reserves(c.pool);
  const curveMoli = state.balanceOf(c.curve);
  check('⭐ every MOLI paid went into the pool (dust left in the curve < 1 gwei)',
    rm1 - rm0 + curveMoli === q[1] && curveMoli < 10n ** 9n, `pool +${f(rm1 - rm0, 6)} MOLI, curve keeps ${curveMoli} wei`);
  check('  at the pool\'s ratio: the pool price did not move',
    (rm1 * 10n ** 18n) / rt1 === (rm0 * 10n ** 18n) / rt0 || ((rm1 * 10n ** 18n) / rt1 - (rm0 * 10n ** 18n) / rt0) ** 2n <= 4n,
    `${f((rm1 * UNIT) / rt1, 6)} MOLI per token`);
  const shares = await view(c.pool, sel('shares(address)') + addr(c.curve));
  const ts = await view(c.pool, sel('totalShares()'));
  check('  the LP shares belong to the curve', shares > 0n && shares < ts, `${shares} of ${ts}`);
  check('  sold = tokens to the buyer + tokens into the pool', await sold(c) === q[0] + (rt1 - rt0));
  check('  moliRaised records it', await curveView(c, 'moliRaised()') === q[1]);
  const fns = CURVE.abi.filter((x) => x.type === 'function').map((x) => x.name);
  check('⛔ the only way liquidity leaves is withdrawLiquidity() (time-locked, beneficiary only); nothing withdraws unsold tokens',
    fns.filter((n) => /remove|withdraw|sweep|rescue|migrate|exit/i.test(n)).join() === 'withdrawLiquidity');
}

{
  // Sell-out: a small sale, bought out in one purchase with too much MOLI.
  c = await setup({ supply: 10_000n * UNIT, p0: 2n * UNIT, seedMoli: 30n * UNIT });
  const whole = await curveView(c, 'cost(uint256,uint256)', 0n, c.S);
  const before = state.balanceOf(BOB);
  const r = await buy(c, BOB, whole * 3n);
  const got = await bal(c.token, BOB);
  const left = c.S - await sold(c);
  check('sell-out: one large buy takes all but at most 1 base unit (1e-18), the rest went into the pool', !r.failed && left <= 1n,
    `buyer got ${f(got, 2)} of ${f(c.S, 0)}, ${left} unit left, gas ${r.gasUsed}`);
  check('  and the unused MOLI is refunded', before - state.balanceOf(BOB) === await curveView(c, 'moliRaised()'), `paid ${f(before - state.balanceOf(BOB), 2)} MOLI`);
  const pEnd = await curveView(c, 'currentPrice()');
  check('  the price ends within one unit-step of exactly 5 x p0', pEnd <= 5n * c.p0 && 5n * c.p0 - pEnd <= (4n * c.p0) / c.S + 1n, `${pEnd} vs ${5n * c.p0}`);
  const again = await buy(c, ALICE, UNIT);
  check('  and then nothing more is sold at the old pool price', again.failed);
  check('  the curve holds at most that 1 unit, and no MOLI beyond dust', await bal(c.token, c.curve) <= 1n && state.balanceOf(c.curve) < 10n ** 9n);
}

/* ======================================================= 4. manipulation */
console.log('\n4. manipulation\n');
{
  c = await setup({ supply: 1_000_000_000n * UNIT, p0: BOLSO_P0 });
  // The pool 2% below the curve: the curve refuses (buy in the pool, it is cheaper).
  await tx(OP, c.token, sel('transfer(address,uint256)') + addr(EVE) + word(10n ** 24n));
  const [, rt] = await reserves(c.pool);
  const m0 = state.balanceOf(EVE); await poolSell(c, EVE, rt / 99n); const proceeds = state.balanceOf(EVE) - m0;
  let r = await buy(c, ALICE, 10n * UNIT);
  check('⛔ pool 2% under the curve: the curve refuses, nothing deposits at a skewed price',
    r.failed && errName(r.returnValue) === 'OutOfBand', `pool ${f(await curveView(c, 'poolPrice()'), 3)} vs curve ${f(c.p0, 3)}`);
  // Back into band from below by buying in the pool, then the curve sells again.
  await poolBuy(c, EVE, proceeds);
  check('  back within 1%: it sells again', await curveView(c, 'inBand()') === 1n && !(await buy(c, ALICE, 10n * UNIT)).failed);
  // Pool far above the curve.
  await poolBuy(c, EVE, 500n * UNIT);
  r = await buy(c, ALICE, 10n * UNIT);
  check('⛔ pool far above the curve: refused too (a deposit there would be a gift to whoever pumped it)',
    r.failed && errName(r.returnValue) === 'OutOfBand');
}
{
  // Pump - buy - dump, against a pool whose market price is HALF the curve's.
  for (const [label, size] of [['small', 10n * UNIT], ['large', 3000n * UNIT]]) {
    c = await setup({ supply: 1_000_000_000n * UNIT, p0: BOLSO_P0 });
    await tx(OP, c.token, sel('transfer(address,uint256)') + addr(EVE) + word(10n ** 24n));
    // An honest market drifts to half the curve price.
    const [rm, rt] = await reserves(c.pool);
    await poolSell(c, OP, (rt * 414n) / 1000n);
    const eveMoli0 = state.balanceOf(EVE), eveTok0 = await bal(c.token, EVE);
    // Pump to the curve price, buy from the curve so it deposits, dump everything.
    let spent = 0n;
    while (!(await curveView(c, 'inBand()'))) { await poolBuy(c, EVE, 20n * UNIT); spent += 20n * UNIT; if (spent > 10n ** 22n) break; }
    const b = await buy(c, EVE, size);
    const tok = (await bal(c.token, EVE)) - eveTok0;
    await poolSell(c, EVE, tok);
    const pnl = state.balanceOf(EVE) - eveMoli0;
    check(`pump-buy-dump (${label} curve buy of ${f(size, 0)} MOLI) LOSES MOLI`, !b.failed && pnl < 0n, `P&L ${f(pnl, 2)} MOLI`);
  }
}
{
  // Front-running a large curve buy, then selling the tokens into the pool.
  c = await setup({ supply: 1_000_000_000n * UNIT, p0: BOLSO_P0 });
  const eve0 = state.balanceOf(EVE);
  await buy(c, EVE, 500n * UNIT);
  const victim = await buy(c, ALICE, 1000n * UNIT, 0n, MAXU);
  await poolSell(c, EVE, await bal(c.token, EVE));
  check('front-running a curve buy and dumping into the pool loses (the curve never buys back)',
    !victim.failed && state.balanceOf(EVE) < eve0, `P&L ${f(state.balanceOf(EVE) - eve0, 2)} MOLI`);
  const v2 = await buy(c, BOB, 10n * UNIT, 0n, await curveView(c, 'currentPrice()'));
  check('  and a victim who sets maxPrice is never filled above it', v2.failed && ['Slippage', 'OutOfBand'].includes(errName(v2.returnValue)));
}
{
  // Re-entry through the refund.
  c = await setup({ supply: 10_000n * UNIT, p0: 2n * UNIT, seedMoli: 30n * UNIT });
  const atk = await deploy(EVE, ATTACK.bytecode, addr(c.curve));
  const whole = await curveView(c, 'cost(uint256,uint256)', 0n, c.S);
  const r = await tx(EVE, atk, sel('attack()'), whole * 2n);
  check('⛔ re-entering buy() from the refund is refused, and the whole purchase unwinds',
    r.failed && await sold(c) === 0n, errName(r.returnValue));
}

/* =========================== 4b. the audit finding, as a regression test */
console.log('\n4b. audit regression: moving the pool from inside the refund callback\n');
/**
 * The auditor's PoC (5 Oct 2026). A buyer CONTRACT buys from the curve and,
 * inside the refund it receives, pumps the pool with `A` MOLI; then it sells
 * everything back. In v1 the refund went out BEFORE the deposit, so the curve
 * deposited at the pumped ratio and the attacker profited. Its P&L is compared
 * with the same buyer doing an honest buy-and-sell (mode 0).
 */
async function sandwichRun(bytecode, mode, A, V) {
  const c = await setup({ supply: 1_000_000_000n * UNIT, p0: BOLSO_P0, bytecode });
  const atk = await deploy(EVE, SANDWICH.bytecode, addr(c.curve) + addr(c.pool) + addr(c.token));
  state.credit(atk, 10n ** 28n);
  const m0 = state.balanceOf(atk);
  const r = await tx(EVE, atk, sel('go(uint256,uint256,uint256,bool)') + word(V + 7n) + word(mode) + word(A) + word(1n));
  const [rm] = await reserves(c.pool);
  return { failed: r.failed, err: r.failed ? errName(r.returnValue) : null, pnl: state.balanceOf(atk) - m0, poolMoli: rm };
}
{
  const V = 10_000n * UNIT;
  const amounts = [V / 2n, V, 2n * V, 4n * V, 8n * V];
  for (const [label, code] of [['v1 (vulnerable)', CURVE_V1.bytecode], ['fixed', CURVE.bytecode]]) {
    const honest = await sandwichRun(code, 0n, 0n, V);
    let best = null;
    for (const A of amounts) {
      const r = await sandwichRun(code, 1n, A, V);
      if (!r.failed && (!best || r.pnl > best.pnl)) best = { ...r, A };
    }
    const gain = best ? best.pnl - honest.pnl : null;
    if (label.startsWith('v1')) {
      check('⛔ BEFORE the fix the PoC works: pumping in the refund callback beats an honest buy, and drains the pool below its 3,000 MOLI seed',
        best && gain > 0n && best.poolMoli < 3000n * UNIT,
        `gain ${f(gain ?? 0n, 2)} MOLI at A=${f(best?.A ?? 0n, 0)}, pool ${f(best?.poolMoli ?? 0n, 2)} MOLI`);
    } else {
      check('⭐ AFTER the fix the same attack gains nothing over an honest buy, at every pump size',
        !honest.failed && (best === null || gain <= 0n),
        best ? `best attack ${f(best.pnl, 2)} vs honest ${f(honest.pnl, 2)} MOLI (gain ${f(gain, 2)})` : 'every attack variant reverted');
      check('  and an honest contract buyer (mode 0, with a refund) still buys', !honest.failed);
    }
  }
}
{
  // Order inside buy(): the deposit happens before ANY outside code runs.
  const src = read('contracts/MoliSaleCurve.sol');
  const body = src.slice(src.indexOf('function buy('), src.indexOf('/* ----------------------------------------------------------- deposit */'));
  const iDeepen = body.indexOf('_deepen(paid, refund, rM0, rT0);');
  const iTransfer = body.indexOf('token.transfer(msg.sender, out)');
  const iRefund = body.indexOf('msg.sender.call{value: refund}');
  check('⛔ buy(): deposit, then the buyer\'s tokens, then the refund LAST (checks-effects-interactions)',
    iDeepen > 0 && iDeepen < iTransfer && iTransfer < iRefund);
  check('⛔ _deepen re-checks the pool reserves against what the band check saw, to the wei',
    /if \(rM != rM0 \|\| rT != rT0\) revert OutOfBand/.test(src));
  check('⛔ the pending refund is excluded from what gets deposited',
    src.includes('uint256 bal = address(this).balance - reserved;'));
}
{
  // Malicious buyers: re-entering buy() from the refund, and a refund that reverts.
  const c = await setup({ supply: 10_000n * UNIT, p0: 2n * UNIT, seedMoli: 30n * UNIT });
  const atk = await deploy(EVE, ATTACK.bytecode, addr(c.curve));
  const over = (await curveView(c, 'cost(uint256,uint256)', 0n, c.S)) * 2n;   // forces a large refund
  const r = await tx(EVE, atk, sel('attack()'), over);
  check('⛔ a buyer re-entering buy() from its refund is refused, the purchase unwinds, nothing deposited',
    r.failed && await sold(c) === 0n && state.balanceOf(c.curve) === 0n);
  const before = await reserves(c.pool);
  const sw = await deploy(EVE, SANDWICH.bytecode, addr(c.curve) + addr(c.pool) + addr(c.token));
  state.credit(sw, 10n ** 24n);
  const r2 = await tx(EVE, sw, sel('go(uint256,uint256,uint256,bool)') + word(over) + word(1n) + word(3n * UNIT) + word(0n));
  const after = await reserves(c.pool);
  const pp = (x) => (x[0] * UNIT) / x[1];
  check('  a buyer pumping the pool inside its refund: the deposit already went in at the approved price',
    !r2.failed && pp(after) > pp(before), `pool price after the pump ${f(pp(after), 4)} (the curve's deposit was at ${f(pp(before), 4)})`);
}

/* ============================ 4c. the time lock on the curve's liquidity */
console.log('\n4c. time lock: liquidity locked until 2026-10-26T00:00:00Z, then the beneficiary may withdraw\n');
const BENREENTER = JSON.parse(read('contracts/artifacts/CurveBeneficiaryReenter.test.json'));
const UNLOCK = 1792972800n;
const at = async (ts, from, to, data, value = 0n) => {
  const r = await runEvm(state, { from, to, data, value, gasLimit: GAS, timestamp: ts, blockNumber: 210_000n });
  if (!r.failed) state.bumpNonce(from);
  return r;
};
const withdraw = (c, from, ts, shares, minM = 0n, minT = 0n) =>
  at(ts, from, c.curve, sel('withdrawLiquidity(uint256,uint256,uint256)') + word(shares) + word(minM) + word(minT));
{
  check('UNLOCK is 2026-10-26T00:00:00Z exactly', new Date(Number(UNLOCK) * 1000).toISOString() === '2026-10-26T00:00:00.000Z');
  check('the page deploys the curve with the operator as beneficiary and that unlock time',
    page.includes('const CURVE_UNLOCK_AT = 1792972800n;') && page.includes('+ addr32(OPERATOR) + word(CURVE_UNLOCK_AT)'));
  c = await setup({ supply: 1_000_000_000n * UNIT, p0: BOLSO_P0 });
  check('beneficiary() and unlockAt() read back', '0x' + (await curveView(c, 'beneficiary()')).toString(16).padStart(40, '0') === OP
    && await curveView(c, 'unlockAt()') === UNLOCK);
  await buy(c, ALICE, 1000n * UNIT);
  const shares = await curveView(c, 'liquidityShares()');
  check('a buy gives the curve LP shares', shares > 0n, String(shares));
  let r = await withdraw(c, OP, UNLOCK - 1n, shares);
  check('⛔ before unlock the beneficiary is refused (Locked), one second early included', r.failed && toHex(r.returnValue).startsWith(sel('Locked(uint64)')));
  r = await withdraw(c, ALICE, UNLOCK + 10n, shares);
  check('⛔ after unlock a non-beneficiary is refused (NotBeneficiary)', r.failed && toHex(r.returnValue).startsWith(sel('NotBeneficiary()')));
  const [rm, rt] = await reserves(c.pool);
  const ts = await view(c.pool, sel('totalShares()'));
  const half = shares / 2n;
  const expM = (half * rm) / ts, expT = (half * rt) / ts;
  r = await withdraw(c, OP, UNLOCK, half, expM + 1n, 0n);
  check('⛔ slippage: minMoli above what the shares are worth is refused by the pool', r.failed);
  const m0 = state.balanceOf(OP), t0 = await bal(c.token, OP), sold0 = await sold(c), inv0 = await bal(c.token, c.curve);
  r = await withdraw(c, OP, UNLOCK, half, expM, expT);
  check('at unlock: a PARTIAL withdrawal pays the beneficiary exactly the MOLI and tokens of those shares',
    !r.failed && state.balanceOf(OP) - m0 === expM && (await bal(c.token, OP)) - t0 === expT, `${f(expM, 4)} MOLI + ${f(expT, 6)} tokens`);
  check('  the unsold sale tokens are untouched (not withdrawable), and nothing stays in the curve',
    await bal(c.token, c.curve) === inv0 && await sold(c) === sold0 && state.balanceOf(c.curve) < 10n ** 9n);
  check('  the curve keeps the other half of its shares', await curveView(c, 'liquidityShares()') === shares - half);
  // Buys still work after a partial withdrawal (the pool price did not move).
  r = await at(UNLOCK + 60n, BOB, c.curve, sel('buy(uint256,uint256,uint256)') + word(0n) + word(MAXU) + word(MAXU), 100n * UNIT);
  check('buys still work after a partial withdrawal, and their MOLI deepens the pool again', !r.failed && await curveView(c, 'liquidityShares()') > shares - half);
  const all = await curveView(c, 'liquidityShares()');
  r = await withdraw(c, OP, UNLOCK + 120n, all);
  check('a FULL withdrawal takes every remaining share', !r.failed && await curveView(c, 'liquidityShares()') === 0n);
  r = await at(UNLOCK + 180n, OP, c.curve, '0x', UNIT);
  check('⛔ a plain MOLI send is still refused after unlock (only the pool, mid-withdrawal, may pay the curve)', r.failed);
}
{
  // Re-entry from the beneficiary's own payout.
  state = new State();
  for (const a of [OP, ALICE, BOB, EVE]) state.credit(a, 10n ** 30n);
  const ben = await deploy(EVE, BENREENTER.bytecode);
  state.credit(ben, 10n ** 24n);
  const c2 = await (async () => {
    const saved = state;
    const x = await setup({ supply: 1_000_000_000n * UNIT, p0: BOLSO_P0, bytecode: CURVE.bytecode });
    return x;
  })();
  // setup() made a fresh state; redeploy the beneficiary into it and a curve naming it.
  const ben2 = await deploy(EVE, BENREENTER.bytecode);
  state.credit(ben2, 10n ** 24n);
  const S = await curveView(c2, 'supplyForSale()');
  const curve2 = await deploy(OP, CURVE.bytecode, addr(c2.token) + addr(c2.pool) + word(1_000_000n * UNIT) + word(BOLSO_P0) + addr(ben2) + word(UNLOCK));
  await tx(OP, c2.token, sel('transfer(address,uint256)') + addr(curve2) + word(1_000_000n * UNIT));
  await at(UNLOCK - 100n, EVE, ben2, sel('setCurve(address)') + addr(curve2));
  const c3 = { ...c2, curve: curve2 };
  const b = await at(UNLOCK - 50n, ALICE, curve2, sel('buy(uint256,uint256,uint256)') + word(0n) + word(MAXU) + word(MAXU), 500n * UNIT);
  const sh = await view(curve2, sel('liquidityShares()'));
  await at(UNLOCK, EVE, ben2, sel('setMode(uint256)') + word(1n));
  let r = await at(UNLOCK + 1n, EVE, ben2, sel('pull(uint256)') + word(sh / 2n));
  check('⛔ a beneficiary re-entering withdrawLiquidity() from its payout is refused; the withdrawal unwinds',
    !b.failed && r.failed && await view(curve2, sel('liquidityShares()')) === sh);
  await at(UNLOCK + 2n, EVE, ben2, sel('setMode(uint256)') + word(2n));
  r = await at(UNLOCK + 3n, EVE, ben2, sel('pull(uint256)') + word(sh / 2n));
  check('⛔ a beneficiary re-entering buy() from its payout is refused too', r.failed && await view(curve2, sel('liquidityShares()')) === sh);
  await at(UNLOCK + 4n, EVE, ben2, sel('setMode(uint256)') + word(0n));
  r = await at(UNLOCK + 5n, EVE, ben2, sel('pull(uint256)') + word(sh / 2n));
  check('  and the same beneficiary, behaving, withdraws normally', !r.failed && await view(curve2, sel('liquidityShares()')) === sh - sh / 2n);
  void ben; void S; void c3;
}

/* ========================================================== 5. no owner */
console.log('\n5. nobody controls it\n');
{
  c = await setup({ supply: 1_000_000n * UNIT, p0: UNIT });
  const fns = CURVE.abi.filter((x) => x.type === 'function');
  const writes = fns.filter((x) => !['view', 'pure'].includes(x.stateMutability)).map((x) => x.name);
  check('the only state-changing functions are buy() and the time-locked withdrawLiquidity()',
    writes.slice().sort().join() === 'buy,withdrawLiquidity', writes.join(','));
  for (const s of ['owner()', 'transferOwnership(address)', 'pause()', 'withdraw()', 'setPrice(uint256)']) {
    const r = await runEvm(state.clone(), { from: OP, to: c.curve, data: sel(s) + word(1n), gasLimit: GAS });
    check(`⛔ ${s} does not exist`, r.failed);
  }
  const r = await tx(OP, c.curve, '0x', UNIT);
  check('⛔ a plain MOLI send is refused', r.failed && errName(r.returnValue) === 'NoDirectSends');
  const bad = await runEvm(state.clone(), { from: OP, to: null, data: CURVE.bytecode + addr(c.token) + addr(ALICE.replace('1111', '1112')) + word(1n) + word(1n), gasLimit: GAS });
  check('⛔ a curve cannot be built against a pool for another token', bad.failed);
}

/* ===================================================== 6. the real coins */
console.log('\n6. the three coins at their parities\n');
{
  // The page's pricing (5 Oct 2026): parity is the RATIO between the coins, at
  // 1 MOLI = 1,000,000 of a TRUMP-referenced coin; the seed is the whole 1%.
  const e18 = (s) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 12n;
  const anchorUsd = e18(REG.counterparts['official-trump'].usd);
  for (const key of ['caramelo', 'bolso', 'fazol']) {
    const m = REG.markets.find((x) => x.key === key);
    const cp = REG.counterparts[m.meme.counterpart];
    const p0 = (e18(cp.usd) * UNIT) / (anchorUsd * 1_000_000n);
    const supply = BigInt(m.meme.supply) * UNIT;
    const curveAmt = BigInt(m.meme.allocation.curve) * UNIT;
    const seedMoli = ((supply / 100n) * p0) / UNIT;
    check(`${m.symbol}: opens far below 1 MOLI (1 MOLI = ${(UNIT / p0).toLocaleString('en-US')} ${m.symbol})`, p0 > 0n && p0 < 10n ** 15n);
    c = await setup({ supply, p0, seedMoli, curveShare: (curveAmt * 100n) / supply });
    const r = await buy(c, ALICE, 100n * UNIT); if (r.failed) console.log("    revert:", m.symbol, errName(r.returnValue), r.error, toHex(r.returnValue).slice(0, 200));
    const got = await bal(c.token, ALICE);
    check(`${m.symbol}: curve of ${f(curveAmt, 0)} opens at ${f(p0, 12)} MOLI and sells out at ${f(5n * p0, 12)} MOLI`,
      !r.failed && await curveView(c, 'priceAt(uint256)', 0n) === p0 && await curveView(c, 'priceAt(uint256)', c.S) === 5n * p0,
      `100 MOLI buys ${f(got, 6)} ${m.symbol}, gas ${r.gasUsed}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
