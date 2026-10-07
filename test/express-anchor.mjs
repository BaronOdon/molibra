/**
 * Express anchor (operator, 6 Oct 2026): a burner who pays a MOLI fee to the
 * fee address gets the anchor publisher run at once. Driven through the bot's
 * own express() with a stubbed trigger - no network, no schtasks.
 */
import {
  BridgeBot, expressFeeFor, EXPRESS_FEE_ADDRESS, EXPRESS_FLOOR_WEI, EXPRESS_WINDOW_BLOCKS,
  EXPRESS_MIN_INTERVAL_MS, ANCHOR_MIN_DEPTH, PUBLISHER_DEPTH, EXPRESS_RETRY_MS, EXPRESS_MAX_ATTEMPTS,
} from '../bots/bridge-core.mjs';

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const MOLI = 10n ** 18n;

console.log('express anchor\n');

/* ------------------------------------------------------- fee detection */
const burn = { from: A, height: '1000' };
const fee = (from, height, value) => ({ from, height: String(height), value: String(value) });
check('the fee address is the operator wallet', EXPRESS_FEE_ADDRESS === '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a');
check('the floor is 10 MOLI', EXPRESS_FLOOR_WEI === 10n * MOLI);
check('a fee from the same sender, at the floor, in the window, counts',
  expressFeeFor(burn, { f1: fee(A, 1010, 10n * MOLI) })?.hash === 'f1');
check('a fee in the burn\'s own block counts', expressFeeFor(burn, { f: fee(A, 1000, 12n * MOLI) }) !== null);
check(`a fee ${EXPRESS_WINDOW_BLOCKS} blocks after still counts`, expressFeeFor(burn, { f: fee(A, 1000n + EXPRESS_WINDOW_BLOCKS, 10n * MOLI) }) !== null);
check('⛔ one block past the window does not', expressFeeFor(burn, { f: fee(A, 1001n + EXPRESS_WINDOW_BLOCKS, 10n * MOLI) }) === null);
check('⛔ a fee BEFORE the burn does not', expressFeeFor(burn, { f: fee(A, 999, 50n * MOLI) }) === null);
check('⛔ a fee from another sender does not', expressFeeFor(burn, { f: fee(B, 1005, 50n * MOLI) }) === null);
check('⛔ a fee below the floor does not', expressFeeFor(burn, { f: fee(A, 1005, 10n * MOLI - 1n) }) === null);
check('sender match ignores case', expressFeeFor({ from: A.toUpperCase().replace('0X', '0x'), height: '1000' }, { f: fee(A, 1001, 10n * MOLI) }) !== null);

/* ------------------------------------------------------------- trigger */
function makeBot({ state, dryRun = false, clock, claimed = new Set(), config = {} }) {
  const fired = [];
  const logs = [];
  // claimed(tx) on BridgedMoli: 1 for hashes in `claimed`, else 0.
  const eth = { rpc: async (m, [call]) => (m === 'eth_call' && [...claimed].some((h) => String(call.data).includes(String(h).replace(/^0x/, ''))) ? '0x1' : '0x0') };
  const bot = new BridgeBot({
    io: { molibra: {}, eth, triggerAnchor: dryRun ? null : async () => { fired.push(clock.t); } },
    keys: null, state, log: (level, event, extra) => logs.push({ event, ...extra }),
    now: () => clock.t, config: { dryRun, feesFromMolibraHeight: 0n, feesFromEthBlock: 0n, ...config },
  });
  return { bot, fired, logs };
}
const freshState = () => ({
  burns: {
    b1: { from: A, height: '1000', status: 'awaiting-anchor' },
    b2: { from: B, height: '1010', status: 'awaiting-anchor' },
  },
  expressFees: { f1: fee(A, 1002, 15n * MOLI), f2: fee(B, 1012, 15n * MOLI) },
});
const clock = { t: Date.parse('2026-10-06T20:00:00Z') };

{
  const state = freshState();
  const { bot, fired, logs } = makeBot({ state, clock });
  await bot.express({ height: 1000n + ANCHOR_MIN_DEPTH - 1n });
  check(`⛔ not fired before the burn is ${ANCHOR_MIN_DEPTH} deep (the publisher would anchor below it)`,
    fired.length === 0 && state.burns.b1.express === 'waiting-depth');
  await bot.express({ height: 1010n + ANCHOR_MIN_DEPTH });
  check('fired once the burn is deep enough', fired.length === 1 && state.burns.b1.express === 'fired');
  check('  recorded in state with the fee that paid for it', state.burns.b1.expressFee === 'f1' && Boolean(state.burns.b1.expressFiredAt));
  check('  and logged', logs.some((l) => l.event === 'express-anchor-fired' && l.tx === 'b1'));
  await bot.express({ height: 1010n + ANCHOR_MIN_DEPTH });
  check(`⛔ a second paid burn waits out the ${EXPRESS_MIN_INTERVAL_MS / 60000}-minute rate limit`,
    fired.length === 1 && state.burns.b2.express === 'rate-limited');
  clock.t += EXPRESS_MIN_INTERVAL_MS;
  await bot.express({ height: 1010n + ANCHOR_MIN_DEPTH });
  check('  and fires once the interval has passed', fired.length === 2 && state.burns.b2.express === 'fired');

  // A restart inside the retry window: a new bot on the same state does not fire again.
  clock.t += EXPRESS_MIN_INTERVAL_MS;
  const again = makeBot({ state, clock });
  await again.bot.express({ height: 2000n });
  check('⛔ after a restart, nothing re-fires inside the retry window', again.fired.length === 0);

  // ⛔ Live 6 Oct: a fired run anchored tip-200 and missed the burn. Still
  // 'awaiting-anchor' after EXPRESS_RETRY_MS means Ethereum did not anchor it: re-fire.
  state.burns.b2.status = 'challenge-window';            // b2 WAS anchored by its run
  clock.t += EXPRESS_RETRY_MS;
  await again.bot.express({ height: 2000n });
  check('a burn still unanchored after the retry window is re-fired (attempt 2)',
    again.fired.length === 1 && state.burns.b1.expressAttempts === 2
    && again.logs.some((l) => l.event === 'express-not-anchored' && l.tx === 'b1'));
  check('  and a burn its run DID anchor is never re-fired', state.burns.b2.expressAttempts === undefined || state.burns.b2.expressAttempts === 1);
  clock.t += EXPRESS_RETRY_MS; await again.bot.express({ height: 2000n });
  clock.t += EXPRESS_RETRY_MS; await again.bot.express({ height: 2000n });
  check(`⛔ at most ${EXPRESS_MAX_ATTEMPTS} attempts per burn, then 'gave-up' (logged)`,
    again.fired.length === 2 && state.burns.b1.expressAttempts === EXPRESS_MAX_ATTEMPTS
    && state.burns.b1.express === 'gave-up' && again.logs.some((l) => l.event === 'express-gave-up'));
  check(`fire depth = the publisher's rule: burn < tip - ${PUBLISHER_DEPTH}, plus margin`,
    ANCHOR_MIN_DEPTH > PUBLISHER_DEPTH && ANCHOR_MIN_DEPTH === PUBLISHER_DEPTH + 6n);
}
{
  const state = freshState();
  state.burns.b1.status = 'challenge-window';      // already anchored
  delete state.burns.b2;
  const { bot, fired } = makeBot({ state, clock });
  await bot.express({ height: 5000n });
  check('⛔ an already-anchored burn is never fired for', fired.length === 0);
}
{
  const state = freshState();
  delete state.expressFees.f1;
  delete state.burns.b2;
  const { bot, fired } = makeBot({ state, clock });
  await bot.express({ height: 5000n });
  check('⛔ a burn with no fee waits for the daily run', fired.length === 0 && !state.burns.b1.express);
}
{
  const state = freshState();
  const { bot, fired, logs } = makeBot({ state, dryRun: true, clock });
  await bot.express({ height: 5000n });
  check('⛔ dry-run never runs the trigger, it logs what it would do',
    fired.length === 0 && logs.some((l) => l.event === 'express-dry-run') && !state.burns.b1.expressFiredAt);
}

/* ------------- regression 7 Oct: ground truth before the fee gate, grandfathering */
{
  const old = '0x' + '5d'.repeat(32);
  const state = { burns: {
    [old]: { from: B, height: '97260', status: 'unpaid-fee' },
    preRule: { from: B, height: '150000', status: 'new' },
    postRuleUnpaid: { from: B, height: '160000', status: 'new' },
  }, expressFees: {} };
  const { bot } = makeBot({ state, clock, claimed: new Set([old]), config: { feesFromMolibraHeight: 153_546n } });
  const advanced = [];
  bot.advanceClaim = async (hash) => { advanced.push(hash); };
  await bot.claims({ height: 170000n });
  check('⛔ a burn already claimed on Ethereum is CLAIMED, whatever the fee (heals a past unpaid-fee)',
    state.burns[old].status === 'claimed' && !advanced.includes(old));
  check('a burn from before the fee rule (fixed height) needs no fee: processed', advanced.includes('preRule'));
  check('⛔ a burn after the rule with no fee is still NOT processed (a state reset exempts nothing)',
    !advanced.includes('postRuleUnpaid') && state.burns.postRuleUnpaid.status === 'unpaid-fee');
  check('  and the resolved one is not listed for the operator', !bot.pendingItems().some((i) => i.molibraTx === old));
}

/* ------------------------------------------ fees gate claims and returns */
console.log('\nevery cost paid by its user (operator, 6 Oct 2026)\n');
{
  const state = {
    burns: {
      paid: { from: A, height: '1000', status: 'new' },
      unpaidOld: { from: B, height: '1000', status: 'new' },
      unpaidNew: { from: B, height: '1095', status: 'new' },
    },
    expressFees: { f: fee(A, 1003, 5n * MOLI), small: fee(B, 1001, 5n * MOLI - 1n) },
  };
  const { bot } = makeBot({ state, clock });
  const advanced = [];
  bot.advanceClaim = async (hash) => { advanced.push(hash); };
  await bot.claims({ height: 1150n });
  check('a burn whose sender paid the 5 MOLI claim fee is processed', advanced.includes('paid') && state.burns.paid.feePaid === 'f');
  check('⛔ an unpaid burn past the window is NOT processed: unpaid-fee', !advanced.includes('unpaidOld') && state.burns.unpaidOld.status === 'unpaid-fee');
  check('  (a fee 1 wei below the floor does not count)', state.burns.unpaidOld.status === 'unpaid-fee');
  check('an unpaid burn still inside the window waits: awaiting-fee', !advanced.includes('unpaidNew') && state.burns.unpaidNew.status === 'awaiting-fee');
  check('  and unpaid-fee is listed for the operator', bot.pendingItems().some((i) => i.molibraTx === 'unpaidOld' && i.status === 'unpaid-fee'));
  check('⛔ an unpaid burn never gets an express anchor either',
    (await bot.express({ height: 5000n }), !state.burns.unpaidOld.expressFiredAt));
}
{
  const state = { burns: { b: { from: A, height: '1000', status: 'new' } }, expressFees: { f: fee(A, 1001, 12n * MOLI) } };
  const { bot, fired } = makeBot({ state, clock: { t: clock.t + 10 * EXPRESS_MIN_INTERVAL_MS } });
  bot.advanceClaim = async (hash, b) => { b.status = 'awaiting-anchor'; };
  await bot.claims({ height: 1150n });
  await bot.express({ height: 1150n });
  check('⛔ 12 MOLI pays the claim (5) but not claim + express (15): no express anchor', fired.length === 0);
}
{
  const state = {
    burns: {}, expressFees: {},
    returns: {
      paid: { blockNumber: '500', from: A, status: 'new' },
      unpaid: { blockNumber: '500', from: B, status: 'new' },
      legacy: { blockNumber: '400', status: 'new' },
    },
    ethFees: { e: fee(A, 520, 1n * MOLI), wrong: fee(B, 700, 5n * MOLI) },
  };
  const { bot } = makeBot({ state, clock });
  check('a return whose sender paid the 1 bMOLI fee is processed', bot.returnPaid('paid', state.returns.paid, 650n) && state.returns.paid.feePaid === 'e');
  check('⛔ an unpaid return past the window: unpaid-fee', !bot.returnPaid('unpaid', state.returns.unpaid, 650n) && state.returns.unpaid.status === 'unpaid-fee');
  check('  (a bMOLI fee outside the 100-block window does not count)', state.returns.unpaid.status === 'unpaid-fee');
  check('a return recorded before fees existed is grandfathered', bot.returnPaid('legacy', state.returns.legacy, 650n));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
