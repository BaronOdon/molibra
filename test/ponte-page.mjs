/**
 * /molibra/ponte (one click per direction), the shared bMOLI -> MOLI flow
 * (bridgeflow.js) and /molibra/buy's "Receber como MOLI": the calldata each
 * builds is checked against the chain's own encoders and the operator pages,
 * the fee quotes against hand-computed values, and the wiring against the
 * served routes.
 */
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { encodeMoliBurn, decodeMoliBurn, MOLI_BURN_TAG } from '../src/moliburn.js';
import { keccak256, toHex } from '../src/crypto.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const page = read('src/web/ponte.html');
const buy = read('src/web/buy.html');
const rpc = read('src/rpc.js');
// A browser script: it registers itself on the global (window in a page).
createRequire(import.meta.url)(join(ROOT, 'src/web/bridgeflow.js'));
const flow = globalThis.MolibraReturn;

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};
const sel = (s) => toHex(keccak256(new TextEncoder().encode(s))).slice(0, 10);
const MOLI = 10n ** 18n;
console.log('ponte.html · bridgeflow.js · buy.html "Receber como MOLI"\n');

/* --------------------------------------------------- the page's own code */
const region = page.match(/\/\* PURE-BEGIN \*\/([\s\S]*?)\/\* PURE-END \*\//);
check('ponte.html has a PURE region', Boolean(region));
const VAULT = '0x0173f059ce912bb442296f3763746637f7d20fc1';
const L = new Function(`const VAULT = '${VAULT}';` + region[1]
  + '\nreturn { MOLI_BURN_TAG, TRANSFER, parseAmount, burnData, vaultData, expressFeeWei, claimFeeWei, returnFeeWei };')();

check('the burn tag is the chain\'s MOLI_BURN_TAG', L.MOLI_BURN_TAG === MOLI_BURN_TAG, L.MOLI_BURN_TAG);
const who = '0x5851cc5884313f7a66697de3bb772466dd5895c7';
for (const amt of ['1', '50000', '0.000001', '123.456789012345678901'.slice(0, 22)]) {
  const wei = L.parseAmount(amt);
  check(`burn of ${amt} MOLI = encodeMoliBurn byte for byte`, L.burnData(who, wei) === encodeMoliBurn(who, wei));
  const d = decodeMoliBurn(L.burnData(who, wei));
  check(`  and decodes to the burner and the amount`, d && d.recipient.toLowerCase() === who && BigInt(d.amount) === wei);
}
check('parseAmount: 50000 -> 50,000 MOLI exactly (no float rounding)', L.parseAmount('50000') === 50000n * MOLI);
check('parseAmount: comma decimals accepted', L.parseAmount('1,5') === 15n * 10n ** 17n);
check('⛔ parseAmount refuses 0, negatives, junk and >18 decimals',
  [ '0', '-1', 'abc', '', '1.0000000000000000001' ].every((s) => L.parseAmount(s) === null));
check('the transfer selector is transfer(address,uint256)', L.TRANSFER === sel('transfer(address,uint256)'));
check('vault transfer = what /molibra/return sends (transfer(VAULT, wei))',
  L.vaultData(7n * MOLI) === '0xa9059cbb' + VAULT.slice(2).padStart(64, '0') + (7n * MOLI).toString(16).padStart(64, '0'));
check('  and bridgeflow.js builds the same bytes', flow.vaultData(7n * MOLI) === L.vaultData(7n * MOLI));
check('bridgeflow\'s vault and fee address are the bridge\'s', flow.VAULT === VAULT && flow.FEE_ADDRESS === '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a');

/* ----------------------------------------------------------- fee quotes */
const Q96 = 1n << 96n;
// sqrtP for 333,322 bMOLI per ETH: sqrt(333322) * 2^96
const sqrtP = BigInt(Math.round(Math.sqrt(333322) * 1e9)) * Q96 / 1000000000n;
const gp = 1_000_000_000n;   // 1 gwei
// express: 3 x 200,000 x 1 gwei = 0.0006 ETH x 333,322 = ~200 MOLI
const ex = L.expressFeeWei(gp, sqrtP);
check('express fee at 1 gwei ≈ 3 x 200k gas x price x MOLI/ETH, rounded up to whole MOLI',
  ex === 200n * MOLI || ex === 201n * MOLI, `${ex / MOLI} MOLI`);
check('express fee floor 10 MOLI at near-zero gas', L.expressFeeWei(1n, sqrtP) === 10n * MOLI);
// claim: 2 x 250,000 x 1 gwei = 0.0005 ETH x 333,322 = ~167 MOLI
const cl = L.claimFeeWei(gp, sqrtP);
check('claim fee at 1 gwei ≈ 2 x 250k gas x price x MOLI/ETH, whole MOLI', cl === 167n * MOLI || cl === 168n * MOLI, `${cl / MOLI} MOLI`);
check('claim fee floor 5 MOLI at near-zero gas', L.claimFeeWei(1n, sqrtP) === 5n * MOLI);
check('fees are whole coins', ex % MOLI === 0n && cl % MOLI === 0n);
check('return fee floor 1 bMOLI at Molibra\'s 1 gwei', L.returnFeeWei(gp) === MOLI && flow.returnFeeWei(gp) === MOLI);
check('return fee scales past the floor (1,000 gwei -> 2 bMOLI)', L.returnFeeWei(1000n * gp) === 2n * MOLI);
check('cap: free = cap - usedInWindow', flow.capFree({ outbound: { botCap: { cap: '5000000000000000000000', usedInWindow: '165000000000000000000' } } }) === 4835n * MOLI);
check('cap: unknown when the node does not publish it', flow.capFree({}) === null);

/* --------------------------------------------------------------- page */
check('⛔ ponte.html never uses innerHTML (textContent only)', !/innerHTML/.test(page));
check('the burn goes to the never-called payload contract with explicit gas',
  page.includes("to: PAYLOAD_TO, data: burnData(account, wei), gas: '0x186a0'"));
check('the OUT fee is ONE transfer to the fee address (claim + express combined)',
  page.includes('const outFee = () => claimFee + ') && page.includes('to: FEE_ADDRESS, value:'));
check('the BACK fee is a bMOLI transfer to the fee address after the vault transfer',
  page.indexOf('vaultData(wei)') < page.indexOf('word(FEE_ADDRESS) + word(retFee)'));
check('every fee is shown before signing', page.includes("$('fees').textContent") && /feesOut:|feesBack:/.test(page));
check('express says the window is immutable: ~24 h instead of up to ~48 h', page.includes('~24 h no total') && page.includes('até ~48 h'));
check('a pending crossing is kept in localStorage and resumed on load', page.includes("'molibra.ponte.pending'") && page.includes('Resume a crossing'));
check('when claimed, bMOLI is added to the wallet with its logo', page.includes("wallet_watchAsset") && page.includes('bmoli-200.png'));
check('the bot cap is stated (automatic up to N per 5,760 blocks)', page.includes('5.760 blocos') && page.includes('botCap'));

/* ---------------------------------------------------------------- buy */
check('buy.html loads bridgeflow.js', buy.includes('<script src="/molibra/bridgeflow.js"></script>'));
check('"Receber como MOLI" is ON by default', /<input type="checkbox" id="asMoli" checked>/.test(buy));
check('⛔ the cap is checked BEFORE the swap is signed, with the keep-as-bMOLI way out',
  buy.indexOf("t('overCap'") > 0 && buy.indexOf("t('overCap'") < buy.indexOf("busy = t('confirmWallet')"));
check('the same click continues into the return after the swap confirms', buy.includes('if (asMoli) await toMolibra('));
check('with the option off, today\'s bMOLI path stays (watchAsset)', buy.includes("method: 'wallet_watchAsset'"));
check('only bMOLI offers it (WSRO has no way back)', buy.includes('$("asMoliRow").hidden = OUT !== POOLS.bmoli'));

/* ------------------------------------------------------------ routing */
check('rpc.js serves /molibra/ponte', rpc.includes("path === '/molibra/ponte'") && rpc.includes("'web', 'ponte.html'"));
check('rpc.js serves /molibra/bridgeflow.js as javascript', rpc.includes("path === '/molibra/bridgeflow.js'"));
check('the operator pages stay served', rpc.includes("path === '/molibra/return'") && rpc.includes("'/molibra/bridgedmoli'"));
const swap = read('src/web/swap.html');
check('swap links both directions to /molibra/ponte', swap.includes('href="/molibra/ponte"') && swap.includes('href="/molibra/ponte?dir=back"'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
