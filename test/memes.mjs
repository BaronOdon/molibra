/**
 * Memecoins - MemeToken, and the whole /molibra/memes flow, executed on
 * Molibra's OWN EVM (src/evm.js against a real State, the path a mined
 * transaction takes).
 *
 *   1. MemeToken: transfer / approve / transferFrom / burn and their edges.
 *   2. CARAMELO and BOLSO: deploy -> factory pool -> approve -> seed at parity
 *      -> buy -> sell, with the bytecode and encoders the PAGE uses.
 *   3. FAZOL on Molibra: BridgedAsset trusting the keyless authority derived
 *      from the Ethereum FAZOL address, BRIDGE_REGISTER through consensus,
 *      units minted as the bridge would, then its MOLI market.
 *   4. The page: selectors, registry shape, the meme disclaimers.
 *
 * ⛔ The operator's MOLI is the live balance read 5 Oct 2026 (72,374.998 MOLI),
 * so the seeds below are checked against what he actually holds. The
 * contracts the flow touches are all new, so no other live state is involved.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { State, applyTransaction } from '../src/state.js';
import { runEvm, simulate } from '../src/evm.js';
import { intrinsicGas } from '../src/tx.js';
import { keccak256, toHex, fromHex } from '../src/crypto.js';
import { foreignTokenId } from '../src/foreign.js';
import { bridgeAuthority, encodeBridgeRegister, BRIDGE_REGISTER_TAG, mintCall } from '../src/bridgemint.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const MEME = JSON.parse(read('contracts/artifacts/MemeToken.json'));
const POOLART = JSON.parse(read('contracts/artifacts/pool.json'));
const page = read('src/web/memes.html');
const REG = JSON.parse(read('src/web/markets.json'));

let passed = 0; let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

/* ---------------------------------------------- the page's own code */
const region = page.match(/\/\* ABI-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* ABI-END \*\//);
check('memes.html has an ABI-BEGIN/ABI-END region', !!region);
const L = new Function(region[1] + `
return { word, addr32, encCtor, decString, isqrt, parseDec, parityTokens, openingPrices, curveTargetWei, seedMoliFor, MAX_OPENING_PRICE, quoteOut, impactBp, firstShares };`)();
const pageConst = (name) => { const m = page.match(new RegExp(`const ${name} = '([^']*)';`)); return m && m[1]; };
const MEME_BYTECODE = pageConst('MEME_BYTECODE');
const FACTORY_BYTECODE = pageConst('FACTORY_BYTECODE');
check('the page carries the built MemeToken bytecode', MEME_BYTECODE === MEME.bytecode,
  'rebuild with contracts/memes-build-and-test.mjs');
check('the page carries swap.html\'s factory', FACTORY_BYTECODE && read('src/web/swap.html').includes(FACTORY_BYTECODE));

/* ---------------------------------------------------------- harness */
const utf8 = (s) => new TextEncoder().encode(s);
const sel = (s) => toHex(keccak256(utf8(s))).slice(0, 10);
const word = L.word; const addr = L.addr32;
const asBig = (b) => (b.length ? BigInt(toHex(b)) : 0n);
const UNIT = 10n ** 18n;
const GAS = 8_000_000n;
const fmt = (w, p = 4) => (Number(w) / 1e18).toLocaleString('en-US', { maximumFractionDigits: p });

const OPERATOR = '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a';
const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const MINER = '0x000000000000000000000000000000000000beef';
const OPERATOR_LIVE_MOLI = 72374998173349000000000n;   // eth_getBalance, 5 Oct 2026

const state = new State();
state.credit(OPERATOR, OPERATOR_LIVE_MOLI);
state.credit(ALICE, 10_000n * UNIT);
state.credit(BOB, 10_000n * UNIT);

const gasLog = {};
async function deploy(from, bytecode, args = '', label = null) {
  const r = await runEvm(state, { from, to: null, data: bytecode + args, gasLimit: GAS });
  if (r.failed) throw new Error(`deploy failed: ${r.error}`);
  state.bumpNonce(from);
  if (label) gasLog[label] = r.gasUsed;
  return r.createdAddress;
}
async function send(from, to, data, value = 0n, label = null) {
  const r = await runEvm(state, { from, to, data, value, gasLimit: GAS });
  if (!r.failed) state.bumpNonce(from);
  if (label && !r.failed) gasLog[label] = r.gasUsed;
  return r;
}
async function view(to, data) {
  return (await simulate(state, { from: ALICE, to, data, gasLimit: GAS })).returnValue;
}
const num = async (to, data) => asBig(await view(to, data));
const str = async (to, data) => L.decString(toHex(await view(to, data)));
const bal = (tok, who) => num(tok, sel('balanceOf(address)') + addr(who));

/* ----------------------------------------------- 1. MemeToken basics */
console.log('\n1. MemeToken\n');
{
  const SUPPLY = 1000n * UNIT;
  const desc = 'meme não oficial — test';
  const t = await deploy(ALICE, MEME.bytecode, L.encCtor('Test', 'TST', desc, SUPPLY, ALICE));
  check('deploys with the page-encoded constructor', state.hasCode(t), t);
  check('name / symbol / description read back exactly',
    await str(t, sel('name()')) === 'Test' && await str(t, sel('symbol()')) === 'TST'
    && await str(t, sel('description()')) === desc);
  check('decimals 18, totalSupply minted to the holder',
    await num(t, sel('decimals()')) === 18n && await num(t, sel('totalSupply()')) === SUPPLY
    && await bal(t, ALICE) === SUPPLY);

  const bad = await runEvm(state, { from: ALICE, to: null, data: MEME.bytecode + L.encCtor('x', 'X', '', 1n, '0x' + '00'.repeat(20)), gasLimit: GAS });
  check('⛔ a zero holder is refused at construction', bad.failed);

  let r = await send(ALICE, t, sel('transfer(address,uint256)') + addr(BOB) + word(100n * UNIT));
  check('transfer moves units', !r.failed && await bal(t, BOB) === 100n * UNIT && await bal(t, ALICE) === 900n * UNIT);
  check('  and emits Transfer(from, to, value)', r.logs.length === 1 && r.logs[0].topics[0] === toHex(keccak256(utf8('Transfer(address,address,uint256)'))));
  r = await send(BOB, t, sel('transfer(address,uint256)') + addr(ALICE) + word(101n * UNIT));
  check('⛔ a transfer above the balance reverts', r.failed);
  r = await send(BOB, t, sel('transfer(address,uint256)') + addr('0x' + '00'.repeat(20)) + word(1n));
  check('⛔ a transfer to the zero address reverts (burning is burn())', r.failed);
  r = await send(BOB, t, sel('transfer(address,uint256)') + addr(ALICE) + word(0n));
  check('a zero-value transfer succeeds, as ERC-20 requires', !r.failed);

  r = await send(ALICE, t, sel('approve(address,uint256)') + addr(BOB) + word(50n * UNIT));
  check('approve sets the allowance', !r.failed && await num(t, sel('allowance(address,address)') + addr(ALICE) + addr(BOB)) === 50n * UNIT);
  r = await send(ALICE, t, sel('approve(address,uint256)') + addr('0x' + '00'.repeat(20)) + word(1n));
  check('⛔ approving the zero address reverts', r.failed);
  r = await send(BOB, t, sel('transferFrom(address,address,uint256)') + addr(ALICE) + addr(BOB) + word(51n * UNIT));
  check('⛔ transferFrom above the allowance reverts', r.failed);
  r = await send(BOB, t, sel('transferFrom(address,address,uint256)') + addr(ALICE) + addr(BOB) + word(30n * UNIT));
  check('transferFrom within the allowance moves units and spends it',
    !r.failed && await bal(t, BOB) === 130n * UNIT
    && await num(t, sel('allowance(address,address)') + addr(ALICE) + addr(BOB)) === 20n * UNIT);
  await send(ALICE, t, sel('approve(address,uint256)') + addr(BOB) + 'f'.repeat(64));
  await send(BOB, t, sel('transferFrom(address,address,uint256)') + addr(ALICE) + addr(BOB) + word(1n * UNIT));
  check('an unlimited allowance is not decremented', await num(t, sel('allowance(address,address)') + addr(ALICE) + addr(BOB)) === (1n << 256n) - 1n);
  r = await send(BOB, t, sel('transferFrom(address,address,uint256)') + addr(ALICE) + addr(BOB) + word(10_000n * UNIT));
  check('⛔ even unlimited, transferFrom above the owner balance reverts', r.failed);

  const before = await num(t, sel('totalSupply()'));
  r = await send(BOB, t, sel('burn(uint256)') + word(31n * UNIT));
  const burnLog = r.logs[0];
  check('burn destroys the caller\'s units and lowers totalSupply',
    !r.failed && await num(t, sel('totalSupply()')) === before - 31n * UNIT && await bal(t, BOB) === 100n * UNIT);
  check('⭐ burn emits Transfer(caller, 0x0, amount) - the log src/burnproof.js findBurn proves',
    burnLog && burnLog.topics[2] === '0x' + '00'.repeat(32) && burnLog.topics[1].endsWith(BOB.slice(2))
    && BigInt(burnLog.data) === 31n * UNIT);
  r = await send(BOB, t, sel('burn(uint256)') + word(101n * UNIT));
  check('⛔ burning above the balance reverts', r.failed);
  for (const fn of ['mint(address,uint256)', 'owner()', 'pause()', 'burnFrom(address,uint256)']) {
    r = await runEvm(state.clone(), { from: ALICE, to: t, data: sel(fn) + word(1n) + word(1n), gasLimit: GAS });
    check(`⛔ there is no ${fn}`, r.failed);
  }
}

/* -------------------------------- 2. CARAMELO and BOLSO, end to end */
console.log('\n2. Molibra memecoins: deploy, market, seed at parity, buy, sell\n');
const snap = REG.snapshot;
const moliUsdE18 = L.parseDec(snap.moliUsd);
const factory = await deploy(OPERATOR, FACTORY_BYTECODE, '', 'factory deploy');
check('the factory deploys', state.hasCode(factory), factory);
const report = [];

// The page's scale (5 Oct 2026): parity = the ratio between the coins; buying out all
// three curves costs 30 days of MOLI mining.
const anchorUsdE18 = L.parseDec(REG.counterparts['official-trump'].usd);
const MEME_KEYS = ['caramelo', 'bolso', 'fazol'];
const memeRows = MEME_KEYS.map((k) => REG.markets.find((x) => x.key === k));
const PRICES = Object.fromEntries(L.openingPrices(
  memeRows.map((m) => ({ curve: BigInt(m.meme.allocation.curve), cpUsdE18: L.parseDec(REG.counterparts[m.meme.counterpart].usd) })),
  anchorUsdE18, L.curveTargetWei()).map((p, i) => [MEME_KEYS[i], p]));
const PRICE_BY_SYMBOL = Object.fromEntries(memeRows.map((m) => [m.symbol, PRICES[m.key]]));
{
  const buyout = memeRows.reduce((sum, m) => sum + 3n * L.parseDec(m.meme.allocation.curve) * PRICES[m.key] / UNIT, 0n);
  const target = L.curveTargetWei();
  check('buying out all three curves costs 30 days of MOLI mining (2 MOLI x 86,400 s / 22.37 s x 30)',
    target === 231738n * UNIT && buyout <= target && target - buyout < UNIT / 1000n, `${fmt(buyout, 2)} of ${fmt(target, 2)} MOLI`);
  check('BOLSO and FAZOL open at the same price (same reference)', PRICES.bolso === PRICES.fazol);
}
async function market(sym, token, seedMoli, seedTok, cpUsd) {
  let r = await send(OPERATOR, factory, sel('create(address)') + addr(token), 0n, `${sym} create pool`);
  check(`${sym}: the factory creates its MOLI market`, !r.failed);
  const pool = '0x' + toHex(await view(factory, sel('poolOf(address)') + addr(token))).slice(-40);
  r = await send(OPERATOR, token, sel('approve(address,uint256)') + addr(pool) + word(seedTok), 0n, `${sym} approve`);
  check(`${sym}: approve exactly the seed`, !r.failed);
  const minShares = L.firstShares(seedMoli, seedTok);
  r = await send(OPERATOR, pool, sel('addLiquidity(uint256,uint256)') + word(seedTok) + word(minShares), seedMoli, `${sym} addLiquidity`);
  check(`${sym}: seeded with minShares = sqrt(m·t) − 1000 exactly`, !r.failed, r.error ?? '');
  const res = toHex(await view(pool, sel('reserves()'))).slice(2);
  const rm = BigInt('0x' + res.slice(0, 64)); const rt = BigInt('0x' + res.slice(64, 128));
  const spot = (rm * UNIT) / rt;                       // MOLI per token, 18 dp
  const parity = PRICE_BY_SYMBOL[sym];
  const err = spot > parity ? spot - parity : parity - spot;
  check(`${sym}: the pool's spot price IS the parity`, err * 1_000_000n <= parity,
    `${fmt(spot, 6)} MOLI vs parity ${fmt(parity, 6)}`);

  const rows = [];
  for (const x of [10n, 100n, 1000n]) {
    const s = state.clone();
    const want = L.quoteOut(x * UNIT, rm, rt);
    const r2 = await runEvm(s, { from: ALICE, to: pool, data: sel('swapMoliForToken(uint256)') + word(want), value: x * UNIT, gasLimit: GAS });
    const got = asBig((await simulate(s, { from: ALICE, to: token, data: fromHex(sel('balanceOf(address)') + addr(ALICE)), gasLimit: GAS })).returnValue);
    check(`${sym}: a ${x}-MOLI buy executes and pays exactly the page's quote`, !r2.failed && got === want, `${fmt(got, 6)} ${sym}`);
    rows.push({ x, out: got, bp: L.impactBp(x * UNIT, rm, rt) });
  }
  // A real buy, then sell all of it back.
  const out = L.quoteOut(100n * UNIT, rm, rt);
  r = await send(BOB, pool, sel('swapMoliForToken(uint256)') + word(out), 100n * UNIT, `${sym} buy`);
  check(`${sym}: buy 100 MOLI`, !r.failed);
  await send(BOB, token, sel('approve(address,uint256)') + addr(pool) + word(out));
  const before = state.balanceOf(BOB);
  r = await send(BOB, pool, sel('swapTokenForMoli(uint256,uint256)') + word(out) + word(1n), 0n, `${sym} sell`);
  const back = state.balanceOf(BOB) - before;
  check(`${sym}: sell it all back; the round trip costs the two 0.3% fees and no more`,
    !r.failed && back < 100n * UNIT && back > 99_39n * UNIT / 100n, `${fmt(back, 4)} MOLI back of 100`);
  report.push({ sym, pool, rm, rt, spot, rows, roundTrip: back });
  return pool;
}

/**
 * The distribution step the page runs after the market exists: curve at the
 * pool's OWN spot price with its allocation, vesting with 4% (Molibra coins),
 * then a real buy through the curve. Uses the page's stamped bytecode.
 */
const CURVE_BYTECODE = pageConst('CURVE_BYTECODE');
const VESTING_BYTECODE = pageConst('VESTING_BYTECODE');
check('the page carries the built MoliSaleCurve', CURVE_BYTECODE === JSON.parse(read('contracts/artifacts/MoliSaleCurve.json')).bytecode);
check('the page carries the trust pack\'s TokenVesting', VESTING_BYTECODE === JSON.parse(read('contracts/artifacts/trust.json')).contracts.TokenVesting.bytecode);
async function distribute(m, token, pool, { vesting }) {
  const sym = m.symbol;
  const res = toHex(await view(pool, sel('reserves()'))).slice(2);
  const p0 = (BigInt('0x' + res.slice(0, 64)) * UNIT) / BigInt('0x' + res.slice(64, 128));
  const curveAmt = L.parseDec(m.meme.allocation.curve);
  const curve = await deploy(OPERATOR, CURVE_BYTECODE, addr(token) + addr(pool) + word(curveAmt) + word(p0) + addr(OPERATOR) + word(1792972800n), `${sym} curve deploy`);
  let r = await send(OPERATOR, token, sel('transfer(address,uint256)') + addr(curve) + word(curveAmt), 0n, `${sym} fund curve`);
  check(`${sym}: curve deployed at the pool's price and funded with ${fmt(curveAmt, 0)}`, !r.failed && await bal(token, curve) === curveAmt,
    `opens ${fmt(p0, 4)} MOLI, sells out at ${fmt(5n * p0, 4)}`);
  if (vesting) {
    const v = m.meme.vestingSchedule;
    const vest = await deploy(OPERATOR, VESTING_BYTECODE, addr(token) + addr(v.beneficiary) + word(1_790_000_000n)
      + word(BigInt(v.cliffDays) * 86400n) + word(BigInt(v.durationDays) * 86400n), `${sym} vesting deploy`);
    const vAmt = L.parseDec(m.meme.allocation.vesting);
    r = await send(OPERATOR, token, sel('transfer(address,uint256)') + addr(vest) + word(vAmt), 0n, `${sym} fund vesting`);
    check(`${sym}: vesting deployed and funded with 4% (${fmt(vAmt, 0)})`, !r.failed && await bal(token, vest) === vAmt);
    const wallet = L.parseDec(m.meme.allocation.wallet);
    const opBal = await bal(token, OPERATOR);
    // 5 Oct 2026: the seed IS the operator's whole 1% (operator's scale: all three curves = 30 days of mining).
    check(`${sym}: the whole 1% seeded the pool, so the operator holds no free tokens`,
      opBal === 0n && wallet === L.parseDec(m.meme.supply) / 100n, `${fmt(opBal, 2)} ${sym}`);
    check(`${sym}: 95 + 4 + 1 = the whole supply`,
      curveAmt + vAmt + wallet === L.parseDec(m.meme.supply));
  }
  const before = await bal(token, ALICE);
  r = await send(ALICE, curve, sel('buy(uint256,uint256,uint256)') + word(1n) + 'f'.repeat(64) + 'f'.repeat(64), 100n * UNIT, `${sym} curve buy`);
  const got = (await bal(token, ALICE)) - before;
  check(`${sym}: 100 MOLI bought through the curve, and the MOLI went into the pool`, !r.failed && got > 0n
    && state.balanceOf(curve) < 10n ** 9n, `${fmt(got, 6)} ${sym}${r.failed ? ' ' + r.error : ''}`);
  return curve;
}

const used = {};
for (const key of ['caramelo', 'bolso', 'fazol']) {
  const m = REG.markets.find((x) => x.key === key);
  const cp = REG.counterparts[m.meme.counterpart];
  const supply = L.parseDec(m.meme.supply);
  const token = await deploy(OPERATOR, MEME_BYTECODE, L.encCtor(m.meme.name, m.symbol, m.meme.description, supply, OPERATOR), `${m.symbol} deploy`);
  check(`${m.symbol}: deploys, whole supply to the operator`, await bal(token, OPERATOR) === supply,
    `${Number(m.meme.supply).toLocaleString('en-US')} ${m.symbol}`);
  check(`${m.symbol}: the on-chain description is the registry's, disclaimer included`,
    await str(token, sel('description()')) === m.meme.description);
  const price = PRICES[key];
  const seedTok = L.parseDec(m.meme.allocation.wallet);
  const seedMoli = L.seedMoliFor(seedTok, price);
  // ⛔ The 5 Oct failure, as a test: a memecoin opens at a tiny fraction of a MOLI,
  // and the whole supply is worth far less than the MOLI that exists.
  check(`${m.symbol}: opens far below 1 MOLI (${fmt(price, 12)} MOLI; 1 MOLI = ${(UNIT / price).toLocaleString('en-US')} ${m.symbol})`,
    price > 0n && price < L.MAX_OPENING_PRICE);
  // ~299,500 MOLI exist at block 149,729: every coin's whole supply opens well under that.
  check(`${m.symbol}: whole-supply value at the opening is under 20% of today's MOLI (60,000)`,
    (supply * price) / UNIT < 60_000n * UNIT, `${fmt((supply * price) / UNIT, 0)} MOLI`);
  used[key] = seedMoli;
  const pool = await market(m.symbol, token, seedMoli, seedTok, cp.usd);
  await distribute(m, token, pool, { vesting: true });
}

const spent = Object.values(used).reduce((a, b) => a + b, 0n);
check('the three seeds fit in the operator\'s live MOLI with room to spare', spent * 4n < OPERATOR_LIVE_MOLI,
  `${fmt(spent, 0)} of ${fmt(OPERATOR_LIVE_MOLI, 0)} MOLI`);

console.log('\n  pool        reserves                         spot (MOLI)   buy 10       buy 100      buy 1000     100-MOLI round trip');
for (const r of report) {
  console.log(`  ${r.sym.padEnd(10)}  ${fmt(r.rm, 0)} MOLI / ${fmt(r.rt, 4)} ${r.sym}`.padEnd(50)
    + `  ${fmt(r.spot, 4).padStart(10)}  ` + r.rows.map((x) => `${(Number(x.bp) / 100).toFixed(2)}%`.padStart(10)).join('   ')
    + `   ${fmt(r.roundTrip, 4)} MOLI`);
}
console.log('\n  gas used (Molibra, at 1 gwei = 1e-9 MOLI per gas):');
for (const [k, g] of Object.entries(gasLog)) console.log(`    ${k.padEnd(28)} ${g}`);

/* ------------------------------------------------------- 4. the page */
console.log('\n4. The page and the registry\n');
const SIGS = {
  name: 'name()', symbol: 'symbol()', description: 'description()', totalSupply: 'totalSupply()',
  balanceOf: 'balanceOf(address)', approve: 'approve(address,uint256)', allowance: 'allowance(address,address)',
  transfer: 'transfer(address,uint256)', create: 'create(address)', poolOf: 'poolOf(address)',
  addLiquidity: 'addLiquidity(uint256,uint256)', reserves: 'reserves()', totalShares: 'totalShares()',
  getSlot0: 'getSlot0(bytes32)',
  latestRoundData: 'latestRoundData()',
};
const block = page.match(/const SEL = \{[\s\S]*?\n\};/)[0];
for (const [k, s] of Object.entries(SIGS)) {
  const m = block.match(new RegExp(`${k}:\\s*'(0x[0-9a-f]{8})'`));
  check(`SEL.${k} is keccak of ${s}`, !!m && m[1] === sel(s), m ? m[1] : 'missing');
}

check('the registry lists WSRO with its live pool', REG.markets.some((m) => m.key === 'wsro' && m.pool === '0x4f34d9bc5db2396640d8eb564667e8701528b43d'));
for (const key of ['caramelo', 'bolso', 'fazol']) {
  const m = REG.markets.find((x) => x.key === key);
  check(`${key} is in the registry`, !!m && !!m.meme);
  const d = m.meme.description;
  check(`  ${m.symbol}: the description says it is a meme with no promise of value (PT + EN)`,
    /meme/i.test(d) && /sem nenhuma promessa de valor/.test(d) && /no promise of value/.test(d));
  if (key !== 'caramelo') {
    check(`  ${m.symbol}: unofficial, not affiliated, not endorsed (PT + EN)`,
      /não oficial/.test(d) && /sem vínculo|Não tem vínculo/.test(d) && /not affiliated with or endorsed by/i.test(d));
  }
  check(`  ${m.symbol}: its counterpart has a price`, !!REG.counterparts[m.meme.counterpart]?.usd);
}
{
  // Operator, 5 Oct: FAZOL pairs with TRUMP, like BOLSO, so both open at one price.
  const fz = REG.markets.find((x) => x.key === 'fazol');
  const bo = REG.markets.find((x) => x.key === 'bolso');
  check('FAZOL and BOLSO share the TRUMP parity, and TRUMP is the dropdown default',
    fz.meme.counterpart === 'official-trump' && bo.meme.counterpart === 'official-trump'
    && fz.meme.options[0] === 'official-trump');
  for (const k of ['caramelo', 'bolso', 'fazol']) {
    const mm = REG.markets.find((x) => x.key === k);
    check(`  ${mm.symbol} declares its reference pair for display: ${mm.meme.referencePair && mm.meme.referencePair.symbol}`,
      !!mm.meme.referencePair && REG.counterparts[mm.meme.referencePair.counterpart].symbol === mm.meme.referencePair.symbol
      && /Não é paridade garantida nem lastro/.test(mm.meme.referencePair.note));
  }
  check('  CARAMELO→DOGE, BOLSO→TRUMP, FAZOL→TRUMP', ['caramelo:DOGE', 'bolso:TRUMP', 'fazol:TRUMP'].every((x) => {
    const [k, s] = x.split(':'); return REG.markets.find((m) => m.key === k).meme.referencePair.symbol === s; }));
}
const bolso = REG.markets.find((x) => x.key === 'bolso');
check('BOLSO names the person it is NOT affiliated with, and the family and parties',
  bolso.symbol === 'BOLSO' && bolso.meme.name === 'Bolsonaro Meme' && /Jair Bolsonaro, sua família ou qualquer partido\/campanha/.test(bolso.meme.description));
check('FAZOL: not affiliated with Lula or any party or campaign',
  /sem vínculo com Luiz Inácio Lula da Silva ou qualquer partido\/campanha/.test(REG.markets.find((x) => x.key === 'fazol').meme.description));
check('⛔ the page shows no image of anybody', !/<img|background-image|\.jpg|\.png/i.test(page.replace(/\/icon\.png/g, '')));
check('⛔ the page and registry add no electoral clause (electoral law attaches to GIZ only)',
  // Word boundaries: "querySelectorAll" contains "electorAl".
  !/\bTSE\b|\beleitora(l|is)\b|\belectoral\b/i.test(page + JSON.stringify(REG)));
check('the page reads addresses from /molibra/markets.json', page.includes("'/molibra/markets.json'"));
check('⛔ every Molibra step is simulated before the wallet is asked',
  /eth_estimateGas/.test(page) && /a simulação reverte/.test(page));
check('⛔ FAZOL is Molibra-native now: no Ethereum send, no Uniswap, no bridge step on the page',
  !['ethSend', 'PositionManager', 'Permit2', 'BRIDGE_REGISTER', 'BridgedAsset', 'id="e1"', 'id="m1"'].some((s) => page.includes(s)));
check('⛔ the first deposit refuses a pool that already has liquidity', page.includes('if (ts !== 0n)'));
{
  // The page's main script must at least PARSE: a syntax error kills every button at once.
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let err = null;
  try { for (const sc of scripts) new Function(sc); } catch (e) { err = e.message; }
  check('the page script parses', scripts.length > 0 && !err, err ?? `${scripts.length} inline script(s)`);
}
check('⛔ a price-setting step refuses to run on the snapshot prices',
  (page.match(/needLive\(\);/g) || []).length >= 2);
check('⛔ no innerHTML assignment anywhere on the page (audit, 5 Oct 2026)', !/\.innerHTML\s*=/.test(page));
check('⛔ the page never calls the operator\'s seed "locked": it says the seed is withdrawable and only the curve\'s liquidity is permanent',
  page.includes('A semente NÃO fica travada') && !/semente[^.]{0,40}travada(?! )/.test(page.replace('A semente NÃO fica travada', '')));
check('⛔ only the operator account may run a step', page.includes("if (account !== OPERATOR)"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
