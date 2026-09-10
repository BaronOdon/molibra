/**
 * Molibra - the monetary rules that destroy MOLI.
 *
 * ## ⛔⛔ Fee burn was considered and REJECTED. Do not re-propose it.
 *
 * It is the lever everyone reaches for first, and here it cannot work. The block
 * gas limit is 8,000,000 and the chain produces roughly 3,862 blocks a day, so
 * even with EVERY block full at the node minimum of 10^9 quanta per gas, total fees come to
 * about 30.9 MOLI a day against 7,724 issued. Burning all of it offsets
 * **0.40%** of issuance. To offset issuance through fees you would need full
 * blocks at ~250x that price, which prices ordinary transactions out of existence to
 * chase a supply statistic. Rejected by the operator on 9 Sep 2026 on exactly
 * this arithmetic; the numbers are recorded here so the idea is not revived by
 * someone who has not run them.
 *
 * ## What does work, in order of how much it can actually move
 *
 * A burn needs transaction volume. Issuance needs nothing but a decision - which
 * is why, on a chain with no users yet, the emission schedule is the only lever
 * that bites today. The sinks below matter later, as volume arrives, and they
 * are built now because a published cost is easy to raise and hard to introduce.
 *
 *   1. **Issuance** - reduce what is minted. Needs no volume. Not in this file:
 *      it lives in `blockRewardAt` (src/block.js) and its parameters are in
 *      genesis, so changing it means an activation height that overrides them.
 *   2. **Creation and issue charges** - below. They grow with real publishing.
 *   3. **Bridge-out** - already built, activates at `MOLI_BURN_ACTIVATION`.
 *      ⚠ It removes MOLI from Molibra's supply but mints a bMOLI claim on
 *      Ethereum, so it reduces *on-chain* supply without reducing total claims.
 *      Report it as such and never as destruction.
 *
 * ## ⛔⛔ Why these constants are not in genesis
 *
 * `genesis.json` carries `feeBurnBasisPoints: 0`, and that value is CORRECT and
 * permanent: it is what the chain did from block 0, and every block already
 * mined was validated under it. Genesis is the chain's history, not its policy
 * dial - editing it would make the existing chain unloadable and every past
 * state root wrong. A live chain changes a consensus rule the only way it can:
 * a new constant, an activation height, and every node upgraded before that
 * height arrives. Same shape as `MOLI_BURN_ACTIVATION` in src/moliburn.js,
 * deliberately.
 *
 * ⛔ A charge that fires on a HEIGHT is more dangerous than one that fires on a
 * TRANSACTION. `MOLI_BURN_ACTIVATION` diverges only when somebody actually
 * publishes a burn, so being late costs nothing until then. A charge on token
 * creation diverges the moment anybody creates a token past the height. Upgrade
 * every node before it, not after.
 *
 * ## ⛔⛔ What must NEVER be charged in MOLI
 *
 * Expressing will. A speaker's only cost is the GIZ burn, and an EXPRESS may be
 * signed at `gasPrice: 0`. If MOLI were both valuable and necessary to speak,
 * Res. 23.610/2019 art. 29 §8º - economic advantage, direct or indirect, for
 * political-electoral publications - would have something real to bite on. Every
 * charge in this file lands on the PUBLISHER: creating a question, and issuing
 * its units. Publisher pays; speaker earns. That is not a style preference, it
 * is the compliance argument, and it is the one rule here with no price on it.
 */

/**
 * ⛔⛔ ISSUANCE - decided 9 Sep 2026. **Bitcoin is the reference.**
 *
 * Genesis halves once per 2,102,400 blocks, which is **1.49 years** at the
 * measured 22.37 s interval (it was written as one year against the 15 s target
 * the chain does not actually achieve). Bitcoin halves every four years. This
 * lengthens the epoch to match:
 *
 *     2 MOLI, halving every 5,640,000 blocks (4.00 years), floor 0.05 MOLI
 *
 * ⭐ The reward is UNCHANGED at 2 MOLI. Only the epoch and the floor move, and
 * that is the whole correction: the emission curve was never the wrong height,
 * it was the wrong width.
 *
 * ⭐ Scaled to Molibra's block time this reproduces Bitcoin's curve almost
 * exactly, because the proportions are scale-invariant:
 *
 *      year    Molibra    Bitcoin
 *         2      96.8%      100.0%
 *         5      12.4%       12.5%
 *        10       4.0%        4.0%
 *        20       0.8%        0.8%
 *
 * with about 21.9M MOLI in circulation at year twenty against Bitcoin's 20.4M.
 *
 * ## ⛔⛔ Why a FAST schedule was proposed first, and why it was wrong
 *
 * The first draft cut the reward to 0.5 and halved every 68 days, reaching the
 * floor inside a year. It optimised for scarcity and would have been a serious
 * mistake, because on this chain scarcity and DISTRIBUTION pull in opposite
 * directions. Nobody else mines yet. An emission curve that completes in 272
 * days is one the operator mines almost entirely himself, ending with ~95% of
 * every MOLI that will exist for years - so a fast schedule does not dissolve
 * the concentration, it sets it in concrete.
 *
 * Bitcoin's slow curve is exactly what let its coins reach many hands: most of
 * the emission was still ahead when other people arrived. Mining is the ONLY
 * compliant way to distribute MOLI - handing it to participants is the art. 29
 * §8º silhouette, so there is no airdrop, no faucet, and no reward for taking
 * part - which makes "how much emission is still ahead when a stranger shows
 * up" the single most important property of this schedule.
 *
 * ⛔ The corollary, stated plainly: this chain is NOT deflationary for years,
 * and neither was Bitcoin. Deflation is what a mature schedule produces, not
 * what a young one is designed for. The publishing charge below is a real cost
 * and a real long-term sink; it is not a near-term deflation mechanism and must
 * not be sold as one.
 *
 * ## ⭐ The property that makes this flag day nearly risk-free
 *
 * Because the reward stays 2 MOLI, the new schedule and the genesis schedule
 * **agree on every block until 2,102,400** - genesis's first halving, roughly
 * 1.5 years away. A node still running the old code computes an identical
 * reward until then. Unlike a change to the reward level, this one has no
 * urgent divergence deadline at all. (The publishing charge below is different:
 * it changes state from its own activation height, and that is what sets the
 * real upgrade deadline.)
 *
 * ⚠ The four-year figure holds only while the retarget law is unchanged. Epoch
 * length is measured in BLOCKS; its duration in years depends on the 22.37 s
 * mean, which is itself a consequence of a median-targeting controller. Fix
 * that bias and epochs shorten by a third. Bitcoin does not have this problem
 * because its retarget averages over 2,016 blocks.
 */
export const ISSUANCE_ACTIVATION = 80_000n;

/** Unchanged from genesis. Only the epoch and the floor move. */
export const REWARD_AFTER = 2n * 10n ** 18n;          // 2 MOLI

/** Bitcoin's four-year epoch, in Molibra blocks at 22.37 s. */
export const HALVING_INTERVAL_AFTER = 5_640_000n;

/**
 * The permanent tail. Was 0.25 MOLI, which would settle at 1.9% inflation
 * forever - well above Bitcoin's asymptote. At 0.05 the tail is 0.32%.
 *
 * ⛔ Reached at era SIX, not five: 2 halves to 1, 0.5, 0.25, 0.125, 0.0625 -
 * still above 0.05 - and only the next halving clamps. That is about **24
 * years**. A floor that is not a power of two below the initial reward never
 * lands on a halving boundary, and publishing the era-5 date would put the
 * wrong figure in the whitepaper.
 */
export const REWARD_FLOOR_AFTER = 5n * 10n ** 16n;    // 0.05 MOLI

/**
 * The reward from the new schedule, or `null` before the flag day.
 *
 * ⛔ CONSENSUS-CRITICAL, and returning `null` rather than a fallback is
 * deliberate: `blockRewardAt` keeps ownership of the genesis schedule, this
 * owns the replacement, and neither silently guesses on the other's behalf.
 *
 * ⛔ Eras count from the ACTIVATION height, not from genesis. Counting from
 * zero would put the chain straight into era 0 of a schedule it was never on
 * and make the first post-activation halving land at an arbitrary offset.
 */
export function issuanceOverride(number) {
  const n = BigInt(number);
  if (n < ISSUANCE_ACTIVATION) return null;
  const era = (n - ISSUANCE_ACTIVATION) / HALVING_INTERVAL_AFTER;
  const reward = REWARD_AFTER >> (era > 64n ? 64n : era);
  return reward < REWARD_FLOOR_AFTER ? REWARD_FLOOR_AFTER : reward;
}

/**
 * The height at which publishing starts destroying MOLI.
 *
 * Set to 80,000 on 9 Sep 2026, when the tip was 46,453. At the measured 22.37 s
 * mean block interval that is about **8.7 days** - room to upgrade both nodes,
 * notice a mistake, and move the number while moving it is still free.
 *
 * ⛔ Free to change ONLY until the first token is created at or above it. After
 * that, replay would compute a different state root and a node would reject its
 * own chain.
 */
export const PUBLISH_BURN_ACTIVATION = 80_000n;

/**
 * What creating a token costs, destroyed rather than paid to anyone.
 *
 * ⛔⛔ **Priced in quanta, not in coins, and the first attempt got this backwards.**
 * It was 50 MOLI - about 0.05% of the entire money supply for one publish - a
 * number chosen to make a deflation target arrive rather than to price the act.
 * That is optimising the arithmetic instead of the thing being charged for.
 * Publishing a question is a routine application action; it must cost like one.
 *
 * 0.001 MOLI is 10^15 quanta: roughly fifty times the gas of an ordinary
 * transfer, so it is felt as a real cost and deters spam, and is nowhere near
 * enough to deter using the board for what the board is for. Deliberately LOW,
 * because a published cost can be raised and cannot really be lowered once
 * things are built on top of it.
 *
 * ⛔ **This does NOT make MOLI deflationary, and nothing here should be sold as
 * if it did.** Offsetting the 70,487 MOLI/year tail at this price would take
 * about 193,000 publications a day. Correctly pricing the act and manufacturing
 * scarcity are different goals, and when they conflict the price of the act
 * wins - a chain nobody can afford to publish on has solved nothing. What the
 * schedule does give is issuance capped at a fixed absolute number forever, so
 * inflation falls toward zero as a proportion; that is the honest claim.
 */
export const TOKEN_CREATION_BURN = 10n ** 15n;        // 0.001 MOLI = 10^15 quanta

/**
 * What issuing units of an existing token costs, likewise destroyed.
 *
 * Creating a question is one act; handing out its units is the repeated one, and
 * it is the one that scales with a board actually being used. Deliberately much
 * smaller than creation - it fires far more often, and a charge that discourages
 * distribution would defeat the board.
 *
 * ⛔ This is charged to the ISSUER, who is the publisher. It is never charged to
 * a recipient, and never to a speaker.
 */
export const TOKEN_ISSUE_BURN = 10n ** 12n;   // 0.000001 MOLI = 10^12 quanta

/** What creating a token destroys at this height. Zero before the flag day. */
export function tokenCreationBurn(blockNumber) {
  return BigInt(blockNumber) >= PUBLISH_BURN_ACTIVATION ? TOKEN_CREATION_BURN : 0n;
}

/** What issuing units destroys at this height. Zero before the flag day. */
export function tokenIssueBurn(blockNumber) {
  return BigInt(blockNumber) >= PUBLISH_BURN_ACTIVATION ? TOKEN_ISSUE_BURN : 0n;
}
