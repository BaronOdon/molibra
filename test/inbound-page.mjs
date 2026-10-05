/**
 * The inbound leg takes an ASSET PARAMETER, WSRO by default.
 *
 *   - scripts-inbound/burn-asset.mjs: argv parsing, decimals/symbol read on
 *     chain (against a fake Ethereum), exact unit conversion.
 *   - src/web/inbound.html: its ASSET region run verbatim - token pick, exact
 *     burn calldata for any decimals, the registered asset found by origin,
 *     and where each native payload is addressed.
 *
 * ⛔ The default must mean exactly what the page meant before the parameter:
 * WSRO, payloads addressed to WSRO's Molibra contract.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { keccak256, toHex } from '../src/crypto.js';
import { encodeBridgeRegister } from '../src/bridgemint.js';
import {
  WSRO, parseArgs, resolveBurnAsset, formatUnits, parseUnits, decodeSymbol,
} from '../scripts-inbound/burn-asset.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(ROOT, 'src/web/inbound.html'), 'utf8');
const script = readFileSync(join(ROOT, 'scripts-inbound/prove-burn.mjs'), 'utf8');

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};
const refuses = async (l, fn) => { try { await fn(); check(l, false, 'accepted'); } catch (e) { check(l, true, e.message.slice(0, 70)); } };
const sel = (s) => toHex(keccak256(new TextEncoder().encode(s))).slice(0, 10);
/** abi.encode(string): offset, length, padded bytes. */
const abiString = (s) => {
  const h = Buffer.from(s).toString('hex');
  return '0x' + (32).toString(16).padStart(64, '0') + (h.length / 2).toString(16).padStart(64, '0')
    + h.padEnd(Math.ceil(h.length / 64) * 64, '0');
};

console.log('scripts-inbound/burn-asset.mjs\n');

{
  const a = parseArgs(['0xabc', '0xrecipient', '--token', '0xT', '--cap=5000']);
  check('positionals and --flag value / --flag=value', a.pos.join() === '0xabc,0xrecipient' && a.flags.token === '0xT' && a.flags.cap === '5000');
  const b = parseArgs(['0xabc']);
  check('no flags: the old invocation is unchanged', b.pos.length === 1 && !('token' in b.flags));
}

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const fakeEth = {
  [WSRO]: { decimals: 18, symbol: abiString('WSRO') },
  [USDC]: { decimals: 6, symbol: abiString('USDC') },
  // A legacy token that returns bytes32 for symbol() (MKR-style).
  '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2': { decimals: 18, symbol: '0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0') },
};
const call = async (to, data) => {
  const t = fakeEth[to];
  if (!t) return '0x';
  if (data === sel('decimals()')) return '0x' + t.decimals.toString(16).padStart(64, '0');
  if (data === sel('symbol()')) return t.symbol;
  throw new Error('unexpected call');
};
{
  const d = await resolveBurnAsset({ token: undefined, call });
  check('⛔ no --token means WSRO, as before', d.contract === WSRO && d.symbol === 'WSRO' && d.decimals === 18);
  const u = await resolveBurnAsset({ token: USDC.toUpperCase().replace('0X', '0x'), call });
  check('--token: decimals and symbol READ from the chain', u.contract === USDC && u.symbol === 'USDC' && u.decimals === 6);
  const m = await resolveBurnAsset({ token: '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', call });
  check('  a bytes32 symbol() decodes too', m.symbol === 'MKR');
  await refuses('⛔ an address with no decimals() is refused', () => resolveBurnAsset({ token: '0x' + '12'.repeat(20), call }));
  await refuses('⛔ a malformed --token is refused', () => resolveBurnAsset({ token: '0x1234', call }));
}
check('formatUnits is exact at 6 and 18 decimals',
  formatUnits(60530260000n, 6) === '60,530.26' && formatUnits(48000n * 10n ** 18n, 18) === '48,000' && formatUnits(1n, 18) === '0.000000000000000001');
check('parseUnits is exact', parseUnits('5000', 6) === 5_000_000_000n && parseUnits('0.1', 18) === 10n ** 17n);
await refuses('⛔ parseUnits refuses more places than the token has', () => parseUnits('1.0000001', 6));
check('decodeSymbol of an ABI string', decodeSymbol(abiString('FAZOL')) === 'FAZOL');
check('prove-burn.mjs takes the asset from burn-asset.mjs, not a constant',
  script.includes("from './burn-asset.mjs'") && script.includes('contract: TOKEN,') && !/const WSRO = /.test(script));

console.log('\nsrc/web/inbound.html\n');

const region = page.match(/\/\* ASSET-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* ASSET-END \*\//);
check('the page has an ASSET-BEGIN/ASSET-END region', !!region);
const P = new Function(region[1] + `
return { WSRO_CONTRACT, WSRO_HERE, BURN_SELECTOR, DECIMALS_SELECTOR, SYMBOL_SELECTOR, pickToken, toUnits, fromUnits,
  burnData, decodeSymbol, findAsset, payloadTarget };`)();

check('selectors are keccak of their signatures',
  P.BURN_SELECTOR === sel('burn(uint256)') && P.DECIMALS_SELECTOR === sel('decimals()') && P.SYMBOL_SELECTOR === sel('symbol()'));
check('⛔ no ?token means WSRO', P.pickToken(null) === WSRO && P.pickToken('') === WSRO && P.WSRO_CONTRACT === WSRO);
check('?token is normalised', P.pickToken(USDC.toUpperCase().replace('0X', '0x')) === USDC);
try { P.pickToken('0xnope'); check('⛔ a bad ?token is refused, not guessed', false); }
catch { check('⛔ a bad ?token is refused, not guessed', true); }

check('2,000 WSRO burns exactly 2000e18 (as the page always did)',
  P.burnData(P.toUnits('2000', 18)) === sel('burn(uint256)') + (2000n * 10n ** 18n).toString(16).padStart(64, '0'));
check('1.5 USDC burns exactly 1,500,000 base units', P.toUnits('1,5', 6) === 1_500_000n && P.toUnits('1.5', 6) === 1_500_000n);
check('⛔ no float anywhere: 0.1 + 0.2 style amounts are exact',
  P.toUnits('0.3', 18) === 3n * 10n ** 17n && P.toUnits('123456789.123456789123456789', 18) === 123456789123456789123456789n);
for (const bad of ['0', '-1', 'abc', '1.1234567']) {
  let threw = false; try { P.toUnits(bad, 6); } catch { threw = true; }
  check(`⛔ "${bad}" is refused at 6 decimals`, threw);
}
check('fromUnits round-trips', P.fromUnits(P.toUnits('60530.26', 6), 6) === '60,530.26');
check('page decodeSymbol: ABI string and bytes32', P.decodeSymbol(abiString('USDC')) === 'USDC'
  && P.decodeSymbol('0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0')) === 'MKR');

const bridge = { assets: [
  { symbol: 'WSRO', origin: { chainId: '1', contract: WSRO }, assetContract: P.WSRO_HERE, registrar: '0xf51a' },
  { symbol: 'FAZOL', origin: { chainId: '1', contract: '0x5809d43e34ce610044365b7bdacd0155627e0370' }, assetContract: '0x' + 'ab'.repeat(20) },
  { symbol: 'X', origin: { chainId: '56', contract: USDC }, assetContract: '0x' + 'cd'.repeat(20) },
] };
check('the registered asset is found by its Ethereum origin', P.findAsset(bridge, '0x5809d43e34ce610044365b7bdacd0155627e0370').symbol === 'FAZOL');
check('  and only on chain 1 (same address on another chain is another asset)', P.findAsset(bridge, USDC) === null);
check('⛔ default: commit and claim are addressed to WSRO\'s Molibra contract, as before',
  P.payloadTarget('HEADER_COMMIT', '0x1234', null) === P.WSRO_HERE
  && P.payloadTarget('BRIDGE_CLAIM', '0x1234', P.findAsset(bridge, WSRO)) === P.WSRO_HERE);
check('another asset: payloads go to ITS Molibra contract',
  P.payloadTarget('BRIDGE_CLAIM', '0x1234', P.findAsset(bridge, '0x5809d43e34ce610044365b7bdacd0155627e0370')) === '0x' + 'ab'.repeat(20));
{
  const asset = '0x' + 'ef'.repeat(20);
  const reg = encodeBridgeRegister({ originChainId: 1n, contract: USDC, assetContract: asset, cap: 10n ** 12n, symbol: 'USDC' });
  check('a REGISTER is addressed to the contract it names', P.payloadTarget('BRIDGE_REGISTER', reg, null) === asset);
}
check('the page burns on the selected token, not a constant', page.includes('to: TOKEN, value: \'0x0\', data }'));
check('⛔ the burn is simulated on Ethereum before the wallet is asked', page.includes('the burn would revert'));
check('⛔ WSRO-only claims (renounced mint, 21M ceiling) are hidden for other assets', (page.match(/wsroOnly/g) || []).length >= 4);
check('the page still loads the mobile wallet guard', page.includes('/molibra/mobilewallet.js'));
{
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let err = null; try { for (const s of scripts) new Function(s); } catch (e) { err = e.message; }
  check('the page script parses', !err, err ?? '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
