/**
 * Molibra - the monetary rules that destroy MOLI.
 *
 * ## ⛔⛔ Fee burn was considered and REJECTED. Do not re-propose it.
 *
 * It is the lever everyone reaches for first, and here it cannot work. The block
 * gas limit is 8,000,000 and the chain produces roughly 3,862 blocks a day, so
 * even with EVERY block full at the 1 gwei node minimum, total fees come to
 * about 30.9 MOLI a day against 7,724 issued. Burning all of it offsets
 * **0.40%** of issuance. To offset issuance through fees you would need full
 * blocks at ~250 gwei, which prices ordinary transactions out of existence to
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
 * ⛔⛔ ISSUANCE - the lever that actually bites, decided 9 Sep 2026.
 *
 * Genesis issues 2 MOLI per block, halving once per 2,102,400 blocks to a 0.25
 * floor. At the measured 22.37 s block interval that mints **9.4 million MOLI**
 * over ten years and runs at 96.8% inflation through year one. From the
 * activation height below the schedule is replaced with:
 *
 *     0.5 MOLI, halving every 262,800 blocks (~68 days), floor 0.05 MOLI
 *
 * which holds supply under a million for a decade and settles at about 193 MOLI
 * a day.
 *
 * ⛔ The floor is reached at era FOUR, not three: 0.5 halves to 0.25, 0.125,
 * then 0.0625 - which is still above 0.05 - and only the next halving clamps.
 * That is 1,051,200 blocks, about **272 days** after activation. A floor that
 * is not a power of two below the initial reward never lands on a halving
 * boundary, and publishing the era-3 date would put the wrong figure in the
 * whitepaper.
 *
 * ⭐ Why the FLOOR had to move too, which is the part that is easy to get
 * wrong. Cutting only the reward and keeping the 0.25 floor makes the long run
 * WORSE, not better: you arrive at the same fixed tail with far less supply
 * underneath it, so the tail is a larger fraction of the total. Jumping
 * straight to the old floor gives 9.7% inflation in year ten against 3.7% for
 * doing nothing at all. The level and the floor are one decision.
 *
 * ⭐ Why issuance does not go to zero. Mining is the ONLY compliant way to
 * distribute MOLI: handing it to participants is the art. 29 §8º silhouette, so
 * there is no airdrop, no faucet and no reward for taking part. If issuance
 * stopped, the operator's ~83% of supply would be locked in permanently and the
 * chain could never become anybody else's. 193 MOLI/day is chosen to be worth a
 * stranger's electricity once MOLI has any price at all.
 *
 * ⛔ The window for this change is NOW and it is short. The chain is 46 days
 * old, has no market, no external holders and no third-party miners, so the
 * schedule is a promise to nobody. Once the burn gate opens and bMOLI has a
 * supply, changing it breaks a commitment to real holders.
 */
export const ISSUANCE_ACTIVATION = 80_000n;

/** The block reward from the activation height. Was 2 MOLI. */
export const REWARD_AFTER = 5n * 10n ** 17n;          // 0.5 MOLI

/** Halving cadence after activation: ~68 days at 22.37 s blocks. */
export const HALVING_INTERVAL_AFTER = 262_800n;

/** The permanent tail after activation. Was 0.25 MOLI. */
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
 * 50 MOLI against a supply near 92,820 at the time of writing. Chosen to be felt
 * without being prohibitive while MOLI has no market price at all - and chosen
 * LOW on purpose, because a published cost can be raised and cannot really be
 * lowered once things are built on top of it.
 *
 * For scale: against issuance at the 0.25 MOLI floor (~965 MOLI/day), this
 * reaches net deflation at about **20 creations a day**. That is a product
 * target somebody can actually aim at, which is the point of choosing it.
 */
export const TOKEN_CREATION_BURN = 50n * 10n ** 18n;

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
export const TOKEN_ISSUE_BURN = 10n ** 17n;   // 0.1 MOLI

/** What creating a token destroys at this height. Zero before the flag day. */
export function tokenCreationBurn(blockNumber) {
  return BigInt(blockNumber) >= PUBLISH_BURN_ACTIVATION ? TOKEN_CREATION_BURN : 0n;
}

/** What issuing units destroys at this height. Zero before the flag day. */
export function tokenIssueBurn(blockNumber) {
  return BigInt(blockNumber) >= PUBLISH_BURN_ACTIVATION ? TOKEN_ISSUE_BURN : 0n;
}
