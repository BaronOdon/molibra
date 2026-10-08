/*
 * Molibra - every bridge fee, as ONE set of pure functions shared by the pages
 * (/molibra/ponte, /molibra/buy, /molibra/rapido load /molibra/bridgefees.js)
 * and the bots (bots/*.mjs load this same file with createRequire), so what a
 * page quotes and what the bot accepts cannot drift apart.
 *
 * ⭐ Fee reduction (operator, 8 Oct 2026). Every cost is still paid by its user
 *    (6 Oct rule), but at cost, not at a multiple of it:
 *
 *      fee = max(1.2 x gas x gas price, 0.00001 ETH), in MOLI at the bMOLI/ETH
 *            pool, rounded UP to 0.01 MOLI
 *
 *    - claim on Ethereum   CLAIM_GAS  (measured 87,075: claim 0x1750c094…, 7 Oct)
 *    - express anchor      ANCHOR_GAS (measured 159,849 per anchor-publisher run),
 *      at the FULL anchor price: the free hourly batch is the default
 *    - return on Molibra   RETURN_GAS x Molibra's gas price, in bMOLI, min 0.01
 *    - fast route          FAST_MIN_BP..FAST_MAX_BP of the amount by how full the
 *      paying side of the inventory is, plus 1.2 x the payout's gas
 *
 *    The bot accepts a fee >= ACCEPT_BP (90%) of the LOWER of the quotes it
 *    snapshotted around the fee's height: a quote that moved while the user
 *    signed never strands a paid request.
 *
 * Pure BigInt arithmetic, no DOM, no network. MOLI per ETH comes from the
 * bMOLI/ETH Uniswap v4 pool's sqrtPriceX96 (token1 bMOLI per token0 ETH, both
 * 18 decimals): price = sqrtP^2 / 2^192.
 */
(function (root) {
  const WEI = 10n ** 18n;
  const STEP = 10n ** 16n;                 // 0.01 MOLI / bMOLI
  const MARGIN_NUM = 12n, MARGIN_DEN = 10n;
  const FLOOR_ETH_WEI = 10n ** 13n;        // 0.00001 ETH
  const CLAIM_GAS = 100000n;
  const ANCHOR_GAS = 160000n;
  const RETURN_GAS = 1000000n;             // header commit + return on Molibra, 2 x 500,000
  const ACCEPT_BP = 9000n;
  const FAST_MIN_BP = 10n;                 // 0.1% with the inventory full
  const FAST_MAX_BP = 30n;                 // 0.3% with it empty

  const big = (v) => BigInt(v);
  /** Rounded UP to 0.01 of a coin. */
  const roundUp = (wei) => (big(wei) + STEP - 1n) / STEP * STEP;
  /** ETH-wei -> MOLI-wei at sqrtPriceX96, rounded up (the user pays the cost, never less). */
  function ethToMoli(ethWei, sqrtP) {
    const sq = big(sqrtP);
    return (big(ethWei) * sq * sq + (1n << 192n) - 1n) >> 192n;
  }
  /** MOLI-wei per 1 ETH. */
  const moliPerEth = (sqrtP) => (big(sqrtP) * big(sqrtP) * WEI) >> 192n;

  /** max(1.2 x gas x gasPrice, 0.00001 ETH) in MOLI, rounded up to 0.01. */
  function ethCostFee(gas, gasPriceWei, sqrtP) {
    let eth = big(gas) * big(gasPriceWei) * MARGIN_NUM / MARGIN_DEN;
    if (eth < FLOOR_ETH_WEI) eth = FLOOR_ETH_WEI;
    return roundUp(ethToMoli(eth, sqrtP));
  }
  /** The claim fee, MOLI-wei: the relayer's claim on Ethereum. */
  const claimFeeWei = (gasPriceWei, sqrtP) => ethCostFee(CLAIM_GAS, gasPriceWei, sqrtP);
  /** The express-anchor fee, MOLI-wei, ON TOP of the claim fee: one full anchor. */
  const expressFeeWei = (gasPriceWei, sqrtP) => ethCostFee(ANCHOR_GAS, gasPriceWei, sqrtP);
  /** The return fee, bMOLI-wei: 1.2 x RETURN_GAS x Molibra's gas price, min 0.01. */
  function returnFeeWei(molibraGasPriceWei) {
    const w = roundUp(RETURN_GAS * big(molibraGasPriceWei) * MARGIN_NUM / MARGIN_DEN);
    return w > STEP ? w : STEP;
  }

  /**
   * Fast-route rate in basis points: FAST_MAX_BP with the paying side empty,
   * FAST_MIN_BP at or above `fullWei`, linear between. `stockWei` is what the
   * inventory holds of the coin it PAYS OUT.
   */
  function fastFeeBp(stockWei, fullWei) {
    const s = big(stockWei), f = big(fullWei);
    if (f <= 0n || s >= f) return FAST_MIN_BP;
    if (s <= 0n) return FAST_MAX_BP;
    return FAST_MAX_BP - (FAST_MAX_BP - FAST_MIN_BP) * s / f;
  }
  /** Fast-route fee: amount x rate + 1.2 x the payout's gas (in the coin paid in), rounded up to 0.01. */
  function fastFeeWei(amountWei, stockWei, fullWei, gasMoliWei) {
    const pct = big(amountWei) * fastFeeBp(stockWei, fullWei) / 10000n;
    const gas = big(gasMoliWei) * MARGIN_NUM / MARGIN_DEN;
    return roundUp(pct + gas);
  }

  /**
   * Quote snapshots: [{ key, gasPrice, sqrtP, molibraGasPrice }], `key` a block
   * height. The last one at or before `at` and the first one at or after it;
   * all of them when none brackets `at`.
   */
  function quotesAround(snapshots, at) {
    const list = (snapshots ?? []).filter((s) => s && s.key !== undefined);
    if (!list.length) return [];
    const a = big(at);
    let before = null, after = null;
    for (const s of list) {
      const k = big(s.key);
      if (k <= a && (!before || k > big(before.key))) before = s;
      if (k >= a && (!after || k < big(after.key))) after = s;
    }
    const out = [before, after].filter(Boolean);
    return out.length ? [...new Set(out)] : list;
  }
  /** The smallest fee the bot accepts: ACCEPT_BP of the lowest quote. null when there is no quote. */
  function minAccepted(quotes) {
    const q = (quotes ?? []).map(big);
    if (!q.length) return null;
    const low = q.reduce((m, v) => (v < m ? v : m));
    return low * ACCEPT_BP / 10000n;
  }

  const api = {
    WEI, STEP, FLOOR_ETH_WEI, CLAIM_GAS, ANCHOR_GAS, RETURN_GAS, ACCEPT_BP, FAST_MIN_BP, FAST_MAX_BP,
    MARGIN_NUM, MARGIN_DEN,
    roundUp, ethToMoli, moliPerEth, ethCostFee, claimFeeWei, expressFeeWei, returnFeeWei,
    fastFeeBp, fastFeeWei, quotesAround, minAccepted,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MolibraFees = api;
})(typeof window !== 'undefined' ? window : globalThis);
