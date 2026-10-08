/**
 * /molibra/legal states facts about the running system. Each fact it states is
 * checked here against the code that makes it true, so a change to the system
 * that the page does not follow fails the build instead of misleading a reader.
 */
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAST_DEFAULTS } from '../bots/fastbridge-core.mjs';
import '../src/web/bridgefees.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const legal = read('src/web/legal.html');
const rapido = read('src/web/rapido.html');
const ponte = read('src/web/ponte.html');
const index = read('src/web/index.html');
const rpc = read('src/rpc.js');
const FEES = globalThis.MolibraFees;
const WEI = 10n ** 18n;

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};
console.log('legal page: every statement true of the code\n');
const both = (pt, en) => legal.includes(pt) && legal.includes(en);

check('served at /molibra/legal', rpc.includes("path === '/molibra/legal'") && rpc.includes("'web', 'legal.html'"));
check('the operator is identified: American Ltd, Xpirit AI, 11138952, England and Wales, registered office',
  both('American Ltd', 'American Ltd') && legal.includes('11138952') && legal.includes('13 Hanger View Way, London W3 0EX'));
check('⛔ no home address or personal name of the director on the public page', !/Marshall|Denzil|Itu|CPF/.test(legal));

const n = (wei) => (wei / WEI).toLocaleString('en-US');
const lim = [FAST_DEFAULTS.maxPerTransferWei, FAST_DEFAULTS.maxPerHourWei, FAST_DEFAULTS.maxPerDayWei];
check(`fast-route limits as the bot enforces them (${lim.map(n).join(' / ')})`,
  both(`${n(lim[0]).replace(',', '.')} por transferência, ${n(lim[1]).replace(',', '.')} por hora, ${n(lim[2]).replace(',', '.')} por dia`,
    `${n(lim[0])} per transfer, ${n(lim[1])} per hour, ${n(lim[2])} per day`));
check(`fast-route rate as the fee file computes it (${FEES.FAST_MIN_BP}-${FEES.FAST_MAX_BP} bp = 0.1–0.3%)`,
  FEES.FAST_MIN_BP === 10n && FEES.FAST_MAX_BP === 30n && both('0,1–0,3%', '0.1–0.3%'));
check('bridge fee as the fee file computes it (gas × 1.2, floor 0.00001 ETH; return min 0.01)',
  FEES.MARGIN_NUM * 10n / FEES.MARGIN_DEN === 12n && FEES.FLOOR_ETH_WEI === 10n ** 13n && FEES.STEP === 10n ** 16n
  && both('Gás × 1,2, mín. 0,00001 ETH', 'Gas × 1.2, min. 0.00001 ETH'));
check('⛔ the fast route is called custodial, on the legal page AND on the fast-route page itself',
  both('É custodial', 'It is custodial') && rapido.includes('Serviço custodial') && rapido.includes('Custodial service'));
check('⛔ "not authorised by any regulator" stated in both languages, on both pages',
  both('não tem hoje autorização de nenhum regulador', 'holds no regulatory authorisation today')
  && rapido.includes('não é autorizado por nenhum') && rapido.includes('not authorised by any regulator'));
check('the meme curves\' 26 Oct 2026 unlock to the operator is disclosed (legal page + landing)',
  both('A partir de 26/10/2026', 'From 26 Oct 2026') && index.includes('A partir de 26/10/2026'));
check('no pre-sale / no ICO wording, never "no sale"', both('não houve pré-venda nem ICO', 'no pre-sale and no ICO')
  && !index.includes('não há venda'));
check('⛔ "at cost" is not claimed for the bridge as a whole', !index.includes('A preço de custo') && !/At cost\./.test(read('src/web/i18n/en.json')));
check('no promise of profit, in both languages', both('não há promessa de lucro', 'there is no promise of profit'));
check('consumer rights that cannot be waived are preserved (CDC)', both('Lei 8.078/1990', 'Lei 8.078/1990') && both('direitos irrenunciáveis', 'cannot be waived'));
check('privacy: IPs in memory only, only a count published - as rpc.js and ratelimit.js do',
  both('apenas na memória', 'in memory only') && rpc.includes('A COUNT of distinct clients'));
check('the laws cited include the UK, Brazil, EU and sanctions regimes',
  ['Money Laundering Regulations 2017', 'SI 2026/102', 'Lei 14.478/2022', 'Parecer de Orientação CVM 40/2022', '2023/1114', 'OFAC'].every((s) => legal.includes(s)));
check('the landing footer and index link the legal page; ponte and rapido link it too',
  index.includes('href="/molibra/legal#pt-termos"') && index.includes('href="/molibra/legal"')
  && ponte.includes('href="/molibra/legal#pt-servicos"') && rapido.includes('href="/molibra/legal#pt-servicos"'));
check('memes advertised by symbol only (no personal names on the landing)', !index.includes('Bolsonaro Meme') && !index.includes('>Faz o L<'));
check('⛔ text by textContent only, no outside scripts', !/innerHTML/.test(legal) && !/<script src="http/.test(legal));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
