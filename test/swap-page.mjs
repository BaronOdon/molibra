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

for (const sig of ['swapMoliForToken', 'swapTokenForMoli', 'quote', 'reserves']) {
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
  page.includes('SEL.quote + word(amount)'),
  'one source of truth for the output, and it is the chain');
check('  and the page says so where a reader will find it',
  /never recomputed here|never does its own constant-product/i.test(page));

check('⛔ a minimum-received is sent with every swap',
  page.includes('SEL.swapMoliIn + word(minOut)')
  && page.includes('SEL.swapTokenIn + word(amount) + word(minOut)'),
  'a swap without minOut fills at any price, which is what a sandwich needs');

check('⛔⛔ it re-quotes immediately BEFORE signing',
  /await refresh\(\);[\s\S]{0,200}const out = lastQuote/.test(page),
  'a tolerance derived from a stale quote protects against the wrong price');

check('⛔ approval is for the exact amount, not unlimited',
  page.includes('SEL.approve + addr32(POOL) + word(amount)')
  && !/word\(2n \*\* 256n - 1n\)|ffffffffffffffff.*approve/i.test(page),
  'an infinite approval is convenient once and permanent afterwards');

check('price impact is computed and shown for every trade',
  page.includes('impactBp') && page.includes("$('impact')"));
check('  with a loud warning above 10%',
  /impactBp >= 10/.test(page));
check('  and the pool being thin is stated up front',
  /pool is small|scale-invariant|thin pool/i.test(page));

check('⛔ spot price is labelled as not an oracle',
  /not an oracle/i.test(page),
  'a contract trusting a reserve ratio as a feed is manipulable within one block');

// Amounts must never round-trip through a float.
check('⛔ amounts are parsed to wei without floating point',
  page.includes('function toWei') && /BigInt\(w \|\| '0'\) \* UNIT/.test(page),
  'Number cannot hold 18 decimals and would silently truncate somebody\'s balance');
check('  and formatted back without it',
  page.includes('function fromWei') && !/Number\(v\)\s*\/\s*1e18/.test(page));

/* ------------------------------------------------------------- routing */

const rpc = readFileSync(join(ROOT, 'src/rpc.js'), 'utf8');
check('the page is served by a route', rpc.includes("'web', 'swap.html'"),
  'an unrouted page is a file nobody can open');

/* ------------------------------------------ it holds nothing, by design */

check('⛔ the page contains no private key material',
  !/0x[0-9a-fA-F]{64}/.test(page.replace(/0x4f02/g, '')),
  'a public trading page must never carry a key');
check('  and never asks for one',
  !/private ?key|mnemonic|seed phrase/i.test(page));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
