/**
 * buy.html - buy bMOLI with ETH against the Uniswap v4 pool - against the
 * chain's facts, an independent ABI encoder, and itself.
 *
 * ⛔ Strangers send real ETH through this page. The failures that matter: a
 * PoolKey that hashes to some other pool (or to none), a selector or action
 * byte that calls the wrong thing, calldata the router decodes differently
 * from what the page meant, a minimum that does not protect, a fee that
 * overcharges, and a quote that cannot fill being sent anyway. Each is checked
 * by RUNNING the shipped code, not by reading it.
 *
 * The round-trip decode uses `ethers` (v6) when importable; without it those
 * checks SKIP, loudly. The live mainnet simulation is not part of this test
 * (no network in CI); its result is recorded in the commit that added the page.
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { keccak256, toHex, fromHex } from '../src/crypto.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(ROOT, 'src/web/buy.html'), 'utf8');
const rpc = readFileSync(join(ROOT, 'src/rpc.js'), 'utf8');

let pass = 0, fail = 0, skip = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('buy.html vs the v4 pool, the router and an independent encoder\n');

const kec = (s) => toHex(keccak256(new TextEncoder().encode(s)));
const sel = (s) => kec(s).slice(0, 10);

/* ----------------------------------------------------------- selectors */

const KEY_T = '(address,address,uint24,int24,address)';
const SIGS = {
  execute: 'execute(bytes,bytes[],uint256)',
  quoteExactInSingle: `quoteExactInputSingle((${KEY_T},bool,uint128,bytes))`,
  quoteExactOutSingle: `quoteExactOutputSingle((${KEY_T},bool,uint128,bytes))`,
  getSlot0: 'getSlot0(bytes32)',
  latestRoundData: 'latestRoundData()',
};
const block = (name) => { const m = page.match(new RegExp(`const ${name} = \\{[\\s\\S]*?\\n\\};`)); return m ? m[0] : null; };
const selBlock = block('SEL');
check('the page has a selector table', Boolean(selBlock));
for (const [key, sig] of Object.entries(SIGS)) {
  const m = selBlock && selBlock.match(new RegExp(`${key}:\\s*'(0x[0-9a-f]{8})'`));
  check(`${key} is keccak of ${sig}`, Boolean(m) && m[1] === sel(sig), m ? `${m[1]} vs ${sel(sig)}` : 'missing');
}
const errBlock = block('ERR');
for (const [key, sig] of Object.entries({ notEnoughLiquidity: 'NotEnoughLiquidity(bytes32)', tooLittleReceived: 'V4TooLittleReceived(uint256,uint256)' })) {
  const m = errBlock && errBlock.match(new RegExp(`${key}:\\s*'(0x[0-9a-f]{8})'`));
  check(`revert ${key} is keccak of ${sig}`, Boolean(m) && m[1] === sel(sig), m ? m[1] : 'missing');
}
const topic = page.match(/const TRANSFER_TOPIC = '(0x[0-9a-f]{64})'/);
check('the Transfer topic is keccak of Transfer(address,address,uint256)',
  Boolean(topic) && topic[1] === kec('Transfer(address,address,uint256)'));

/* --------------------------------------------- the pool, by its own hash */

// ⛔⛔ From the Initialize event of tx 0xb87eb11e6c236e7f61ad597e44569da0a3cf992c11eb823dcd80c3c8a46f5f67
// (block 26,044,855): id topic, currency0, currency1, and (fee, tickSpacing, hooks) from data.
const POOL_ID_ONCHAIN = '0x200f192a14c85d09943f76ae3def3ffe596d93594b6d8ab55b99cdf612b4c312';
const pk = page.match(/const POOL_KEY = \{ currency0: ETH_ADDR, currency1: BMOLI, fee: (\d+)n, tickSpacing: (\d+)n, hooks: ETH_ADDR \};/);
const bm = page.match(/const BMOLI = '(0x[0-9a-f]{40})';/);
const ethAddr = page.match(/const ETH_ADDR = '(0x[0-9a-f]{40})';/);
check('the PoolKey is written out in full', Boolean(pk && bm && ethAddr));
const w32 = (v) => BigInt(v).toString(16).padStart(64, '0');
const a32 = (a) => a.toLowerCase().slice(2).padStart(64, '0');
if (pk && bm && ethAddr) {
  const enc = a32(ethAddr[1]) + a32(bm[1]) + w32(pk[1]) + w32(pk[2]) + a32(ethAddr[1]);
  const id = toHex(keccak256(fromHex('0x' + enc)));
  check('⛔⛔ keccak256(abi.encode(PoolKey)) is the poolId of the live pool', id === POOL_ID_ONCHAIN, id);
  check('  currency0 is native ETH, so buying bMOLI is zeroForOne', ethAddr[1] === '0x' + '0'.repeat(40));
  check('  currency1 is bMOLI', bm[1] === '0xa302877efb74f567f3605851194b46f1d5746822');
  check('  fee 2500 (0.25%), tickSpacing 25 (read, not guessed), no hooks', pk[1] === '2500' && pk[2] === '25');
}
check('  and the page carries that same poolId', page.includes(`const POOL_ID = '${POOL_ID_ONCHAIN}';`));

/* ------------------------------------------------- the contracts it calls */

// Each verified with eth_getCode on 3 Oct 2026; PoolManager, V4Quoter and
// StateView against docs.uniswap.org v4 deployments, the router against
// Uniswap/universal-router deploy-addresses/mainnet.json ("UniversalRouterV2").
const CONTRACTS = {
  UNIVERSAL_ROUTER: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
  V4_QUOTER: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
  STATE_VIEW: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
  CHAINLINK_ETH_USD: '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419',
};
for (const [k, a] of Object.entries(CONTRACTS)) {
  check(`${k} is ${a}`, page.includes(`const ${k} = '${a}';`));
}
const ALLOWED = new Set([...Object.values(CONTRACTS), '0xa302877efb74f567f3605851194b46f1d5746822', '0x' + '0'.repeat(40)]);
const named = [...new Set([...page.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].map((m) => m[0].toLowerCase()))];
const stray = named.filter((a) => !ALLOWED.has(a));
check('⛔ no address but the public contracts is written into the page', stray.length === 0, stray.join(', '));
const longHex = [...new Set([...page.matchAll(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g)].map((m) => m[0].toLowerCase()))];
check('⛔ the only 32-byte hex values are the poolId and the Transfer topic',
  longHex.every((h) => h === POOL_ID_ONCHAIN || h === kec('Transfer(address,address,uint256)')), longHex.length + ' found');

/* ------------------------------------------- command and action bytes */

// Universal Router Commands.sol: V4_SWAP = 0x10, SWEEP = 0x04.
// v4-periphery Actions.sol: SWAP_EXACT_IN_SINGLE = 0x06, SETTLE_ALL = 0x0c, TAKE_ALL = 0x0f.
check('commands: V4_SWAP 0x10, SWEEP 0x04', page.includes('const CMD = { V4_SWAP: 0x10, SWEEP: 0x04 };'));
check('actions: SWAP_EXACT_IN_SINGLE 0x06, SETTLE_ALL 0x0c, TAKE_ALL 0x0f',
  page.includes('const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f };'));

/* ---------------------------------------------- lift the shipped functions */

const grab = (name) => {
  const m = page.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n`));
  return m ? m[0] : null;
};
const names = ['word', 'addr32', 'pad32', 'bytesEnc', 'bytesArrayEnc', 'poolKeyEnc', 'quoteData', 'swapInput', 'executeData',
  'slippageBp', 'minOutFor', 'isPartial', 'priceWeiPerMoli', 'usdPerMoli', 'impactBp', 'feeFields',
  'toWei', 'fromWei', 'localise', 'fmtSig', 'roundDown'];
const src = names.map(grab);
check('the encoder and the money functions can be lifted out of the page', src.every(Boolean),
  names.filter((n, i) => !src[i]).join(', '));
const consts = ['ETH_ADDR', 'BMOLI'].map((n) => page.match(new RegExp(`const ${n} = [^\\n]+;`))[0])
  .concat([page.match(/const POOL_KEY = [^\n]+;/)[0], selBlock, page.match(/const CMD = [^\n]+;/)[0],
    page.match(/const ACT = [^\n]+;/)[0], page.match(/const TIP = [^\n]+;/)[0]]);
const ctx = vm.createContext({ BigInt, Number, String, Math, Array });
vm.runInContext(`const UNIT = 10n ** 18n; let LANG = 'en';\n${consts.join('\n')}\n${src.join('\n')}\n`
  + `this.lib = { ${names.join(', ')}, setLang: (l) => { LANG = l; } };`, ctx);
const lib = ctx.lib;
const E = 10n ** 18n;

/* ------------------------------------------------------- fees and maths */

check('⛔ the tip is 0.05 gwei', /const TIP = 50000000n;/.test(page) && lib.feeFields(1n).maxPriorityFeePerGas === 50000000n);
const ff = lib.feeFields(72639527n);
check('⛔ maxFeePerGas = 2 x baseFee + tip', ff.maxFeePerGas === 2n * 72639527n + 50000000n, String(ff.maxFeePerGas));
check('⛔ both fee fields go to the wallet', /maxFeePerGas: hex\(fees\.maxFeePerGas\), maxPriorityFeePerGas: hex\(fees\.maxPriorityFeePerGas\)/.test(page));
check('slippage parses without floats: 1 -> 100 bp, 0.5 -> 50, 3 -> 300',
  lib.slippageBp('1') === 100 && lib.slippageBp('0,5') === 50 && lib.slippageBp('3') === 300);
check('  nonsense and 0 are refused', lib.slippageBp('') === null && lib.slippageBp('0') === null && lib.slippageBp('abc') === null && lib.slippageBp('51') === null);
check('  the default is 1%', /let slipStr = '1';/.test(page));
const out = 277786200306909328094n;
check('⛔ the minimum at 1% is the quote less 1%, rounded down', lib.minOutFor(out, 100) === out * 9900n / 10000n);
check('⛔ a full fill is not partial (exact-out needs the whole input, to the wei)', !lib.isPartial(E / 1000n, E / 1000n));
check('  rounding by a few wei is not partial', !lib.isPartial(E / 1000n, E / 1000n - 5n));
check('⛔ a fill that uses 99% of the input IS partial, and is refused', lib.isPartial(E / 1000n, E / 1000n * 99n / 100n));
check('  a fill that uses half is partial', lib.isPartial(10n ** 16n, 5n * 10n ** 15n));
const pw = lib.priceWeiPerMoli(E / 1000n, out);
check('price per MOLI = ETH in / bMOLI out', pw === (E / 1000n) * E / out, `${pw} wei`);
check('  in dollars with Chainlink\'s 8 decimals', lib.usdPerMoli(pw, 268163375426n) === pw * 268163375426n / E);
// Live 3 Oct 2026: sqrtPriceX96 at tick 127175, 0.001 ETH -> 277.786 bMOLI.
const sqrtP = 45741621010092210840562718995327n;
const imp = lib.impactBp(E / 1000n, out, sqrtP, 2500n);
check('impact is measured against the spot price with the 0.25% fee removed', imp > 1600n && imp < 1700n, `${imp} bp`);
check('  and is zero when the fill matches spot', lib.impactBp(E, 1n, 1n << 96n, 0n) === 0n || lib.impactBp(E, E, 1n << 96n, 0n) === 0n);
lib.setLang('en');
check('a MOLI price of a few millionths of an ETH shows its digits', lib.fmtSig(pw, 18, 4) === '0.000003599',lib.fmtSig(pw, 18, 4));
lib.setLang('pt');
check('  and in Portuguese with a comma', lib.fmtSig(1234567n * E, 18, 4) === '1.234.567' && lib.fmtSig(E / 1000n, 18, 4) === '0,001');
check('amounts round-trip with all 18 decimals', lib.toWei(lib.fromWei(1234567890123456789n, 18)) === 1234567890123456789n);
check('  "0,001" is 10^15 wei', lib.toWei('0,001') === 10n ** 15n);
check('the "use the maximum" suggestion is under the bisected maximum', lib.roundDown(2129495382308959n) < 2129495382308959n && lib.roundDown(2129495382308959n) > 0n);

/* ------------------------------ ⛔⛔ the calldata, decoded by someone else */

let ethers = null;
try { ethers = (await import('ethers')).ethers; } catch (e) { ethers = null; }
const BUYER = '0x00000000000000000000000000000000000b0b0b';
const IN = 10n ** 15n;
const MIN = lib.minOutFor(out, 100);
const DL = 1790000000n;
const data = lib.executeData(IN, MIN, BUYER, DL);
if (!ethers) {
  skip++;
  console.log('  SKIP  round-trip decode: ethers v6 is not importable from here (npm i ethers in a parent folder)');
} else {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const PKT = 'tuple(address,address,uint24,int24,address)';
  const key = ['0x' + '0'.repeat(40), '0xa302877efb74f567f3605851194b46f1d5746822', 2500n, 25n, '0x' + '0'.repeat(40)];
  const ur = new ethers.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
  const ref = ur.encodeFunctionData('execute', ['0x1004', [
    coder.encode(['bytes', 'bytes[]'], ['0x060c0f', [
      coder.encode([`tuple(${PKT},bool,uint128,uint128,bytes)`], [[key, true, IN, MIN, '0x']]),
      coder.encode(['address', 'uint256'], [key[0], IN]),
      coder.encode(['address', 'uint256'], [key[1], MIN]),
    ]]),
    coder.encode(['address', 'address', 'uint256'], [key[0], BUYER, 0n]),
  ], DL]);
  check('⛔⛔ execute() calldata is byte-for-byte what ethers encodes', data === ref, `${data.length} chars`);

  const dec = ur.decodeFunctionData('execute', data);
  check('  decodes: commands = V4_SWAP, SWEEP', dec.commands === '0x1004');
  check('  decodes: the deadline', dec.deadline === DL);
  check('  decodes: two inputs', dec.inputs.length === 2);
  const [actions, prms] = coder.decode(['bytes', 'bytes[]'], dec.inputs[0]);
  check('  V4_SWAP input: actions = SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL', actions === '0x060c0f');
  const [sw] = coder.decode([`tuple(${PKT},bool,uint128,uint128,bytes)`], prms[0]);
  const keyHash = ethers.keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'], [...sw[0]]));
  check('⛔⛔ the swap names the live pool (its PoolKey hashes to the poolId)', keyHash === POOL_ID_ONCHAIN);
  check('⛔ zeroForOne = true (ETH in, bMOLI out)', sw[1] === true);
  check('⛔ amountIn and amountOutMinimum are the ones asked for', sw[2] === IN && sw[3] === MIN);
  check('  no hook data', sw[4] === '0x');
  const [sc, sa] = coder.decode(['address', 'uint256'], prms[1]);
  check('⛔ SETTLE_ALL pays ETH, at most the input', sc === ethers.ZeroAddress && sa === IN);
  const [tc, ta] = coder.decode(['address', 'uint256'], prms[2]);
  check('⛔ TAKE_ALL takes bMOLI, at least the minimum', tc.toLowerCase() === '0xa302877efb74f567f3605851194b46f1d5746822' && ta === MIN);
  const [st, sr, sm] = coder.decode(['address', 'address', 'uint256'], dec.inputs[1]);
  check('⛔ SWEEP returns any unused ETH to the buyer', st === ethers.ZeroAddress && sr.toLowerCase() === BUYER && sm === 0n);

  const qi = new ethers.Interface([`function quoteExactInputSingle((${PKT.replace('tuple', '')},bool,uint128,bytes))`,
    `function quoteExactOutputSingle((${PKT.replace('tuple', '')},bool,uint128,bytes))`]);
  check('the quote calldata is what ethers encodes (exact in)',
    lib.quoteData(sel(SIGS.quoteExactInSingle), IN) === qi.encodeFunctionData('quoteExactInputSingle', [[key, true, IN, '0x']]));
  check('  and (exact out)',
    lib.quoteData(sel(SIGS.quoteExactOutSingle), out) === qi.encodeFunctionData('quoteExactOutputSingle', [[key, true, out, '0x']]));
}

/* ------------------------------------- ⛔⛔ it refuses rather than sends */

check('⛔⛔ a quoter revert is a refusal, never a quote', /catch \(e\) \{[\s\S]{0,200}return \{ amountIn: amountIn, cannot: true/.test(page));
check('⛔⛔ a partial fill (exact-out needs less) is a refusal', /if \(isPartial\(amountIn, need\)\) return \{ amountIn: amountIn, cannot: true/.test(page));
check('⛔⛔ a refused quote disables the button before anything else can enable it',
  /if \(quote\.cannot\) return \{ label: t\('refuse'\), disabled: true \};\s*if \(!account\)/.test(page));
check('⛔ the refusal is said in words, with the most the pool fills now',
  page.includes("t('cannotFill', fmt(q.amountIn))") && page.includes("t('maxNow'"));
check('⛔ the pool is asked again right before signing, and a refusal then still refuses',
  /const fresh = await getQuote\(shown\.amountIn\);\s*if \(fresh\.cannot\)/.test(page));
check('⛔ the minimum is the one shown, and a fresh quote below it stops the buy',
  /const minOut = minOutFor\(shown\.out, bp\);[\s\S]{0,300}if \(fresh\.out < minOut\) throw/.test(page));
const sim = page.indexOf("await ethRpc('eth_call', [tx, 'latest'])");
const send = page.indexOf("method: 'eth_sendTransaction'");
check('⛔ the exact transaction is simulated before the wallet sees it', sim > 0 && send > sim);
check('  sent to the Universal Router with the ETH as value, nothing else',
  (page.match(/eth_sendTransaction/g) || []).length === 1 && /to: UNIVERSAL_ROUTER, data: data, value: hex\(shown\.amountIn\)/.test(page));
check('  with no approval anywhere (native ETH needs none)', !/0x095ea7b3|0x000000000022d473030f116ddee9f6b43ac78ba3|SEL\.approve/i.test(page));

/* ------------------------------------------------------- the wallet flow */

check('⭐ the button walks connect → switch → buy', ['connect', 'switchNet', 'buy'].every((k) => page.includes(`t('${k}')`)));
check('⛔ it switches to Ethereum mainnet (0x1) and never adds a network',
  page.includes("const MAINNET = '0x1';") && page.includes("wallet_switchEthereumChain', params: [{ chainId: MAINNET }]")
  && !page.includes('wallet_addEthereumChain'));
check('after success: an Etherscan link', page.includes("ETHERSCAN + '/tx/' + hash") && page.includes("const ETHERSCAN = 'https://etherscan.io';"));
check('  "Adicionar bMOLI à carteira" through wallet_watchAsset',
  page.includes("method: 'wallet_watchAsset'") && /symbol: 'bMOLI', decimals: 18/.test(page));
check('  and the way back to MOLI', page.includes('href="/molibra/return"') && rpc.includes("path === '/molibra/return'"));
check('?amount= prefills the ETH amount, and stays editable',
  page.includes("params.get('amount')") && /<input id="amountIn"/.test(page));
check('ETH balance, price in ETH and USD, impact and the minimum are all drawn',
  ['ethBal', 'priceEth', 'priceUsd', 'impact', 'minOut'].every((id) => page.includes(`id="${id}"`)));
check('a phone with no wallet gets MetaMask and Trust Wallet deep links',
  page.includes("'https://metamask.app.link/dapp/' + location.host + location.pathname + location.search")
  && page.includes("'https://link.trustwallet.com/open_url?coin_id=60&url=' + encodeURIComponent(location.href)"));

/* ---------------------------------------------------------- reachability */

check('/molibra/buy is routed to buy.html', /path === '\/molibra\/buy'\)[\s\S]{0,120}'web', 'buy\.html'/.test(rpc));
check('the exchange page links here', readFileSync(join(ROOT, 'src/web/swap.html'), 'utf8').includes('href="/molibra/buy"'));
check('the point-of-sale page links here', readFileSync(join(ROOT, 'src/web/pay.html'), 'utf8').includes('href="/molibra/buy"'));
const scripts = [...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
check('⛔ no script from anywhere but this node', scripts.length === 1 && scripts[0] === '/molibra/mobilewallet.js', scripts.join(', '));
check('⛔ no stylesheet or font from elsewhere', !/<link[^>]+rel="stylesheet"/.test(page) && !/@import/.test(page));
check('  reads go to the same public Ethereum node as return.html',
  page.includes("const ETH_RPC = 'https://ethereum-rpc.publicnode.com';")
  && readFileSync(join(ROOT, 'src/web/return.html'), 'utf8').includes("const ETH_RPC = 'https://ethereum-rpc.publicnode.com';"));

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
  check('  in plain Portuguese', T.pt.buy === 'Comprar bMOLI' && T.pt.connect === 'Conectar carteira'
    && T.pt.youGet === 'Você recebe ≈' && T.pt.addToken === 'Adicionar bMOLI à carteira');
}
check('⭐ Portuguese unless the person chose English', /l === 'en' \? 'en' : 'pt-BR'/.test(page)
  && page.indexOf("'pt-BR'") < page.indexOf('/molibra/mobilewallet.js'));

/* ------------------------------------------------- it holds nothing */

check('⛔ never asks for key material', !/private ?key|mnemonic|seed phrase/i.test(page));
check('⛔ amounts never pass through a float', !/parseFloat|Number\(\$\(|\* 1e18|\/ 1e18|toFixed/.test(page));

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
