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
import { claimFromProof as botClaimFromProof, SELECTORS as CLAIM_SELECTORS } from '../src/bmoliclaim.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const page = read('src/web/ponte.html');
const buy = read('src/web/buy.html');
const rpc = read('src/rpc.js');
// Browser scripts: they register themselves on the global (window in a page).
createRequire(import.meta.url)(join(ROOT, 'src/web/bridgefees.js'));
createRequire(import.meta.url)(join(ROOT, 'src/web/bridgeflow.js'));
const FEES = globalThis.MolibraFees;
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
  + '\nreturn { MOLI_BURN_TAG, TRANSFER, parseAmount, burnData, vaultData, expressFeeWei, claimFeeWei, returnFeeWei, CLAIM_SEL, claimFromProof };')();

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
// ⭐ Fee reduction (8 Oct 2026): max(1.2 x gas x price, 0.00001 ETH) at the pool, up to 0.01.
// express = ONE anchor: 1.2 x 160,000 x 1 gwei = 0.000192 ETH x 333,322 = ~64.00 MOLI
const ex = L.expressFeeWei(gp, sqrtP);
check('express fee at 1 gwei = 1.2 x 160k gas x price x MOLI/ETH (one full anchor)',
  ex >= 6399n * MOLI / 100n && ex <= 6401n * MOLI / 100n, `${Number(ex) / 1e18} MOLI`);
// claim: 1.2 x 100,000 x 1 gwei = 0.00012 ETH x 333,322 = ~40.00 MOLI
const cl = L.claimFeeWei(gp, sqrtP);
check('claim fee at 1 gwei = 1.2 x 100k gas (claims use ~87k) x price x MOLI/ETH', cl >= 3999n * MOLI / 100n && cl <= 4001n * MOLI / 100n, `${Number(cl) / 1e18} MOLI`);
const floor = L.claimFeeWei(1n, sqrtP);
check('floor 0.00001 ETH at near-zero gas (~3.34 MOLI), for claim and express alike',
  floor === L.expressFeeWei(1n, sqrtP) && floor >= 333n * MOLI / 100n && floor <= 334n * MOLI / 100n, `${Number(floor) / 1e18}`);
check('fees are rounded UP to 0.01', ex % 10n ** 16n === 0n && cl % 10n ** 16n === 0n && FEES.roundUp(1n) === 10n ** 16n);
check('the page fees ARE the shared file (MolibraFees)', cl === FEES.claimFeeWei(gp, sqrtP) && ex === FEES.expressFeeWei(gp, sqrtP));
check('live 8 Oct (0.169 gwei, ~331,972/ETH): claim ~6.74 MOLI, was ~28 under the old 2 x 250k',
  (() => { const q = FEES.claimFeeWei(169000000n, 576n * Q96); return q > 6n * MOLI && q < 8n * MOLI; })());
check('return fee at Molibra\'s 1 gwei: 1.2 x 1,000,000 gas -> min 0.01 bMOLI', L.returnFeeWei(gp) === 10n ** 16n && flow.returnFeeWei(gp) === 10n ** 16n);
check('return fee scales (1,000 gwei -> 1.2 bMOLI)', L.returnFeeWei(1000n * gp) === 12n * MOLI / 10n);
check('fast rate: 0.3% empty, 0.1% full, linear', FEES.fastFeeBp(0n, 100n) === 30n && FEES.fastFeeBp(100n, 100n) === 10n && FEES.fastFeeBp(50n, 100n) === 20n);
check('minAccepted: 90% of the lowest quote; none -> null', FEES.minAccepted([10n, 20n]) === 9n && FEES.minAccepted([]) === null);

/* ------------------------------------------------- the self-claim encoder */
check('the page\'s claim selector is BridgedMoli.claim', L.CLAIM_SEL === CLAIM_SELECTORS.claim);
{
  const proof = { blockNumber: 153653, headerRlp: '0x' + 'ab'.repeat(77), raw: '0x' + 'cd'.repeat(161),
    siblings: [{ hash: '0x' + '11'.repeat(32), side: 'right' }, { hash: '0x' + '22'.repeat(32), side: 'left' }] };
  check('self-claim calldata = the bot\'s claimFromProof, byte for byte', L.claimFromProof(proof) === botClaimFromProof(proof));
  const alt = { ...proof, siblings: undefined, proof: [{ sibling: '0x' + '33'.repeat(32), right: true }] };
  check('  also for the other sibling spelling', L.claimFromProof(alt) === botClaimFromProof(alt));
  const none = { ...proof, siblings: [] };
  check('  and for a one-transaction block (no siblings)', L.claimFromProof(none) === botClaimFromProof(none));
}
check('cap: free = cap - usedInWindow', flow.capFree({ outbound: { botCap: { cap: '5000000000000000000000', usedInWindow: '165000000000000000000' } } }) === 4835n * MOLI);
check('cap: unknown when the node does not publish it', flow.capFree({}) === null);

/* --------------------------------------------------------------- page */
check('⛔ ponte.html never uses innerHTML (textContent only)', !/innerHTML/.test(page));
check('the burn goes to the never-called payload contract with explicit gas',
  page.includes("to: PAYLOAD_TO, data: burnData(account, wei), gas: '0x186a0'"));
check('the OUT fee is ONE transfer to the fee address (claim + express combined), none when self-claiming',
  page.includes('const outFee = () => (selfOn() ? 0n : claimFee + ') && page.includes('to: FEE_ADDRESS, value:') && page.includes('if (!selfClaim) {'));
check('the page loads the shared fee file before its own code', page.indexOf('<script src="/molibra/bridgefees.js"></script>') > 0
  && page.indexOf('<script src="/molibra/bridgefees.js"></script>') < page.indexOf('/* PURE-BEGIN */'));
check('express is OFF by default (the free hourly batch is the default)', /<input type="checkbox" id="express">/.test(page));
check('⛔ self-claim pre-flights with eth_call before anything is signed',
  page.indexOf("erpc('eth_call', [{ from: account, to: BMOLI, data }") > 0
  && page.indexOf("erpc('eth_call', [{ from: account, to: BMOLI, data }") < page.indexOf("p.claimTx = await eth().request"));
check('the BACK fee is a bMOLI transfer to the fee address after the vault transfer',
  page.indexOf('vaultData(wei)') < page.indexOf('word(FEE_ADDRESS) + word(retFee)'));
check('every fee is shown before signing', page.includes("$('fees').textContent") && /feesOut:|feesBack:/.test(page));
check('the timing is stated honestly: hourly batch ~1–2 h + the immutable ~24 h window', page.includes('lote horário gratuito') && page.includes('~24 h'));
check('a pending crossing is kept in localStorage and resumed on load', page.includes("'molibra.ponte.pending'") && page.includes('Resume a crossing'));
check('when claimed, bMOLI is added to the wallet with its logo', page.includes("wallet_watchAsset") && page.includes('bmoli-200.png'));
check('the bot cap is stated (automatic up to N per 5,760 blocks)', page.includes('5.760 blocos') && page.includes('botCap'));

/* ---------------------------------------------------------------- buy */
check('buy.html loads bridgefees.js, then bridgeflow.js', buy.includes('<script src="/molibra/bridgefees.js"></script>\n<script src="/molibra/bridgeflow.js"></script>'));
check('"Receber como MOLI" is ON by default', /<input type="checkbox" id="asMoli" checked>/.test(buy));
check('⛔ the cap is checked BEFORE the swap is signed, with the keep-as-bMOLI way out',
  buy.indexOf("t('overCap'") > 0 && buy.indexOf("t('overCap'") < buy.indexOf("busy = t('confirmWallet')"));
check('the same click continues into the return after the swap confirms', buy.includes('if (asMoli) await toMolibra('));
check('with the option off, today\'s bMOLI path stays (watchAsset)', buy.includes("method: 'wallet_watchAsset'"));
check('only bMOLI offers it (WSRO has no way back)', buy.includes('$("asMoliRow").hidden = OUT !== POOLS.bmoli'));

/* ------------------------------------------------------------ routing */
check('rpc.js serves /molibra/ponte', rpc.includes("path === '/molibra/ponte'") && rpc.includes("'web', 'ponte.html'"));
check('rpc.js serves /molibra/bridgeflow.js as javascript', rpc.includes("path === '/molibra/bridgeflow.js'"));
check('rpc.js serves /molibra/bridgefees.js as javascript', rpc.includes("path === '/molibra/bridgefees.js'") && rpc.includes("'web', 'bridgefees.js'"));
check('the operator pages stay served', rpc.includes("path === '/molibra/return'") && rpc.includes("'/molibra/bridgedmoli'"));
const swap = read('src/web/swap.html');
check('swap links both directions to /molibra/ponte', swap.includes('href="/molibra/ponte"') && swap.includes('href="/molibra/ponte?dir=back"'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
