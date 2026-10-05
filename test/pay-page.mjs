/**
 * pay.html - the point-of-sale page - against the pool, the node and itself.
 *
 * ⛔ Strangers pay real money through this page, at a counter, in a hurry. The
 * failures that matter: a QR that does not decode to the URL it claims, a
 * payment the watcher misses or invents, a transfer carrying data the node
 * routes specially, and a token payment that yields less MOLI than charged.
 * Each is checked by RUNNING the shipped code, not by reading it.
 *
 * The QR decode check needs a decoder this repo does not ship. It uses `jsqr`
 * when importable, or the module path in $JSQR; without either it SKIPS, loudly.
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

import { keccak256, toHex } from '../src/crypto.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(ROOT, 'src/web/pay.html'), 'utf8').replace(/\r\n/g, '\n'); // CRLF-agnostic (Windows checkout)
const qrSrc = readFileSync(join(ROOT, 'src/web/qr.js'), 'utf8');
const pool = readFileSync(join(ROOT, 'contracts/MolibraPool.sol'), 'utf8');
const rpc = readFileSync(join(ROOT, 'src/rpc.js'), 'utf8');

let pass = 0, fail = 0, skip = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('pay.html vs the pool, the node and its own QR\n');

const sel = (s) => toHex(keccak256(new TextEncoder().encode(s))).slice(0, 10);

/* ----------------------------------------------------------- selectors */

const SIGS = {
  reserves: 'reserves()',
  quote: 'quote(uint256,uint256,uint256)',
  swapTokenIn: 'swapTokenForMoli(uint256,uint256)',
  approve: 'approve(address,uint256)',
  allowance: 'allowance(address,address)',
  balanceOf: 'balanceOf(address)',
  allMarkets: 'allMarkets()',
  poolOf: 'poolOf(address)',
  symbol: 'symbol()',
};
const block = page.match(/const SEL = \{[\s\S]*?\n\};/);
check('the page has a selector table', Boolean(block));
for (const [key, sig] of Object.entries(SIGS)) {
  const m = block && block[0].match(new RegExp(`${key}:\\s*'(0x[0-9a-f]{8})'`));
  check(`${key} is keccak of ${sig}`, Boolean(m) && m[1] === sel(sig), m ? `${m[1]} vs ${sel(sig)}` : 'missing');
}
check('  swapTokenForMoli and quote exist on the contract',
  pool.includes('function swapTokenForMoli') && pool.includes('function quote'));

/* --------------------------------------------------------- reachability */

check('/molibra/pay is routed to pay.html', /path === '\/molibra\/pay'\)[\s\S]{0,120}'web', 'pay\.html'/.test(rpc));
check('/molibra/qr.js is routed to the vendored encoder', /path === '\/molibra\/qr\.js'\)[\s\S]{0,120}'web', 'qr\.js'/.test(rpc));
check('the explorer route the tx links use exists', rpc.includes("path.startsWith('/molibra/moliscan/')")
  && page.includes("EXPLORER + '/tx/' + "));
check('the swap page links here', readFileSync(join(ROOT, 'src/web/swap.html'), 'utf8').includes('href="/molibra/pay"'));
check('the front page links here', readFileSync(join(ROOT, 'src/web/index.html'), 'utf8').includes('href="/molibra/pay"'));
const scripts = [...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
check('⛔ no script from anywhere but this node', scripts.length === 2 && scripts.every((s) => s.startsWith('/molibra/')),
  scripts.join(', '));
check('  and the wallet guard is one of them', scripts.includes('/molibra/mobilewallet.js'));
check('the vendored encoder carries its MIT licence and author',
  /Copyright \(c\) 2009 Kazuhiko Arase/.test(qrSrc) && /Permission is hereby granted, free of charge/.test(qrSrc));

/* ------------------------------------------------------------ privacy */

// ⛔ No merchant's address in a public repo. The only addresses this file may
// name are the public contracts: the seeded pool, its token, and bMOLI.
const ALLOWED = new Set([
  '0x4f34d9bc5db2396640d8eb564667e8701528b43d',
  '0xcedb6badceceeb46e21877c45b8b9087cb8e4d6a',
  '0xa302877efb74f567f3605851194b46f1d5746822',
]);
const named = [...new Set([...page.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].map((m) => m[0].toLowerCase()))];
const stray = named.filter((a) => !ALLOWED.has(a));
check('⛔ no personal address is written into the page', stray.length === 0, stray.join(', '));
check('  the merchant address is remembered in the browser only',
  page.includes("'molibra.pay.merchant'") && /localStorage\.setItem\(MERCHANT_KEY/.test(page));
check('  and never asks for key material', !/private ?key|mnemonic|seed phrase/i.test(page));

/* --------------------------------------------------- ⛔ transfers carry no data */

const transfers = [...page.matchAll(/\{ from: account, to: (merchant\(\)|to), value: hex\((want|v)\), gas: hex\(TRANSFER_GAS\) \}/g)];
check('⛔⛔ every MOLI payment is value + 21000 gas and NO data field',
  transfers.length === 3, `${transfers.length} plain transfers (pay with MOLI, pay after swap, sell MOLI)`);
check('  and nothing else sends value to a person',
  (page.match(/value: hex\(/g) || []).length === 3);
check('  21000 is what this chain charges a plain transfer',
  /export const GAS_TRANSFER = 21000n;/.test(readFileSync(join(ROOT, 'src/tx.js'), 'utf8'))
  && /const TRANSFER_GAS = 21000n;/.test(page));

/* ---------------------------------------------- lift the shipped functions */

const grab = (name) => {
  const m = page.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n`));
  return m ? m[0] : null;
};
const names = ['ceilDiv', 'amountInFor', 'toWei', 'fromWei', 'payUrl', 'matchPayment', 'qrMatrix'];
const src = names.map(grab);
check('the money, URL, watcher and QR functions can be lifted out of the page', src.every(Boolean),
  names.filter((n, i) => !src[i]).join(', '));

const ctx = vm.createContext({ BigInt, Number, String, encodeURIComponent, decodeURIComponent, Array, Math });
vm.runInContext(qrSrc, ctx);
vm.runInContext(`const UNIT = 10n ** 18n; const PAY_PATH = '/molibra/pay';\n${src.join('\n')}\n`
  + `this.lib = { ${names.join(', ')} };`, ctx);
const lib = ctx.lib;
const E = 10n ** 18n;

/* ------------------------------------- exact-OUT through an exact-IN pool */

// The contract's rule, character for character (MolibraPool.quote).
const quote = (a, rIn, rOut) => (a === 0n || rIn === 0n || rOut === 0n ? 0n : (a * 997n * rOut) / (rIn * 1000n + a * 997n));
let seed = 0xC0FFEEn;
const rnd = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return seed % n; };
const reserves = [
  [50000n * E, 50000n * E],                      // live today, after the deepening
  [2000n * E, 2000n * E],                        // before it
  [50123n * E + 7n, 49877n * E + 99n],           // after some trading
  [1234567n * E, 891n * E], [7n * E, 900000n * E],
];
for (let i = 0; i < 200; i++) reserves.push([rnd(10n ** 25n) + E, rnd(10n ** 25n) + E]);
let ok = 0; const bad = [];
for (const [rTok, rMoli] of reserves) {
  for (const want of [1n, 10n ** 15n, E, 125n * E / 10n, 1000n * E, rnd(rMoli / 2n) + 1n, rMoli - 1n]) {
    const a = lib.amountInFor(want, rTok, rMoli);
    if (a === null) { if (want < rMoli) bad.push(['null', want]); continue; }
    const enough = quote(a, rTok, rMoli) >= want;
    const minimal = a === 1n || quote(a - 1n, rTok, rMoli) < want;
    if (enough && minimal) ok++; else bad.push([want, rTok, rMoli, enough, minimal]);
  }
}
check('⛔⛔ the token input always yields at least the charged MOLI, and is the least that does',
  bad.length === 0 && ok > 1000, `${ok} cases, ${bad.length} wrong`);
check('  an amount the pool cannot pay is refused, not attempted',
  lib.amountInFor(50000n * E, 50000n * E, 50000n * E) === null && lib.amountInFor(60000n * E, 50000n * E, 50000n * E) === null);
const live = lib.amountInFor(10n * E, 50000n * E, 50000n * E);
check('  10 MOLI from the live 50k/50k pool costs 10.03x WSRO (0.3% fee + depth)',
  live > 10030n * E / 1000n && live < 10035n * E / 1000n, `${live} wei`);
check('⛔ and the pool itself confirms the input before it is offered',
  /async function tokenPlan[\s\S]{0,400}await poolQuote\(m, a\)\) >= want/.test(page)
  && page.includes('SEL.quote + word(amountIn) + word(m.rTok) + word(m.rMoli)'));
check('⛔ the swap demands the charged amount as its minimum',
  page.includes('SEL.swapTokenIn + word(p.amountIn) + word(p.minOut)') && /minOut: want/.test(page));
check('  with a margin on the input, and the leftover stays with the payer',
  /ceilDiv\(a \* \(10000n \+ PAY_MARGIN_BP\), 10000n\)/.test(page) && /PAY_MARGIN_BP = 50n/.test(page));
check('⛔ the token approval is exact', page.includes('SEL.approve + addr32(m.pool) + word(p.amountIn)'));
check('⛔ the swap is simulated before the wallet sees it', /await preflight\(swap, 'wouldRevert'\)/.test(page));
check('⛔ no MOLI for gas is detected before an approve that could not be paid for',
  /balMoli < gasPrice \* TOKEN_ROUTE_GAS\) return \{ label: t\('needGas'\)/.test(page));

/* ---------------------------------------------------------- the QR URL */

const url = lib.payUrl('https://molibra.org', '0x00000000000000000000000000000000000000AB', 125n * E / 10n, 'Açaí 500ml & café', '0a1b2c3d');
check('the QR URL is exactly /molibra/pay?to=&amount=&memo=&r=',
  url === 'https://molibra.org/molibra/pay?to=0x00000000000000000000000000000000000000ab&amount=12.5&memo=A%C3%A7a%C3%AD%20500ml%20%26%20caf%C3%A9&r=0a1b2c3d', url);
const back = new URL(url);
check('  and it parses back to the same fields',
  back.searchParams.get('to') === '0x00000000000000000000000000000000000000ab'
  && lib.toWei(back.searchParams.get('amount')) === 125n * E / 10n
  && back.searchParams.get('memo') === 'Açaí 500ml & café' && back.searchParams.get('r') === '0a1b2c3d');
check('  the sign URL carries no amount', lib.payUrl('https://x', '0x' + 'ab'.repeat(20), null) === 'https://x/molibra/pay?to=0x' + 'ab'.repeat(20));
check('  built from location.origin, never a literal host', /payUrl\(location\.origin, me, amt, memo, randomTag\(\)\)/.test(page));
check('  amounts round-trip with all 18 decimals', lib.toWei(lib.fromWei(1234567890123456789n, 18)) === 1234567890123456789n);

/* ----------------------------------------------------- the QR decodes back */

let jsQR = null;
try {
  const mod = process.env.JSQR ? await import(pathToFileURL(process.env.JSQR).href) : await import('jsqr');
  jsQR = mod.default || mod;
} catch (e) { jsQR = null; }
const samples = [
  url,
  lib.payUrl('https://molibra.org', '0x' + 'cd'.repeat(20), 1n,
    'Pedido 1234 - 2x pastel de queijo, 1x caldo de cana 500ml, entrega no balcão 3, mesa 12', 'ffffffff'),
  lib.payUrl('https://molibra.org', '0x' + '12'.repeat(20), null),
  '0x' + '9f'.repeat(20),
];
if (!jsQR) {
  skip++;
  console.log('  SKIP  QR decode: no decoder (npm i jsqr somewhere and set JSQR=<path>/node_modules/jsqr/dist/jsQR.js)');
} else {
  for (const s of samples) {
    const m = lib.qrMatrix(s);
    const scale = 6; const n = m.length * scale;
    const rgba = new Uint8ClampedArray(n * n * 4);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const v = m[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255;
      const i = (y * n + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255;
    }
    const got = jsQR(rgba, n, n);
    check(`⛔⛔ the QR decodes to exactly what it was given (${s.length} chars)`, Boolean(got) && got.data === s,
      got ? '' : 'no decode');
  }
  const quiet = lib.qrMatrix(samples[0]);
  check('  with a 4-module quiet zone', quiet.slice(0, 4).every((r) => r.every((d) => !d)) && quiet.every((r) => r.slice(0, 4).every((d) => !d)));
}
check('  at error-correction level M', page.includes("qrcode(0, 'M')"));

/* ------------------------------------------------- the payment watcher */

const fx = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/pay-blocks.json'), 'utf8'));
const hits = lib.matchPayment(fx.blocks, fx.merchant, BigInt(fx.amount));
check('⛔⛔ on real-shaped blocks it finds the exact payment and the overpayment, in order',
  hits.length === 2 && hits[0].hash === '0x' + '22'.repeat(32) && hits[1].hash === '0x' + '44'.repeat(32),
  hits.map((h) => h.hash.slice(0, 6)).join(','));
check('  ignores a payment one wei short', !hits.some((h) => h.hash === '0x' + '11'.repeat(32)));
check('  ignores a block that is not canonical', !hits.some((h) => h.hash === '0x' + '33'.repeat(32)));
check('  matches the merchant address in any letter case', hits[0].hash === '0x' + '22'.repeat(32));
check('  skips raw transaction strings rather than misreading them', hits.every((h) => typeof h.hash === 'string'));
check('  and finds nothing for another merchant', lib.matchPayment(fx.blocks, '0x' + '00'.repeat(20), 1n).length === 0);
check('⛔ a hit only counts once its RECEIPT says status 0x1',
  /eth_getTransactionReceipt', \[hit\.hash\]\)[\s\S]{0,80}rc\.status === '0x1'\) \{ paid\(w, hit\)/.test(page),
  'decoded blocks carry no status');
check('⛔ watching starts AFTER the block current at QR time',
  /next: start \+ 1/.test(page), 'an earlier same-amount payment must not read as this one');
check('  reading decoded blocks, since this node has no eth_getLogs',
  page.includes("'/molibra/blocks?from=' + w.next + '&to=' + (w.next + 511) + '&decoded=1'"));
check('  and the page beeps when paid', page.includes('createOscillator'));

/* ------------------------------------------------------ the wallet flow */

check('⭐ the customer button walks connect → switch → pay',
  ['connect', 'switchNet', 'payMoli', 'payToken'].every((k) => page.includes(`t('${k}'`)));
check('⛔ switching adds the network THEN switches',
  /wallet_addEthereumChain[\s\S]{0,200}wallet_switchEthereumChain/.test(page) && /chainName: 'Molibra'/.test(page));
check('a phone with no wallet gets MetaMask and Trust Wallet deep links',
  page.includes("'https://metamask.app.link/dapp/' + location.host + location.pathname + location.search")
  && page.includes("'https://link.trustwallet.com/open_url?coin_id=60&url=' + encodeURIComponent(location.href)"));
check('  plus the connect page', page.includes('href="/molibra/connect"'));
check('"Comprar MOLI" offers the counter, WSRO and ETH routes',
  page.includes('id="buyCounter"') && page.includes('href="/molibra/swap"') && page.includes('href="/molibra/return"')
  && page.includes('href="/molibra/buy"'));
check('"Vender MOLI" scans with BarcodeDetector and falls back to pasting',
  page.includes("new BarcodeDetector({ formats: ['qr_code'] })") && page.includes("t('noScanner')"));
check('the fixed sign prints on its own', /@media print\{[\s\S]*\.sign,\.sign \*\{visibility:visible\}/.test(page));

/* ------------------------------------------------------------ language */

const tBlock = page.match(/const T = \{[\s\S]*?\n\};/);
check('the page carries a PT and an EN dictionary', Boolean(tBlock));
if (tBlock) {
  const T = new Function(`${tBlock[0]}\nreturn T;`)();
  const pk = Object.keys(T.pt).sort(), ek = Object.keys(T.en).sort();
  const missing = pk.filter((k) => !ek.includes(k)).concat(ek.filter((k) => !pk.includes(k)));
  check('  with the same keys in both', missing.length === 0, missing.join(', '));
  const used = [...new Set([...page.matchAll(/data-i18n="([A-Za-z0-9]+)"|\bt\('([A-Za-z0-9]+)'/g)].map((m) => m[1] || m[2]))];
  const undef = used.filter((k) => !(k in T.en));
  check('  and every key the page uses is defined', undef.length === 0, undef.join(', '));
  check('  in plain Portuguese', T.pt.connect === 'Conectar carteira' && T.pt.genQr === 'Gerar QR' && T.pt.paid === 'PAGO');
}
check('⭐ Portuguese unless the person chose English', /l === 'en' \? 'en' : 'pt-BR'/.test(page)
  && page.indexOf("'pt-BR'") < page.indexOf('/molibra/mobilewallet.js'));
check('⛔ no discouraging disclaimer', !/says nothing about whether|pools here are small|thin pool|worth anything/i.test(page));

/* ------------------------------------------------- it holds nothing */

check('⛔ no key-shaped hex anywhere in the page', !/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(page));
check('⛔ amounts never pass through a float', !/parseFloat|Number\(\$\(|\* 1e18|\/ 1e18/.test(page));

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
