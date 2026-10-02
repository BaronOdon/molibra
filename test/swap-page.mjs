/**
 * swap.html against the pool it trades on.
 *
 * ⛔ This is a PUBLIC page: strangers connect wallets to it and sign what it
 * builds. The failure that matters is not a broken layout, it is a page that
 * builds a transaction meaning something other than what it displayed. So the
 * checks here are about the selectors, the addresses, and the safety
 * properties — never about appearance.
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { keccak256, toHex } from '../src/crypto.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(ROOT, 'src/web/swap.html'), 'utf8');
const pool = readFileSync(join(ROOT, 'contracts/MolibraPool.sol'), 'utf8');

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('swap.html vs contracts/MolibraPool.sol\n');

const sel = (s) => toHex(keccak256(new TextEncoder().encode(s))).slice(0, 10);

/* ----------------------------------------------------------- selectors */

const SIGS = {
  reserves: 'reserves()',
  quote: 'quote(uint256,uint256,uint256)',
  swapMoliIn: 'swapMoliForToken(uint256)',
  swapTokenIn: 'swapTokenForMoli(uint256,uint256)',
  approve: 'approve(address,uint256)',
  allowance: 'allowance(address,address)',
  balanceOf: 'balanceOf(address)',
  token: 'token()',
  addLiquidity: 'addLiquidity(uint256,uint256)',
  removeLiquidity: 'removeLiquidity(uint256,uint256,uint256)',
  totalShares: 'totalShares()',
  shares: 'shares(address)',
  // The factory, which is what lets many tokens each have a market.
  allMarkets: 'allMarkets()',
  poolOf: 'poolOf(address)',
  createPool: 'create(address)',
  reservesOf: 'reservesOf(address[])',
  tokenCount: 'tokenCount()',
  // ⛔ Optional ERC-20 metadata. Plenty of real tokens omit these, so the page
  // must degrade rather than refuse to list a token that has no symbol().
  symbol: 'symbol()',
  decimals: 'decimals()',
};

const block = page.match(/const SEL = \{[\s\S]*?\n\};/);
check('the page has a selector table', Boolean(block));
for (const [key, sig] of Object.entries(SIGS)) {
  const m = block && block[0].match(new RegExp(`${key}:\\s*'(0x[0-9a-f]{8})'`));
  check(`${key} is keccak of ${sig}`, Boolean(m) && m[1] === sel(sig),
    m ? `${m[1]} vs ${sel(sig)}` : 'missing');
}

/* ------------------------------------------- the functions actually exist */

const factory = readFileSync(join(ROOT, 'contracts/MolibraPoolFactory.sol'), 'utf8');
for (const sig of ['allMarkets', 'create', 'reservesOf', 'tokenCount']) {
  check(`  factory.${sig} exists`, factory.includes(`function ${sig}`));
}
// ⛔ poolOf is a public MAPPING, so its getter is generated and there is no
// `function poolOf` to grep for. Checking for one failed against a contract
// that was correct — the selector check above is what actually proves it.
check('  factory.poolOf is a public mapping with a generated getter',
  /mapping\(address => address\) public poolOf/.test(factory));
check('⛔⛔ the factory refuses a token with no code',
  factory.includes('extcodesize') && factory.includes('NotAContract'),
  'an expression token is not a contract, so this is where a market in one fails');
check('  and refuses a duplicate pool',
  factory.includes('AlreadyExists'),
  'two pools for one token would split its liquidity and give two prices');

for (const sig of ['swapMoliForToken', 'swapTokenForMoli', 'quote', 'reserves', 'addLiquidity', 'removeLiquidity']) {
  check(`  ${sig} exists on the contract`, pool.includes(`function ${sig}`),
    'a selector for a function that is not there calls nothing and reverts');
}

/* -------------------------------------------------------- the addresses */

check('the known live pool is seeded, not only factory-discovered',
  page.includes('SEED_MARKETS'),
  'the MOLI/WSRO pool predates the factory; listing only factory pools would drop it');

check('the pool address is the live one',
  page.includes('0x4f34d9bc5db2396640d8eb564667e8701528b43d'));
check('the token address is the live Coinspirit contract',
  page.includes('0xcedb6badceceeb46e21877c45b8b9087cb8e4d6a'));
check('the chain id is Molibra', page.includes('0x4f02'), '20226');

/* ------------------------------------------------- ⛔ safety properties */

// The single most important one. A page that recomputes constant-product
// arithmetic locally will eventually disagree with the pool by a rounding step,
// and the swap reverts on minOut for a reason nobody can see.
check('⛔⛔ the quote comes from the CONTRACT, not from arithmetic in the page',
  page.includes('SEL.quote + word(amt) + word(rIn) + word(rOut)'),
  'one source of truth for the output, and it is the chain');
check('  and the page says so where a reader will find it',
  /never recomputed here|never does its own constant-product/i.test(page));

check('⛔ a minimum-received is sent with every swap',
  page.includes('SEL.swapMoliIn + word(minOut)')
  && page.includes('SEL.swapTokenIn + word(carried) + word(minOut)'),
  'a swap without minOut fills at any price, which is what a sandwich needs');

check('⛔⛔ it re-quotes immediately BEFORE signing',
  /await refresh\(\);[\s\S]{0,200}lastPlan \? lastPlan\.out/.test(page),
  'a tolerance derived from a stale quote protects against the wrong price');

check('⛔ approval is for the exact amount, not unlimited',
  page.includes('SEL.approve + addr32(lastPlan.plan[0].pool) + word(lastPlan.amount)')
  && !/word\(2n \*\* 256n - 1n\)|ffffffffffffffff.*approve/i.test(page),
  'an infinite approval is convenient once and permanent afterwards');

check('price impact is computed and shown for every trade',
  page.includes('impactBp') && page.includes("$('impact')"));
check('  with a gentle note only above 5%',
  /impactBp > 5/.test(page));
// The operator's rule (2 Oct 2026): show the number, never a discouraging
// disclaimer. Price impact per trade is honest and neutral; a banner telling
// people a market says nothing about worth, or that pools are small, is not.
check('⛔ no discouraging disclaimer on the page',
  !/says nothing about whether|pools here are small|thin pool|worth anything/i.test(page));

check('⛔ spot price is labelled as not an oracle, for anyone reading the source',
  /not an oracle/i.test(page),
  'a contract trusting a reserve ratio as a feed is manipulable within one block');

// Amounts must never round-trip through a float.
check('⛔ amounts are parsed to wei without floating point',
  page.includes('function toWei') && /BigInt\(w \|\| '0'\) \* UNIT/.test(page),
  'Number cannot hold 18 decimals and would silently truncate somebody\'s balance');
check('  and formatted back without it',
  page.includes('function fromWei') && !/Number\(v\)\s*\/\s*1e18/.test(page));

/* ---------------------------------------------------------- many tokens */

check('⭐ any token routes to any other in at most two hops',
  page.includes('function planRoute') && /via MOLI|through MOLI|MOLI on one side/i.test(page),
  'every pool has MOLI on one side, so n tokens need n pools, not n²');
check('  and a token-to-token route goes through MOLI',
  /moliIn: false, m: a \}, \{ pool: b\.pool, moliIn: true/.test(page));
check('⛔ only the FINAL hop carries the slippage tolerance',
  /last \? out \* BigInt/.test(page),
  'bounding an intermediate hop by a guess strands the trader in MOLI mid-route');
check('tokens can be added by address, permissionlessly',
  page.includes('molibra.tokens') && page.includes("$('add')"));
check('⛔ a missing symbol() degrades rather than refusing the token',
  page.includes('function decodeString') && /OPTIONAL on real tokens/i.test(page));
check('⛔⛔ deploy and create carry EXPLICIT gas',
  /data: FACTORY_BYTECODE, gas: '0x1E8480'/.test(page)
  && /SEL\.createPool \+ addr32\(t\), gas: '0x16E360'/.test(page),
  'a create quoted by a node that does not simulate creates runs out of gas and reads as a revert');
check('⛔⛔ the page refuses to create a market for an already-seeded token',
  page.includes('already has a pool at') && page.includes('SEED_MARKETS.find'),
  'the factory only guards pools IT created; a hand-deployed pool is invisible to it');
check('the factory can be deployed and markets created from the page',
  page.includes('deployFactory') && page.includes('SEL.createPool + addr32(t)'));

/* ----------------------------------------------------------- liquidity */

check('  totalShares and shares are public on the pool, so their getters exist',
  /uint256 public totalShares/.test(pool) && /mapping\(address => uint256\) public shares/.test(pool));

check('⛔ addLiquidity sends MOLI as value and the token amount + minShares as args',
  /value: hex\(a\.v\),\s*data: SEL\.addLiquidity \+ word\(a\.tok\) \+ word\(a\.minShares\)/.test(page),
  'argument order is (tokenAmount, minShares); MOLI is msg.value');
check('⛔ removeLiquidity carries a minimum on BOTH sides',
  page.includes('SEL.removeLiquidity + word(r.amount) + word(r.minMoli) + word(r.minTokens)'));
check('⛔ the liquidity approval is exact too',
  page.includes('SEL.approve + addr32(pool.m.pool) + word(a.tok)'));
check('⛔ a deposit is recomputed from reserves read right before signing',
  /async function doAdd\(\)[\s\S]{0,400}await refresh\(\);[\s\S]{0,80}addPlan\(\)/.test(page));
check('⛔ every state-changing call is simulated by eth_call before the wallet sees it',
  (page.match(/await preflight\(tx, /g) || []).length >= 3,
  'swap, add and remove - a revert caught here costs the person nothing');

/**
 * ⛔⛔ The token side of a deposit, EXECUTED against the contract's own rule.
 *
 * MolibraPool.addLiquidity mints min(byMoli, byToken) with byX = x*ts/rX and
 * reverts Imbalanced when they differ by more than one. A page that rounds the
 * token side DOWN, or reads the ratio the wrong way round, builds a deposit
 * that reverts every time - so the shipped function is lifted out of the page
 * and run against that rule over live-shaped and awkward reserves.
 */
const grab = (name) => {
  const m = page.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n`));
  return m ? m[0] : null;
};
const src = [grab('ceilDiv'), grab('matchTokens'), grab('toWei'), grab('fromWei')];
check('the deposit-matching and amount functions can be lifted out of the page', src.every(Boolean));
if (src.every(Boolean)) {
  const lib = new Function(`const UNIT = 10n ** 18n;\n${src.join('\n')}\nreturn { ceilDiv, matchTokens, toWei, fromWei };`)();
  const contractAccepts = (v, tok, rM, rT, ts) => {
    const byMoli = (v * ts) / rM;
    const byToken = (tok * ts) / rT;
    const gap = byMoli > byToken ? byMoli - byToken : byToken - byMoli;
    const minted = byMoli < byToken ? byMoli : byToken;
    return gap <= 1n && minted > 0n ? minted : null;
  };
  const E = 10n ** 18n;
  const cases = [
    [2000n * E, 2000n * E, 2000n * E],            // live today
    [50000n * E, 50000n * E, 50000n * E],         // after the planned deepening
    [2003n * E + 7n, 1996n * E + 12345n, 2000n * E],   // after some swaps
    [1234567n * E, 8910n * E, 99999n * E],        // lopsided
    [777n * E, 31337n * E, 5000n * E],
  ];
  let seed = 12345n;
  const rnd = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return seed % n; };
  for (let i = 0; i < 300; i++) {
    cases.push([rnd(10n ** 24n) + E, rnd(10n ** 24n) + E, rnd(10n ** 24n) + E]);
  }
  let ok = 0, bad = [], down = 0;
  for (const [rM, rT, ts] of cases) {
    for (const v of [1n, 10n ** 15n, E, 3n * E + 1n, rnd(100n * E) + 1n]) {
      const r = lib.matchTokens(v, rM, rT, ts);
      if (!r) continue;                         // offered nothing: no revert built
      const minted = contractAccepts(v, r.tok, rM, rT, ts);
      if (minted === null || minted !== r.minted) bad.push([v, rM, rT, ts]);
      else ok++;
      // The ratio rounded UP is the first choice whenever the pool accepts it;
      // the fallback exists only for pools whose shares have drifted from reserves.
      const up = lib.ceilDiv(v * rT, rM);
      if (contractAccepts(v, up, rM, rT, ts) !== null && r.tok !== up) down++;
    }
  }
  check('⛔⛔ every deposit the page offers passes the pool\'s Imbalanced rule', bad.length === 0 && ok > 1000,
    `${ok} accepted, ${bad.length} would revert`);
  check('  and the token side is the reserve ratio rounded UP whenever the pool accepts that', down === 0);
  const live = lib.matchTokens(100n * E, 2000n * E, 2000n * E, 2000n * E);
  check('  100 MOLI into the live 2000/2000 pool asks for 100 WSRO and mints 100 shares',
    live && live.tok === 100n * E && live.minted === 100n * E);

  check('a Portuguese comma is a decimal point', lib.toWei('1,5') === 15n * E / 10n);
  check('  and 18 decimals round-trip exactly', lib.toWei(lib.fromWei(123456789012345678901n, 18)) === 123456789012345678901n);
  check('  and junk is refused, not guessed', lib.toWei('1.2.3') === null && lib.toWei('abc') === null && lib.toWei('0') === null);
}

/* ------------------------------------------- anyone can use it: the flow */

check('⭐ one primary button walks the person through every step',
  ['connect', 'switchNet', 'enterAmount', 'approve', 'swap'].every((k) => page.includes(`t('${k}'`)),
  'connect → switch network → enter an amount → approve → swap');
check('⛔ switching adds the network THEN switches to it',
  /wallet_addEthereumChain[\s\S]{0,200}wallet_switchEthereumChain/.test(page)
  && /chainName: 'Molibra'/.test(page)
  && /nativeCurrency: \{ name: 'MOLI', symbol: 'MOLI', decimals: 18 \}/.test(page)
  && /rpcUrls: \[NODE \+ '\/molibra'\]/.test(page));
check('  and hands the wallet the EIP-3091 explorer, as connect.html does',
  /blockExplorerUrls: \[EXPLORER\]/.test(page) && page.includes("NODE + '/molibra/moliscan'"));
check('a finished transaction links to the explorer',
  page.includes("EXPLORER + '/tx/' + hash"));
check('⛔ MAX on MOLI leaves gas behind',
  /GAS_RESERVE = UNIT \/ 100n/.test(page) && /b > GAS_RESERVE \? b - GAS_RESERVE/.test(page));
check('the slippage default is 0.5%', /let slipStr = '0\.5'/.test(page));
check('  and is parsed without floating point', page.includes('function slippageBp'));

/* ------------------------------------------------------------ language */

const tBlock = page.match(/const T = \{[\s\S]*?\n\};/);
check('the page carries a PT and an EN dictionary', Boolean(tBlock));
if (tBlock) {
  const T = new Function(`${tBlock[0]}\nreturn T;`)();
  const pk = Object.keys(T.pt).sort(), ek = Object.keys(T.en).sort();
  const missing = pk.filter((k) => !ek.includes(k)).concat(ek.filter((k) => !pk.includes(k)));
  check('  with the same keys in both', missing.length === 0, missing.join(', '));
  const used = [...new Set([...page.matchAll(/data-i18n="([A-Za-z]+)"|\bt\('([A-Za-z]+)'/g)].map((m) => m[1] || m[2]))];
  const undef = used.filter((k) => !(k in T.en));
  check('  and every key the page uses is defined', undef.length === 0, undef.join(', '));
  check('  in plain words', T.pt.swap === 'Trocar' && T.pt.pay === 'Você paga'
    && T.pt.receive === 'Você recebe' && T.pt.connect === 'Conectar carteira');
}
check('⭐ it opens in Portuguese when the browser is Portuguese',
  /\/\^pt\/i\.test\(navigator\.language/.test(page)
  && page.indexOf("document.documentElement.lang = l === 'pt'") < page.indexOf('/molibra/mobilewallet.js'),
  'set before mobilewallet.js loads, which reads it once');

/* ------------------------------------------------------- other ways */

check('other ways: bMOLI on Uniswap',
  page.includes('https://app.uniswap.org/swap?chain=mainnet&amp;inputCurrency=ETH&amp;outputCurrency=0xa302877efb74f567f3605851194b46f1d5746822'));
for (const p of ['/molibra/bridgedmoli', '/molibra/return', '/molibra/connect']) {
  check(`  links to ${p}, which rpc.js serves`,
    page.includes(`href="${p}"`) && readFileSync(join(ROOT, 'src/rpc.js'), 'utf8').includes(`path === '${p}'`));
}
check('the factory and add-token tools live in a collapsed Advanced section',
  /<details class="card" id="advanced">[\s\S]*id="deployFactory"[\s\S]*id="createPool"[\s\S]*<\/details>/.test(page)
  && /<details class="card" id="advanced">[\s\S]*id="addToken"[\s\S]*<\/details>/.test(page)
  && !/<details[^>]*\bopen\b/.test(page));
check('⛔ no script from anywhere but this node',
  [...page.matchAll(/<script[^>]+src="([^"]+)"/g)].every((m) => m[1].startsWith('/molibra/')));

/* ------------------------------------------------------------- routing */

const rpc = readFileSync(join(ROOT, 'src/rpc.js'), 'utf8');
check('the page is served by a route', rpc.includes("'web', 'swap.html'"),
  'an unrouted page is a file nobody can open');

/* ------------------------------------------ it holds nothing, by design */

// ⛔ The page carries the factory DEPLOY BYTECODE, which is a long hex string
// and must not be mistaken for key material. Strip it, then insist that nothing
// key-shaped remains.
const withoutBytecode = page.replace(/const FACTORY_BYTECODE = '0x[0-9a-fA-F]*'/, '');
check('⛔ the page contains no private key material',
  !/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(withoutBytecode.replace(/0x4f02/g, '')),
  'a public trading page must never carry a key');
check('  and the factory bytecode came from the artifact, not a paste',
  !page.includes('__FACTORY_BYTECODE__') && page.includes('FACTORY_BYTECODE'),
  'a hand-pasted 4.6KB of bytecode would drift from the contract silently');
check('  and never asks for one',
  !/private ?key|mnemonic|seed phrase/i.test(page));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
