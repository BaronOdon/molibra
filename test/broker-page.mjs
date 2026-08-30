/**
 * The broker page's own encoders, extracted OUT OF THE SHIPPED PAGE and run.
 *
 * Same discipline as test/create-page.mjs and test/browser-work.mjs: the thing
 * under test is the code that will actually execute in somebody's browser, not
 * a copy of it that drifted. On this page the stakes are money — a bad `units`
 * conversion or a mis-encoded negative tick is a transaction that either
 * reverts or does something other than what the operator read on screen.
 */

import { readFileSync } from 'node:fs';

let passed = 0; let failed = 0;
const check = (name, ok, note = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}${note ? '  ' + note : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${note ? '  ' + note : ''}`); }
};

const html = readFileSync(new URL('../src/web/broker.html', import.meta.url), 'utf8');
console.log('broker page\n');

// --- pull the functions out of the page ------------------------------------
function extract(name, kind = 'function') {
  // Three shapes appear on the page: `function f(){…}`, a one-line arrow
  // `const f = (x) => …;`, and a braced arrow `const f = (x) => {…\n};`.
  // Matching the braced one to the first `;` truncates it mid-body, which is
  // how this test first "passed" against half a function.
  const shapes = kind === 'function'
    ? [new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`)]
    : [new RegExp(`const ${name} = [^\\n]*=> \\{[\\s\\S]*?\\n\\};`),
       new RegExp(`const ${name} = [^\\n]*;`)];
  for (const re of shapes) {
    const m = html.match(re);
    if (m) return m[0];
  }
  throw new Error(`could not find ${name} in the shipped page`);
}

const src = [
  extract('word', 'const'), extract('addr', 'const'),
  extract('units'), extract('fmt'),
].join('\n');
// Guard the extractor itself: a truncated function would make every check
// below meaningless rather than failing honestly.
for (const [name, needle] of [['word', 'padStart(64'], ['units', 'padEnd(d'],
  ['fmt', 'replace'], ['addr', 'toLowerCase']]) {
  if (!src.includes(needle)) throw new Error(`extraction of ${name} looks truncated`);
}
const { word, addr, units, fmt } = await import(
  'data:text/javascript,' + encodeURIComponent(src
    + '\nexport { word, addr, units, fmt };'));

check('the page defines the four encoders', true, 'extracted from the shipped file');

// --- units: the decimal conversion that decides how much money moves --------
check('1 ETH is 1e18', units('1') === 10n ** 18n);
check('0.01 is 1e16', units('0.01') === 10n ** 16n);
check('144000 WSRO', units('144000') === 144000n * 10n ** 18n);
check('a 6-decimal token', units('1.5', 6) === 1500000n);
check('trailing decimals do not silently truncate',
  (() => { try { units('1.0000000000000000001'); return false; } catch { return true; } })(),
  'too many places must throw, not round somebody\'s money away');
check('a non-number is refused',
  (() => { try { units('1.2.3'); return false; } catch { return true; } })());
check('an empty value is refused',
  (() => { try { units(''); return false; } catch { return true; } })());
check('no floating point in the path',
  units('0.1') + units('0.2') === units('0.3'),
  '0.1 + 0.2 === 0.3 exactly, which Number cannot do');

// --- word: ⛔ the negative ticks -------------------------------------------
check('a positive tick encodes plainly',
  word(887272) === '00000000000000000000000000000000000000000000000000000000000d89e8');
check('⛔ MIN_TICK encodes as two\'s complement',
  word(-887272) === 'f'.repeat(59) + '27618',
  'a negative int24 written as a plain number would be a different range entirely');
check('and the encoding round-trips back to the tick',
  BigInt('0x' + word(-887272)) - (1n << 256n) === -887272n,
  'checked by arithmetic, not by a literal somebody typed');
check('-1 is all ones', word(-1) === 'f'.repeat(64));
check('zero is zero', word(0) === '0'.repeat(64));
check('every word is exactly 32 bytes',
  [0, 1, -1, 887272, -887272, 10n ** 30n].every((n) => word(n).length === 64));

// --- addr -------------------------------------------------------------------
check('an address is left-padded and lowercased',
  addr('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
  === '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');

// --- fmt --------------------------------------------------------------------
check('fmt groups thousands', fmt(144000n * 10n ** 18n).startsWith('144,000'));
check('fmt does not invent precision', fmt(10n ** 18n) === '1');

// --- ⛔ the addresses on the page must be the ones read from chain ----------
const EXPECT = {
  WSRO: '0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8',
  WETH: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  POOL: '0xfcaee25dd24c129a9069fcd2bedc7cd05798c47e',
  NFPM: '0x2214a42d8e2a1d20635c2cb0664422c528b6a432',
};
for (const [name, want] of Object.entries(EXPECT)) {
  const m = html.match(new RegExp(`const ${name}\\s*=\\s*'(0x[0-9a-f]+)'`));
  check(`${name} is the address read from chain`, m && m[1] === want, m ? m[1] : '(missing)');
}

// --- ⛔ the selectors -------------------------------------------------------
for (const [what, sel] of Object.entries({
  'WETH deposit()': '0xd0e30db0',
  'WETH withdraw(uint256)': '0x2e1a7d4d',
  'approve(address,uint256)': '0x095ea7b3',
  'NFPM mint(params)': '0x88316456',
  'pool slot0()': '0x3850c7bd',
  'pool liquidity()': '0x1a686502',
  'balanceOf(address)': '0x70a08231',
})) {
  check(`${what} selector present`, html.includes(sel), sel);
}

// --- ⛔ safety properties of the page itself --------------------------------
check('⛔ no unlimited approval anywhere',
  !/f{64}/.test(html.replace(/f'\.repeat\(58\)/g, '')) && !html.includes('MaxUint256'),
  'an infinite allowance is a standing permission to drain the token forever');
check('⛔ no swap router address is hardcoded',
  !/const ROUTER\s*=\s*'0x[0-9a-f]{40}'/.test(html),
  'a wrong router is an approval given to an unknown contract');
check('the page warns that liquidity can lose value', html.includes('perder'));
check('mainnet is enforced, not assumed', html.includes('MAINNET')
  && html.includes('eth_chainId'));
check('pt-BR is the default language', /let T = PT;/.test(html));
check('both languages define the same keys',
  (() => {
    const keys = (n) => {
      const m = html.match(new RegExp(`const ${n} = \\{([\\s\\S]*?)\\n\\};`));
      return new Set([...m[1].matchAll(/(\w+):/g)].map((x) => x[1]));
    };
    const pt = keys('PT'); const en = keys('EN');
    return pt.size === en.size && [...pt].every((k) => en.has(k));
  })(), 'a missing key renders as undefined in somebody\'s language');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
