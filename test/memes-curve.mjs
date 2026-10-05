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
async function setup({ supply, p0, seedMoli = 3000n * UNIT, fund = true, curveShare = 95n }) {
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
  const curve = await deploy(OP, CURVE.bytecode, addr(token) + addr(pool) + word(S) + word(p0));
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
  check('⛔ the LP is locked forever: the curve has no function that calls removeLiquidity',
    !fns.some((n) => /remove|withdraw|sweep|rescue|migrate|exit/i.test(n)) && !CURVE.deployedBytecode.includes(sel('removeLiquidity(uint256,uint256,uint256)').slice(2)));
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

/* ========================================================== 5. no owner */
console.log('\n5. nobody controls it\n');
{
  c = await setup({ supply: 1_000_000n * UNIT, p0: UNIT });
  const fns = CURVE.abi.filter((x) => x.type === 'function');
  const writes = fns.filter((x) => !['view', 'pure'].includes(x.stateMutability)).map((x) => x.name);
  check('the only state-changing function is buy()', writes.length === 1 && writes[0] === 'buy', writes.join(','));
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
  const snapMoliUsd = Number(REG.snapshot.moliUsd);
  for (const key of ['caramelo', 'bolso', 'fazol']) {
    const m = REG.markets.find((x) => x.key === key);
    const cp = REG.counterparts[m.meme.counterpart];
    const usd = BigInt(Math.round(Number(cp.usd) * 1e6)) * 10n ** 12n;
    const moliUsd = BigInt(Math.round(snapMoliUsd * 1e18));
    const p0 = (usd * UNIT) / moliUsd;
    const supply = BigInt(m.meme.supply) * UNIT;
    const curveAmt = BigInt(m.meme.allocation.curve) * UNIT;
    c = await setup({ supply, p0, curveShare: (curveAmt * 100n) / supply });
    const r = await buy(c, ALICE, 100n * UNIT); if (r.failed) console.log("    revert:", m.symbol, errName(r.returnValue), r.error, toHex(r.returnValue).slice(0, 200));
    const got = await bal(c.token, ALICE);
    check(`${m.symbol}: curve of ${f(curveAmt, 0)} opens at ${f(p0, 4)} MOLI (US$ ${cp.usd}) and sells out at ${f(5n * p0, 4)} MOLI`,
      !r.failed && await curveView(c, 'priceAt(uint256)', 0n) === p0 && await curveView(c, 'priceAt(uint256)', c.S) === 5n * p0,
      `100 MOLI buys ${f(got, 6)} ${m.symbol}, gas ${r.gasUsed}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
