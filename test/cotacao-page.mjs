/**
 * cotacao.html - R$ -> MOLI, step by step, with live charts - against the
 * chain's facts, an independent encoder, independent arithmetic and itself.
 *
 * ⛔ People in Brazil read a price off this page and then act on it through
 * the "Converta agora" buttons. The failures that matter: a feed or pool that
 * is not the one named (a price from somewhere else), a selector or event
 * topic that reads the wrong thing, a price shown upside down, a step whose arithmetic drifts from the plain
 * sum, a button that pre-fills the wrong amount or opens the wrong place, a
 * chart that draws nonsense with 0 or 1 points, an outside script, a
 * Portuguese text missing its English twin, and wording that either runs the
 * coin down or promises anything. Each is checked by RUNNING the shipped code.
 *
 * Addresses, verified 3-4 Oct 2026 (eth_getCode + the call named):
 *   Chainlink BRL/USD 0x3126…7Df1 - Chainlink's feed directory
 *     (reference-data-directory feeds-mainnet.json, path "brl-usd"), and
 *     description() == "BRL / USD", decimals() == 8 on chain.
 *   Chainlink ETH/USD 0x5f4e…8419 - same directory ("eth-usd"), description() == "ETH / USD".
 *   Multicall3 0xcA11…CA11 - the canonical deployment.
 *   Uniswap v4 ETH/WSRO pool 0x0a6d…62c3 - Initialize in tx 0x41956f00…102f, block
 *     26,125,858 (5 Oct 2026): currency0 ETH, currency1 WSRO, fee 2500, tickSpacing 25, no
 *     hooks; it replaced the SushiSwap V3 pool 0xfcae…c47e, whose liquidity() is now 0.
 *   Both v4 PoolKeys hash to their poolIds (checked below, as in buy-page.mjs).
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { keccak256, toHex, fromHex } from '../src/crypto.js';
import { poolHistory, POOL_EVENTS } from '../src/poolhistory.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // CRLF-agnostic (Windows checkout)
const page = read('src/web/cotacao.html');
const rpc = read('src/rpc.js');

let pass = 0, fail = 0, skip = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('cotacao.html vs the feeds, the pools, independent arithmetic and itself\n');

const kec = (s) => toHex(keccak256(new TextEncoder().encode(s)));
const sel = (s) => kec(s).slice(0, 10);

/* ----------------------------------------------------------- selectors */

const KEY_T = '(address,address,uint24,int24,address)';
const SIGS = {
  latestRoundData: 'latestRoundData()',
  getRoundData: 'getRoundData(uint80)',
  aggregate3: 'aggregate3((address,bool,bytes)[])',
  getSlot0: 'getSlot0(bytes32)',
  quoteExactInSingle: `quoteExactInputSingle((${KEY_T},bool,uint128,bytes))`,
  quoteExactOutSingle: `quoteExactOutputSingle((${KEY_T},bool,uint128,bytes))`,
  liquidity: 'liquidity()',
  reserves: 'reserves()',
  quote: 'quote(uint256,uint256,uint256)',
};
const block = (name) => { const m = page.match(new RegExp(`const ${name} = \\{[\\s\\S]*?\\n\\};`)); return m ? m[0] : null; };
const selBlock = block('SEL');
check('the page has a selector table', Boolean(selBlock));
for (const [key, sig] of Object.entries(SIGS)) {
  const m = selBlock && selBlock.match(new RegExp(`\\b${key}:\\s*'(0x[0-9a-f]{8})'`));
  check(`${key} is keccak of ${sig}`, Boolean(m) && m[1] === sel(sig), m ? `${m[1]} vs ${sel(sig)}` : 'missing');
}
const TOPICS = {
  v4Initialize: 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)',
  v4Swap: 'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)',
};
const topBlock = block('TOPIC');
for (const [key, sig] of Object.entries(TOPICS)) {
  const m = topBlock && topBlock.match(new RegExp(`\\b${key}:\\s*'(0x[0-9a-f]{64})'`));
  check(`topic ${key} is keccak of ${sig}`, Boolean(m) && m[1] === kec(sig));
}
check('revert NotEnoughLiquidity(bytes32) is named by its selector',
  page.includes(`notEnoughLiquidity: '${sel('NotEnoughLiquidity(bytes32)')}'`));
check('the node reads MolibraPool events by their keccak', POOL_EVENTS.Swapped === kec('Swapped(address,bool,uint256,uint256)')
  && POOL_EVENTS.Minted === kec('Minted(address,uint256,uint256,uint256)') && POOL_EVENTS.Burned === kec('Burned(address,uint256,uint256,uint256)'));
const sol = read('contracts/MolibraPool.sol');
check('  and those are the events MolibraPool.sol emits', sol.includes('event Swapped(address indexed by, bool moliIn, uint256 amountIn, uint256 amountOut);')
  && sol.includes('event Minted(address indexed to, uint256 moli, uint256 tokens, uint256 shares);'));

/* ----------------------------------------------- feeds, pools, contracts */

const CONTRACTS = {
  CHAINLINK_BRL_USD: '0x3126e7f38d5f60f4e2b6ec3511c7bdbd79317df1',
  CHAINLINK_ETH_USD: '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419',
  MULTICALL3: '0xca11bde05977b3631167028862be2a173976ca11',
  POOL_MANAGER: '0x000000000004444c5dc75cb358380d2e3de08a90',
  STATE_VIEW: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
  V4_QUOTER: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
  BMOLI: '0xa302877efb74f567f3605851194b46f1d5746822',
  SUSHI_POOL: '0xfcaee25dd24c129a9069fcd2bedc7cd05798c47e',
  WSRO: '0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8',
  MOLI_POOL: '0x4f34d9bc5db2396640d8eb564667e8701528b43d',
};
for (const [k, a] of Object.entries(CONTRACTS)) check(`${k} is ${a}`, page.includes(`const ${k} = '${a}';`));
check('the Molibra pool is the one pay.html and swap.html trade against',
  read('src/web/pay.html').includes(CONTRACTS.MOLI_POOL) && read('src/web/swap.html').includes(CONTRACTS.MOLI_POOL));
check('the v4 contracts are the ones buy.html uses', ['V4_QUOTER', 'STATE_VIEW', 'CHAINLINK_ETH_USD'].every((k) => read('src/web/buy.html').includes(`const ${k} = '${CONTRACTS[k]}';`)));
const ALLOWED = new Set([...Object.values(CONTRACTS), '0x' + '0'.repeat(40)]);
const named = [...new Set([...page.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].map((m) => m[0].toLowerCase()))];
const stray = named.filter((a) => !ALLOWED.has(a));
check('⛔ no address but these public contracts is written into the page', stray.length === 0, stray.join(', '));

const POOL_ID_ONCHAIN = '0x200f192a14c85d09943f76ae3def3ffe596d93594b6d8ab55b99cdf612b4c312';
const pk = page.match(/const POOL_KEY = \{ currency0: ETH_ADDR, currency1: BMOLI, fee: (\d+)n, tickSpacing: (\d+)n, hooks: ETH_ADDR \};/);
check('the PoolKey is written out in full', Boolean(pk));
if (pk) {
  const w32 = (v) => BigInt(v).toString(16).padStart(64, '0');
  const a32 = (a) => a.toLowerCase().slice(2).padStart(64, '0');
  const enc = a32('0x' + '0'.repeat(40)) + a32(CONTRACTS.BMOLI) + w32(pk[1]) + w32(pk[2]) + a32('0x' + '0'.repeat(40));
  check('⛔⛔ keccak256(abi.encode(PoolKey)) is the bMOLI/ETH poolId', toHex(keccak256(fromHex('0x' + enc))) === POOL_ID_ONCHAIN);
}
check('  and the page carries that poolId', page.includes(`const POOL_ID = '${POOL_ID_ONCHAIN}';`));
const WSRO_POOL_ID_ONCHAIN = '0x0a6dc02a1171887ace334623cff297e0aab91d90a2a2ea7973503200896562c3';
const wk = page.match(/const WSRO_POOL_KEY = \{ currency0: ETH_ADDR, currency1: WSRO, fee: (\d+)n, tickSpacing: (\d+)n, hooks: ETH_ADDR \};/);
check('the ETH/WSRO PoolKey is written out in full', Boolean(wk));
if (wk) {
  const w32 = (v) => BigInt(v).toString(16).padStart(64, '0');
  const a32 = (a) => a.toLowerCase().slice(2).padStart(64, '0');
  const enc = a32('0x' + '0'.repeat(40)) + a32(CONTRACTS.WSRO) + w32(wk[1]) + w32(wk[2]) + a32('0x' + '0'.repeat(40));
  check('⛔⛔ keccak256(abi.encode(WSRO PoolKey)) is the live ETH/WSRO poolId', toHex(keccak256(fromHex('0x' + enc))) === WSRO_POOL_ID_ONCHAIN);
}
check('  and the page carries that poolId', page.includes(`const WSRO_POOL_ID = '${WSRO_POOL_ID_ONCHAIN}';`));
check('  the same one buy.html buys from with ?out=wsro', read('src/web/buy.html').includes(WSRO_POOL_ID_ONCHAIN));
check('history starts at each pool\'s Initialize block: 26,044,855 (bMOLI) and 26,125,858 (WSRO)',
  page.includes('const V4_INIT_BLOCK = 26044855;') && page.includes('const WSRO_INIT_BLOCK = 26125858;'));
check('⛔ the old SushiSwap market is read only for its liquidity() note, never for a price or a quote',
  (page.match(/SUSHI_POOL/g) || []).length === 3 && page.includes('ethCall(SUSHI_POOL, SEL.liquidity)') && !/sushi\.com/.test(page));
check('logs go to Tenderly then MEV Blocker (publicnode refuses old logs), the bridge bot\'s choice',
  page.includes("const LOG_RPCS = ['https://gateway.tenderly.co/public/mainnet', 'https://rpc.mevblocker.io'];")
  && read('bots/bridge-bot.mjs').includes("ethLogs: ['https://gateway.tenderly.co/public/mainnet', 'https://rpc.mevblocker.io']"));
check('the Molibra node is the origin that served the page', page.includes("const MOLIBRA_RPC = NODE + '/molibra';")
  && page.includes("location.protocol.startsWith('http') ? location.origin"));

/* ---------------------------------------------- lift the shipped functions */

const grab = (name) => {
  const m = page.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}\\n`));
  return m ? m[0] : null;
};
const names = ['toUnits', 'fromUnits', 'fromWei', 'localise', 'fmtFixed', 'fmtSig', 'fmt', 'ratioNum', 'word', 'addr32', 'pad32', 'words',
  'poolKeyEnc', 'quoteData', 'aggregate3Data', 'aggregate3Decode', 'brlToUsd8', 'usd8ToWei', 'weiToCents',
  'brlPerUsd8', 'moliPerBrl', 'brlPerMoli18', 'priceWeiPerMoli', 'spotOut1', 'swapFeePips', 'impactBp', 'molibraQuote', 'isPartial',
  'metamaskBuyUrl', 'trustBuyUrl', 'urlAmount', 'buyPageUrl', 'returnPageUrl', 'buyWsroUrl', 'swapPageUrl',
  'sampleIds', 'niceTicks', 'chartModel', 'valueAt'];
const src = names.map(grab);
check('the money, encoding, URL and chart functions can be lifted out of the page', src.every(Boolean),
  names.filter((n, i) => !src[i]).join(', '));
const consts = ['ETH_ADDR', 'BMOLI', 'WSRO'].map((n) => page.match(new RegExp(`const ${n} = [^\\n]+;`))[0])
  .concat([page.match(/const POOL_KEY = [^\n]+;/)[0], page.match(/const WSRO_POOL_KEY = [^\n]+;/)[0], selBlock]);
const ctx = vm.createContext({ BigInt, Number, String, Math, Array, isFinite, Infinity });
vm.runInContext(`const UNIT = 10n ** 18n; const Q192 = 1n << 192n; let LANG = 'pt';\n${consts.join('\n')}\n${src.join('\n')}\n`
  + `this.lib = { ${names.join(', ')}, POOL_KEY, WSRO_POOL_KEY, setLang: (l) => { LANG = l; } };`, ctx);
const lib = ctx.lib;
const E = 10n ** 18n;

/* -------------------------- ⛔⛔ the step maths, against independent sums */

// Live 4 Oct 2026: BRL/USD round 357 = 19185793 (US$ 0.19185793 per real), ETH/USD = 270187358972.
const BRLUSD = 19185793n, ETHUSD = 270187358972n;
const cents = 5000n;                                  // R$ 50,00
const usd8 = lib.brlToUsd8(cents, BRLUSD);
// Independent: R$ 50 x 0.19185793 = 9.5928965 dollars exactly = 959289650 in 8 decimals.
check('⛔ step 1: R$ 50 x 0,19185793 = US$ 9,5928965 exactly', usd8 === 959289650n, String(usd8));
check('  floor property: usd8*100 <= cents*rate < (usd8+1)*100 for awkward inputs',
  [1n, 7n, 599n, 3500n, 123456789n].every((c) => { const u = lib.brlToUsd8(c, BRLUSD); return u * 100n <= c * BRLUSD && c * BRLUSD < (u + 1n) * 100n; }));
const wei = lib.usd8ToWei(usd8, ETHUSD);
// Independent: 9.5928965 / 2701.87358972 ETH, as a rational, floor to wei.
const indep = (959289650n * 10n ** 18n) / 270187358972n;
check('⛔ step 2: US$ / (US$ per ETH) = ETH, to the wei', wei === indep, `${wei} wei`);
check('  and is about 0.00355 ETH (float cross-check, 1e-9 relative)', Math.abs(Number(wei) / 1e18 - (50 * 0.19185793 / 2701.87358972)) < 1e-9 * 0.00355 + 1e-15);
check('  reais per dollar is the inverse of the feed: 1/0.19185793 = 5.2121...', lib.brlPerUsd8(BRLUSD) === 10n ** 16n / BRLUSD
  && Math.abs(Number(lib.brlPerUsd8(BRLUSD)) / 1e8 - 1 / 0.19185793) < 1e-7);
check('  the way back, wei -> centavos, returns R$ 50 to within a centavo', lib.weiToCents(wei, ETHUSD, BRLUSD) >= 4999n && lib.weiToCents(wei, ETHUSD, BRLUSD) <= 5000n);
const out = 1154340340831931787536n;                 // the live quote for 0.0035 ETH, as an example
check('⛔ final: MOLI per R$ 1 = out x 100 / centavos', lib.moliPerBrl(out, cents) === out * 100n / cents);
const inv = lib.brlPerMoli18(cents, out);
check('⛔ final: R$ per MOLI (18 decimals) = 50 / 1154.34...', inv === cents * 10n ** 34n / out
  && Math.abs(Number(inv) / 1e18 - 50 / 1154.340340831931787536) < 1e-12);
check('  step 4 is 1:1: the MOLI shown is the bMOLI quoted', /setText\('r4', fmt\(out\) \+ ' MOLI'\)/.test(page));
check('price per MOLI in ETH = ETH in / bMOLI out', lib.priceWeiPerMoli(E / 1000n, 331034231457812350845n) === (E / 1000n) * E / 331034231457812350845n);

// Spot prices from sqrtPriceX96. v4: tick 127175 (live), bMOLI per ETH ~ 333,322.
const sqrtV4 = 45741621010092210840562718995327n;
const per = lib.spotOut1(E, sqrtV4);
check('bMOLI per ETH from sqrtPriceX96 is ~333,322 (1.0001^127175)', Math.abs(Number(per) / 1e18 - Math.pow(1.0001, 127175)) / Math.pow(1.0001, 127175) < 1e-4, String(per / E));
// ⛔⛔ ETH/WSRO on v4: currency0 is ETH, so the same formula gives WSRO per ETH. Opened at the same tick.
check('⛔⛔ WSRO per ETH reads the right way up: ~333,322 at tick 127175, the same as bMOLI', lib.spotOut1(E, sqrtV4) === per && Number(per / E) === 333321);
check('  the WSRO chart and quote use the WSRO pool, not the bMOLI one',
  page.includes('readV4(WSRO_POOL_ID)') && page.includes('v4History(WSRO_POOL_ID, WSRO_INIT_BLOCK)') && page.includes('await v4Quote(WSRO_POOL_KEY, main.wei)'));
check('⛔ the swap fee includes the protocol fee: 400 + 2500 - 400*2500/1e6 = 2899 pips (slot0 protocolFee 0x190190, live)',
  lib.swapFeePips(0x190190n, 2500n) === 2899n && lib.swapFeePips(0n, 2500n) === 2500n);
{
  const line = page.match(/const fmtFee = [^\n]+;/)[0];
  const fctx = vm.createContext({ BigInt, String });
  vm.runInContext(`const localise = (s) => s.replace('.', ','); ${src[names.indexOf('fromUnits')]}\n${line}\nthis.f = fmtFee;`, fctx);
  check('  shown rounded, not truncated: 2899 pips -> 0,29%, 2500 -> 0,25%', fctx.f(2899n) === '0,29%' && fctx.f(2500n) === '0,25%', fctx.f(2899n));
}
check('  and the impact is measured net of that fee, read live from slot0', page.includes('impactBp(spotOut1(ethIn, M.v4.sqrtP), M.v4.fee, out)')
  && page.includes('return { sqrtP: w[0], fee: swapFeePips(w[2], w[3]) };'));
check('impact is zero when the pool gives the spot price less the fee', lib.impactBp(1000000n, 2500n, 997500n) === 0n);
check('  and 10% when it gives 10% less', lib.impactBp(1000000n, 0n, 900000n) === 1000n);
check('MolibraPool quote(): floor(a*997*rOut / (rIn*1000 + a*997))', (() => {
  const a = 1000n * E, r = 50000n * E;
  return lib.molibraQuote(a, r, r) === (a * 997n * r) / (r * 1000n + a * 997n);
})());
check('  the same rule as the contract', sol.includes('uint256 withFee = amountIn * FEE_NUM;') && sol.includes('return (withFee * reserveOut) / (reserveIn * FEE_DEN + withFee);')
  && sol.includes('FEE_NUM = 997') && sol.includes('FEE_DEN = 1000'));
check('  a partial fill is detected the way buy.html does it', lib.isPartial(E / 1000n, E / 1000n * 99n / 100n) && !lib.isPartial(E / 1000n, E / 1000n));
check('⛔ the page asks the pool for the WSRO -> MOLI quote, not only its own formula',
  page.includes('SEL.quote + word(w.wsro) + word(M.moli.rTok) + word(M.moli.rMoli)'));

check('reais parse to centavos without floats: "50" "50,5" "0,01"', lib.toUnits('50', 2) === 5000n && lib.toUnits('50,5', 2) === 5050n
  && lib.toUnits('0,01', 2) === 1n && lib.toUnits('1,234', 2) === null && lib.toUnits('', 2) === null && lib.toUnits('abc', 2) === null);
lib.setLang('pt');
check('money shows in Brazilian format: R$ 1.234,50', lib.fmtFixed(123450n, 2, 2) === '1.234,50' && lib.fmtFixed(959289650n, 8, 2) === '9,59');
lib.setLang('en');
check('  and in English with a dot', lib.fmtFixed(123450n, 2, 2) === '1,234.50');
lib.setLang('pt');

const calcFns = ['brlToUsd8', 'usd8ToWei', 'weiToCents', 'brlPerUsd8', 'moliPerBrl', 'brlPerMoli18', 'priceWeiPerMoli', 'spotOut1', 'swapFeePips',
  'impactBp', 'molibraQuote', 'isPartial', 'toUnits', 'fromUnits', 'fmtFixed', 'fmtSig', 'urlAmount', 'runChain', 'compute', 'renderCalc'];
const floaty = calcFns.filter((n) => { const s = grab(n); return !s || /parseFloat|Number\(|toFixed|\* 1e18|\/ 1e18|Math\.(round|floor|ceil|pow)/.test(s); });
check('⛔ the calculator\'s amounts never pass through a float', floaty.length === 0, floaty.join(', '));

/* --------------------------------- ⛔⛔ the encodings, decoded by someone else */

let ethers = null;
try { ethers = (await import('ethers')).ethers; } catch (e) { ethers = null; }
if (!ethers) {
  skip++;
  console.log('  SKIP  independent encoder: ethers v6 is not importable from here (npm i ethers in a parent folder)');
} else {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const PKT = '(address,address,uint24,int24,address)';
  const key = ['0x' + '0'.repeat(40), CONTRACTS.BMOLI, 2500n, 25n, '0x' + '0'.repeat(40)];
  const qi = new ethers.Interface([`function quoteExactInputSingle((${PKT},bool,uint128,bytes))`]);
  check('the v4 quote calldata is what ethers encodes (bMOLI)', lib.quoteData(lib.POOL_KEY, sel(SIGS.quoteExactInSingle), wei) === qi.encodeFunctionData('quoteExactInputSingle', [[key, true, wei, '0x']]));
  const keyW = ['0x' + '0'.repeat(40), CONTRACTS.WSRO, 2500n, 25n, '0x' + '0'.repeat(40)];
  check('⛔ and for the ETH/WSRO pool, whose key hashes to its poolId', lib.quoteData(lib.WSRO_POOL_KEY, sel(SIGS.quoteExactInSingle), wei) === qi.encodeFunctionData('quoteExactInputSingle', [[keyW, true, wei, '0x']])
    && ethers.keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'], keyW)) === WSRO_POOL_ID_ONCHAIN);
  const mi = new ethers.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])']);
  const gr = new ethers.Interface(['function getRoundData(uint80)']);
  const calls = [1n, 357n, (1n << 64n) | 300n].map((r) => ({ target: CONTRACTS.CHAINLINK_BRL_USD, data: gr.encodeFunctionData('getRoundData', [r]) }));
  check('⛔ the Multicall3 aggregate3 calldata is what ethers encodes',
    lib.aggregate3Data(calls) === mi.encodeFunctionData('aggregate3', [calls.map((c) => [c.target, true, c.data])]));
  const resultData = mi.encodeFunctionResult('aggregate3', [[[true, coder.encode(['uint80', 'int256', 'uint256', 'uint256', 'uint80'], [357n, BRLUSD, 1n, 1791059231n, 357n])], [false, '0x'], [true, '0x1234']]]);
  const dec = lib.aggregate3Decode(resultData);
  check('  and its result decodes: success flags and return data', dec.length === 3 && dec[0].success && !dec[1].success && dec[2].data === '0x1234'
    && lib.words(dec[0].data)[1] === BRLUSD && lib.words(dec[0].data)[3] === 1791059231n);
  check('  getRoundData(round) is selector + one word', calls[1].data ===sel(SIGS.getRoundData) + lib.word(357n));
  check('the MolibraPool quote calldata is what ethers encodes', (() => {
    const pi = new ethers.Interface(['function quote(uint256,uint256,uint256)']);
    return sel(SIGS.quote) + lib.word(5n) + lib.word(6n) + lib.word(7n) === pi.encodeFunctionData('quote', [5n, 6n, 7n]);
  })());
}

/* ------------------------------ ⛔⛔ "Converta agora": where and how much */

check('step 2 opens MetaMask\'s own buy link with the reais and BRL',
  lib.metamaskBuyUrl(5000n) === 'https://link.metamask.io/buy?chainId=1&amount=50&currency=brl'
  && lib.metamaskBuyUrl(5050n) === 'https://link.metamask.io/buy?chainId=1&amount=50.5&currency=brl');
check('  and Trust Wallet\'s documented buy link for ETH (c60)', lib.trustBuyUrl(3500n) === 'https://link.trustwallet.com/buy?asset=c60&fiat_currency=BRL&fiat_quantity=35');
check('step 3 opens /molibra/buy with the ETH of step 2, truncated to 6 decimals', lib.buyPageUrl(wei) === '/molibra/buy?amount=' + lib.fromWei(wei, 6));
const buyHtml = read('src/web/buy.html');
const buyToWei = buyHtml.match(/function toWei\([\s\S]*?\n\}\n/)[0];
const bctx = vm.createContext({ BigInt, String, Number });
vm.runInContext(`const UNIT = 10n ** 18n;\n${buyToWei}\nthis.toWei = toWei;`, bctx);
const pre = lib.buyPageUrl(wei).split('amount=')[1];
check('  ⛔ buy.html parses that amount, and never to MORE than step 2 worked out', bctx.toWei(pre) !== null && bctx.toWei(pre) <= wei && wei - bctx.toWei(pre) < 10n ** 12n);
check('  buy.html reads ?amount=', buyHtml.includes("params.get('amount')"));
check('  a tiny amount keeps its digits instead of becoming 0', lib.urlAmount(123n) === '0.000000000000000123');
check('step 4 opens /molibra/return with the bMOLI of step 3', lib.returnPageUrl(out) === '/molibra/return?amount=1154.34034');
const ret = read('src/web/return.html');
const retReader = ret.match(/const presetAmount = [^\n]+\n[^\n]+\n/);
check('  return.html reads ?amount= into its amount field', Boolean(retReader) && retReader[0].includes("$('amount').value = presetAmount"));
if (retReader) {
  const field = { value: '1' };
  const run = (q) => { field.value = '1'; vm.runInContext(retReader[0], vm.createContext({ params: new URLSearchParams(q), $: () => field, String, Number })); return field.value; };
  check('  ⛔ it takes a plain decimal and nothing else', run('amount=1154.34034') === '1154.34034' && run('amount=12,5') === '12.5'
    && run('amount=-3') === '1' && run('amount=1e9') === '1' && run('amount=0') === '1' && run('amount=<b>') === '1' && run('') === '1');
  check('  and runs before the send preview is drawn', ret.indexOf('const presetAmount') < ret.indexOf('showSend();\n'));
}
check('the WSRO route buys WSRO with the same direct v4 swap: /molibra/buy?out=wsro',
  lib.buyWsroUrl(wei) === '/molibra/buy?out=wsro&amount=' + lib.fromWei(wei, 6));
check('  and buy.html takes ?out=wsro', buyHtml.includes("const OUT = POOLS[String(new URLSearchParams(location.search).get('out') || '').toLowerCase()] || POOLS.bmoli;"));
check('  and the Molibra swap page selling WSRO', lib.swapPageUrl(1234n * E) === '/molibra/swap?from=WSRO&amount=1234');
const swap = read('src/web/swap.html');
check('  swap.html reads ?from= and ?amount=', swap.includes("if (params.get('from')) wantFrom = String(params.get('from')).trim();")
  && swap.includes("if (params.get('amount')) $('amountIn').value = params.get('amount');"));
check('  ⛔ ?from= picks the market by symbol or address once, then forgets (never overrides the person)',
  /if \(hit\) \{ \$\('fromSel'\)\.value = hit\.token; \$\('toSel'\)\.value = MOLI; wantFrom = null; \}/.test(swap));
const goIds = ['go2', 'go3', 'go4', 'goW2', 'goW4'];
check('every on-chain step has a "Converta agora" button', goIds.every((id) => new RegExp(`<a class="go" id="${id}"[^>]*data-i18n="goNow"`).test(page)));
check('  step 1 has none, and says so', !/id="go1"/.test(page) && page.includes('data-i18n="s1No"'));
check('  the bridge-in step has none, and says the operator does it', /w3Ex[^\n]*operador/.test(page));
check('  each button carries a one-line note of what happens', ['n2', 'n3', 'n4', 'wn2', 'wn4'].every((id) => page.includes(`id="${id}"`)));
check('⛔ the page never signs or sends: no wallet, no eth_sendTransaction, no key',
  !/eth_sendTransaction|eth_sendRawTransaction|eth_requestAccounts|window\.ethereum|private ?key|mnemonic/i.test(page));

/* ------------------------------------------------- charts: 0, 1 and many */

const empty = lib.chartModel([], 1000, 300, 190, 40, 10, 8, 24);
check('chart with 0 points: empty, nothing drawn', empty.empty === true);
const one = lib.chartModel([{ t: 1000, v: 5.2 }], 1000, 300, 190, 40, 10, 8, 24);
check('chart with 1 point: a flat line across a sane range around it', !one.empty && one.yTicks[0].v < 5.2 && one.yTicks[one.yTicks.length - 1].v > 5.2
  && one.end.x === 290 && Math.abs(one.marks[0].y - one.end.y) < 1e-9 && one.t1 - one.t0 >= 3600);
const many = Array.from({ length: 100 }, (_, i) => ({ t: 1000 + i * 3600, v: 2600 + 100 * Math.sin(i / 7) }));
const mm = lib.chartModel(many, 1000 + 99 * 3600, 600, 190, 50, 10, 8, 24);
check('chart with many points: every mark inside the plot', mm.marks.every((m) => m.x >= 50 - 1e-9 && m.x <= 590 + 1e-9 && m.y >= 8 - 1e-9 && m.y <= 166 + 1e-9));
check('  ticks cover the data with clean steps', mm.yTicks[0].v <= 2500 && mm.yTicks[mm.yTicks.length - 1].v >= 2700);
check('  a step path (price holds until the next point) ends at now', /^M[\d.]+,[\d.]+(H[\d.]+V[\d.]+)+H[\d.]+$/.test(mm.path));
const tiny = lib.niceTicks(1.3e-8, 1.4e-8, 4);
check('ticks for a price of a hundred-millionth stay finite and ordered', tiny.length >= 2 && tiny.every((v, i) => isFinite(v) && (i === 0 || v > tiny[i - 1])) && tiny[0] <= 1.3e-8);
const big = lib.niceTicks(73800000, 73800000, 4);
check('  and for a flat 73.8 million', big[0] < 73800000 && big[big.length - 1] > 73800000 && big.length <= 6);
check('  flat at zero does not divide by zero', lib.niceTicks(0, 0, 4).every(isFinite));
check('the tooltip finds the value in force at a time', lib.valueAt(mm.marks, 1000 + 5.5 * 3600).t === 1000 + 5 * 3600);
check('round sampling keeps both ends and never repeats', (() => {
  const a = lib.sampleIds(34000n, 34315n, 100); const b = lib.sampleIds(330n, 357n, 100);
  return a[0] === 34000n && a[a.length - 1] === 34315n && a.length === 100 && new Set(a.map(String)).size === 100 && b.length === 28;
})());
check('every chart has a table twin and a source line', ['brl', 'eth', 'bmoli', 'wsro', 'moli'].every((k) => page.includes(`id="tb-${k}"`) && page.includes(`id="src-${k}"`) && page.includes(`id="ch-${k}"`)));
check('⛔ chart text uses text tokens, never the series colour', !/<text[^>]*fill: 'var\(--gold\)'/.test(page) && !/'text', \{[^}]*fill: 'var\(--gold\)'/.test(page));

/* --------------------------------------------- the node's pool history */

const POOL = CONTRACTS.MOLI_POOL;
const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const log = (topic, by, ...vals) => ({ address: POOL, topics: [topic, '0x' + by.slice(2).padStart(64, '0')], data: '0x' + vals.map(w).join('') });
const A = '0x' + 'ab'.repeat(20);
const receipts = [
  { blockNumber: 20, transactionIndex: 0, transactionHash: '0x2', status: 1, logs: [log(POOL_EVENTS.Swapped, A, 1, 10n * E, 9n * E)] },
  { blockNumber: 10, transactionIndex: 0, transactionHash: '0x1', status: 1, logs: [log(POOL_EVENTS.Minted, A, 100n * E, 100n * E, 1)] },
  { blockNumber: 30, transactionIndex: 0, transactionHash: '0x3', status: 0, logs: [log(POOL_EVENTS.Swapped, A, 0, 5n * E, 4n * E)] },
  { blockNumber: 40, transactionIndex: 1, transactionHash: '0x4', status: 1, logs: [{ ...log(POOL_EVENTS.Swapped, A, 0, 1, 1), address: '0x' + '11'.repeat(20) }] },
  { blockNumber: 50, transactionIndex: 0, transactionHash: '0x5', status: 1, logs: [log(POOL_EVENTS.Swapped, A, 0, 10n * E, 9n * E)] },
];
const hist = poolHistory(receipts, (n) => 1000 + n, POOL);
check('pool history: events in chain order, failed txs and other contracts left out', hist.total === 3 && hist.events.map((e) => e.tx).join() === '0x1,0x2,0x5');
check('  reserves replayed the way MolibraPool moves them', hist.events[1].reserveMoli === String(110n * E) && hist.events[1].reserveToken === String(91n * E)
  && hist.events[2].reserveMoli === String(101n * E) && hist.events[2].reserveToken === String(101n * E));
check('  with block times and a swap count', hist.events[0].time === 1010 && hist.swaps === 2);
check('/molibra/pool-history is routed, validates the address and is cached per head',
  /path === '\/molibra\/pool-history'\)[\s\S]{0,300}\^0x\[0-9a-f\]\{40\}\$[\s\S]{0,200}POOL_HISTORY\(chain, pool\)/.test(rpc)
  && rpc.includes('const POOL_HISTORY = poolHistoryCache();'));
check('  and costs more than a plain read in the rate limiter', read('src/ratelimit.js').includes("['/molibra/pool-history', 5]"));

/* ---------------------------------------------------------- reachability */

check('/molibra/cotacao is routed to cotacao.html', /path === '\/molibra\/cotacao'\)[\s\S]{0,120}'web', 'cotacao\.html'/.test(rpc));
check('  and molibra.org/cotacao redirects there', /const pages = \[[^\]]*'cotacao'[^\]]*\];/.test(rpc));
check('swap.html "Outras formas" links here', swap.includes('<li><a href="/molibra/cotacao">'));
check('pay.html "Comprar MOLI" links here', /id="buyCard"[\s\S]*?href="\/molibra\/cotacao"[\s\S]*?<\/ul>/.test(read('src/web/pay.html')));
check('buy.html links here', buyHtml.includes('href="/molibra/cotacao"'));
check('the front page lists it', read('src/web/index.html').includes('<a class="card" href="/molibra/cotacao">'));
// The way back opens the one-click bridge (6 Oct 2026); /molibra/return stays for the operator.
check('"Como comprar" links buy, the bridge back, pay and swap', ['/molibra/buy', '/molibra/ponte?dir=back', '/molibra/pay', '/molibra/swap'].every((h) => page.includes(`<a href="${h}">`)));
check('⛔ no script from anywhere: not even this node\'s (the page needs none)', !/<script[^>]+src=/.test(page));
check('⛔ no stylesheet, font or import from elsewhere', !/<link[^>]+rel="stylesheet"/.test(page) && !/@import|fonts\.googleapis|cdn/i.test(page));

/* ------------------------------------------------------------ language */

const tBlock = page.match(/const T = \{[\s\S]*?\n\};/);
check('the page carries a PT and an EN dictionary', Boolean(tBlock));
if (tBlock) {
  const T = new Function(`${tBlock[0]}\nreturn T;`)();
  const pk2 = Object.keys(T.pt).sort(), ek = Object.keys(T.en).sort();
  const missing = pk2.filter((k) => !ek.includes(k)).concat(ek.filter((k) => !pk2.includes(k)));
  check('  with the same keys in both', missing.length === 0, missing.join(', '));
  const used = [...new Set([...page.matchAll(/data-i18n="([A-Za-z0-9]+)"|\bt\('([A-Za-z0-9]+)'/g)].map((m) => m[1] || m[2]))];
  const undef = used.filter((k) => !(k in T.en));
  check('  and every key the page uses is defined', undef.length === 0, undef.join(', '));
  const unused = ek.filter((k) => !used.includes(k));
  check('  and none is dead', unused.length === 0, unused.join(', '));
  const holes = Object.keys(T.pt).filter((k) => (T.pt[k].match(/\{\d\}/g) || []).sort().join() !== (T.en[k].match(/\{\d\}/g) || []).sort().join());
  check('  each PT/EN pair fills the same placeholders', holes.length === 0, holes.join(', '));
  // The static HTML text is the PT dictionary text, so the page reads right before any script runs.
  const htmlKeys = [...page.matchAll(/data-i18n="([A-Za-z0-9]+)"[^>]*>([^<]+)</g)];
  const drift = htmlKeys.filter((m) => T.pt[m[1]] !== m[2]).map((m) => m[1]);
  check('  the HTML carries the Portuguese text itself', drift.length === 0, [...new Set(drift)].join(', '));
  check('⭐ the button reads "Converta agora"', T.pt.goNow === 'Converta agora');
  const all = JSON.stringify(T).toLowerCase() + page.toLowerCase();
  const down = ['não vale nada', 'sem valor', 'sem garantia', 'pode perder tudo', 'perder tudo', 'worthless', 'no guarantee', 'lose everything', 'no market', 'sem mercado', 'golpe', 'scam'];
  const promise = ['garantido', 'garantia de', 'lucro', 'valorização', 'vai subir', 'rendimento', 'guaranteed', 'profit', 'will rise', 'returns of'];
  const hitsDown = down.filter((p) => all.includes(p));
  const hitsUp = promise.filter((p) => all.includes(p));
  check('⛔ no line runs MOLI down', hitsDown.length === 0, hitsDown.join(', '));
  check('⛔ and none promises value or returns', hitsUp.length === 0, hitsUp.join(', '));
}
check('⭐ Portuguese unless the person chose English', /l === 'en' \? 'en' : 'pt-BR'/.test(page) && /<html lang="pt-BR">/.test(page));

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
