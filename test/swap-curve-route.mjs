/**
 * /molibra/swap buying a memecoin: pool or sale curve, whichever gives more.
 *
 * The page's own code is run, verbatim: the CURVE region (pickSource,
 * curveBuyData) and the async curveQuote(), with its `call` wired to Molibra's
 * EVM holding a real MemeToken, the factory's MolibraPool and a funded
 * MoliSaleCurve. Scenarios: curve better, pool better, curve refusing (pool
 * out of band), curve sold out, curve not yet funded - and the calldata the
 * page signs, executed.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { State } from '../src/state.js';
import { runEvm, simulate } from '../src/evm.js';
import { keccak256, toHex } from '../src/crypto.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const page = read('src/web/swap.html');
const memes = read('src/web/memes.html');
const CURVE = JSON.parse(read('contracts/artifacts/MoliSaleCurve.json'));
const MEME = JSON.parse(read('contracts/artifacts/MemeToken.json'));
const FACTORY = memes.match(/const FACTORY_BYTECODE = '([^']*)';/)[1];

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};
const sel = (s) => toHex(keccak256(new TextEncoder().encode(s))).slice(0, 10);
const word = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const addr32 = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const toBig = (h) => (h && h !== '0x' ? BigInt(h) : 0n);
const UNIT = 10n ** 18n;
const f = (w, p = 6) => (Number(w) / 1e18).toLocaleString('en-US', { maximumFractionDigits: p });

console.log('swap.html: buying a memecoin from the pool or the sale curve\n');

/* ------------------------------------------------------- the page's code */
const selBlock = page.match(/const SEL = \{[\s\S]*?\n\};/)[0];
const SEL = new Function(selBlock + '\nreturn SEL;')();
for (const [k, s] of [['curveQuote', 'quote(uint256)'], ['curveInBand', 'inBand()'], ['curveRemaining', 'remaining()'],
  ['curveBuy', 'buy(uint256,uint256,uint256)'], ['balanceOf', 'balanceOf(address)'], ['swapMoliIn', 'swapMoliForToken(uint256)']]) {
  check(`SEL.${k} is keccak of ${s}`, SEL[k] === sel(s), SEL[k]);
}
check('every curve selector exists in the built MoliSaleCurve ABI',
  ['quote', 'inBand', 'remaining', 'buy'].every((n) => CURVE.abi.some((x) => x.type === 'function' && x.name === n)));

const region = page.match(/\/\* CURVE-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* CURVE-END \*\//);
check('the page has a CURVE-BEGIN/CURVE-END region', !!region);
const { pickSource, curveBuyData } = new Function('SEL', 'word', region[1] + '\nreturn { pickSource, curveBuyData };')(SEL, word);
const cqSrc = page.match(/async function curveQuote\(m, amount\) \{[\s\S]*?\n\}/)[0];
let evmCall = null;
const curveQuote = new Function('SEL', 'toBig', 'addr32', 'word', 'call',
  cqSrc + '\nreturn curveQuote;')(SEL, toBig, addr32, word, (to, data) => evmCall(to, data));

/* pure decision */
check('pickSource: curve gives more -> curve', pickSource(100n, 101n) === 'curve');
check('pickSource: pool gives more -> pool', pickSource(101n, 100n) === 'pool');
check('pickSource: a tie goes to the pool', pickSource(100n, 100n) === 'pool');
check('pickSource: curve refusing (null) -> pool', pickSource(100n, null) === 'pool');
check('pickSource: no pool liquidity, curve open -> curve', pickSource(0n, 5n) === 'curve');
check('pickSource: neither -> null (the page shows "too large")', pickSource(0n, null) === null);
{
  const d = curveBuyData(12345n, 1800000000n);
  check('curveBuyData = buy(minOut, MAX, deadline), word by word',
    d === sel('buy(uint256,uint256,uint256)') + word(12345n) + 'f'.repeat(64) + word(1800000000n), `${(d.length - 10) / 64} words`);
}

/* ----------------------------------------------------- a live market */
const OP = '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a';
const BUYER = '0x1111111111111111111111111111111111111111';
const EVE = '0x3333333333333333333333333333333333333333';
const GAS = 8_000_000n;
let state;
const tx = async (from, to, data, value = 0n) => {
  const r = await runEvm(state, { from, to, data, value, gasLimit: GAS, timestamp: 1_790_000_000n });
  if (!r.failed) state.bumpNonce(from);
  return r;
};
const deploy = async (from, code) => { const r = await tx(from, null, code); if (r.failed) throw new Error(r.error); return r.createdAddress; };
evmCall = async (to, data) => {
  const r = await simulate(state, { from: BUYER, to, data, gasLimit: GAS, timestamp: 1_790_000_000n });
  if (r.failed) throw new Error('revert');
  return toHex(r.returnValue);
};
const encCtor = (name, sym, supply) => {
  const s = (x) => { const h = Buffer.from(x).toString('hex'); return word(h.length / 2) + h.padEnd(64, '0'); };
  const parts = [s(name), s(sym), s('meme')];
  let off = 5 * 32; const heads = [];
  for (const p of parts) { heads.push(word(off)); off += p.length / 2; }
  return heads.join('') + word(supply) + addr32(OP) + parts.join('');
};
const P0 = 248n * UNIT;
async function market({ fund = true, S = 950_000_000n * UNIT } = {}) {
  state = new State();
  for (const a of [OP, BUYER, EVE]) state.credit(a, 10n ** 30n);
  const token = await deploy(OP, MEME.bytecode + encCtor('Test Meme', 'TST', 1_000_000_000n * UNIT));
  const factory = await deploy(OP, FACTORY);
  await tx(OP, factory, sel('create(address)') + addr32(token));
  const pool = '0x' + (await evmCall(factory, sel('poolOf(address)') + addr32(token))).slice(-40);
  const seedM = 3000n * UNIT; const seedT = (seedM * UNIT) / P0;
  await tx(OP, token, sel('approve(address,uint256)') + addr32(pool) + word(seedT));
  const sq = (n) => { let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
  await tx(OP, pool, sel('addLiquidity(uint256,uint256)') + word(seedT) + word(sq(seedM * seedT) - 1000n), seedM);
  const curve = await deploy(OP, CURVE.bytecode + addr32(token) + addr32(pool) + word(S) + word(P0) + addr32(OP) + word(1792972800n));
  if (fund) await tx(OP, token, sel('transfer(address,uint256)') + addr32(curve) + word(S));
  return { token, pool, curve, symbol: 'TST' };
}
const poolOut = async (m, amount) => {
  const r = (await evmCall(m.pool, sel('reserves()'))).slice(2);
  const rM = BigInt('0x' + r.slice(0, 64)); const rT = BigInt('0x' + r.slice(64, 128));
  return toBig(await evmCall(m.pool, sel('quote(uint256,uint256,uint256)') + word(amount) + word(rM) + word(rT)));
};
const decide = async (m, amount) => {
  const p = await poolOut(m, amount);
  const c = await curveQuote(m, amount);
  return { p, c, src: pickSource(p, c) };
};
/** Execute what the page would sign for that decision, with the page's minOut (0.5%). */
async function execute(m, amount, d) {
  const out = d.src === 'curve' ? d.c : d.p;
  const minOut = out * 9950n / 10000n;
  const before = toBig(await evmCall(m.token, sel('balanceOf(address)') + addr32(BUYER)));
  const r = d.src === 'curve'
    ? await tx(BUYER, m.curve, curveBuyData(minOut, 1_790_000_600n), amount)
    : await tx(BUYER, m.pool, SEL.swapMoliIn + word(minOut), amount);
  const got = toBig(await evmCall(m.token, sel('balanceOf(address)') + addr32(BUYER))) - before;
  return { r, got };
}

console.log('');
{
  const m = await market();
  const amt = 1000n * UNIT;
  const d = await decide(m, amt);
  check('curve better: at the opening, 1,000 MOLI gets more from the curve than from a 3,000 MOLI pool',
    d.src === 'curve' && d.c > d.p, `curve ${f(d.c)} vs pool ${f(d.p)} TST`);
  const e = await execute(m, amt, d);
  check('  and the page\'s buy(minOut, MAX, deadline) executes, delivering exactly the curve quote',
    !e.r.failed && e.got === d.c, `got ${f(e.got)} TST, gas ${e.r.gasUsed}`);

}
{
  // A small curve (10,000 units) so one 2,000 MOLI purchase lifts its price
  // ~0.6%: still inside the 1% band, but above the pool by more than the
  // pool's 0.3% fee. The pool does not move (deposits go in at its ratio).
  const m = await market({ S: 10_000n * UNIT });
  const lift = await decide(m, 2000n * UNIT);
  await execute(m, 2000n * UNIT, lift);
  const small = 1n * UNIT;
  const d2 = await decide(m, small);
  check('pool better: after that buy the curve sits above the pool, so 1 MOLI is cheaper in the pool',
    d2.c !== null && d2.src === 'pool' && d2.p > d2.c, `pool ${f(d2.p)} vs curve ${f(d2.c)} TST`);
  const e2 = await execute(m, small, d2);
  check('  and the pool swap executes with the page\'s minOut', !e2.r.failed && e2.got === d2.p);
}
{
  const m = await market();
  // EVE dumps into the pool: pool price 2% under the curve -> the curve refuses.
  await tx(OP, m.token, sel('transfer(address,uint256)') + addr32(EVE) + word(10n ** 24n));
  await tx(EVE, m.token, sel('approve(address,uint256)') + addr32(m.pool) + word(10n ** 24n));
  const r = (await evmCall(m.pool, sel('reserves()'))).slice(2);
  await tx(EVE, m.pool, sel('swapTokenForMoli(uint256,uint256)') + word(BigInt('0x' + r.slice(64, 128)) / 99n) + word(1n));
  const d = await decide(m, 100n * UNIT);
  check('curve refusing (pool outside the band): curveQuote is null and the pool is used',
    d.c === null && d.src === 'pool' && d.p > 0n, `pool ${f(d.p)} TST`);
  const e = await execute(m, 100n * UNIT, d);
  check('  and the pool swap executes', !e.r.failed && e.got === d.p);
  const direct = await tx(BUYER, m.curve, curveBuyData(1n, 1_790_000_600n), 100n * UNIT);
  check('  (the curve itself would indeed have refused)', direct.failed);
}
{
  const m = await market({ fund: false });
  const d = await decide(m, 100n * UNIT);
  check('curve not yet funded: curveQuote is null, the pool is used', d.c === null && d.src === 'pool');
}
{
  // Sell-out: a small curve bought out, then the page must fall back to the pool.
  const m = await market({ S: 10_000n * UNIT });
  const S = toBig(await evmCall(m.curve, sel('remaining()')));
  const whole = toBig(await evmCall(m.curve, sel('cost(uint256,uint256)') + word(0n) + word(S)));
  const big = await tx(EVE, m.curve, curveBuyData(1n, 1_790_000_600n), whole * 2n);
  const left = toBig(await evmCall(m.curve, sel('remaining()')));
  check('sell-out: one purchase empties the curve to rounding dust (<= 2 base units, 2e-18)', !big.failed && left <= 2n, `${left} unit(s) left`);
  const d = await decide(m, 100n * UNIT);
  check('  after sell-out the page routes to the pool', d.src === 'pool' && d.p > 0n, `curve ${d.c === null ? 'refuses' : f(d.c)}, pool ${f(d.p)}`);
}

/* ------------------------------------------------- the page wiring */
check('requote compares the two sources only for MOLI -> a coin with a curve',
  page.includes('if (plan.length === 1 && plan[0].moliIn && plan[0].m.curve) {') && page.includes('source = pickSource(out, curveOut)'));
check('⛔ the curve is re-quoted right before signing and never signed for if it would refuse',
  page.includes('const fresh = await curveQuote(plan[0].m, p.amount);') && page.includes("if (fresh === null) throw new Error(t('curveMoved'));"));
check('⛔ every buy is pre-simulated (preflight) and carries explicit gas',
  page.includes("data: curveBuyData(minOut, deadline), gas: '0xc3500' }") && page.includes("data: SEL.swapMoliIn + word(minOut), gas: '0x30d40' }")
  && (page.match(/await preflight\(tx, 'wouldRevert'\);/g) || []).length >= 2);
check('selling a coin always goes to the pool (the curve never buys back)',
  page.includes("data: SEL.swapTokenIn + word(carried) + word(minOut), gas: '0x30d40' }") && !CURVE.abi.some((x) => x.name === 'sell'));
check('the source is shown: "curva de venda" / "pool", and the minimum received',
  page.includes("srcCurve: 'curva de venda'") && page.includes("srcPool: 'pool'") && page.includes("$('minOut').textContent"));
check('?to=SYMBOL opens the page buying that coin with MOLI', page.includes("if (params.get('to')) wantTo = String(params.get('to')).trim();"));
check('the curve address comes from the registry (markets.json meme.curve)', page.includes('const c = m.meme && m.meme.curve;'));
{
  const tokens = JSON.parse(read('src/web/tokens/tokens.json'));
  const list = tokens.tokens || tokens.coins || Object.values(tokens).find(Array.isArray);
  check('the token pages link "Comprar" into /molibra/swap?to=<SYMBOL> for the three coins',
    ['caramelo', 'bolso', 'fazol'].every((k) => list.find((t) => t.key === k).deployments[0].buy === '/molibra/swap?to=' + k.toUpperCase()));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
