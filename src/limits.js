/**
 * Molibra - the bounds that keep a public node standing up.
 *
 * Every constant here exists because something without it is unbounded, and
 * anything unbounded on a public endpoint is a denial of service waiting for
 * somebody bored enough. They are gathered in one file so the security posture
 * can be read in one place rather than reconstructed from a dozen call sites.
 *
 * ## Which of these are consensus rules
 *
 * `MAX_EXTRA_DATA_BYTES`, `MAX_HEADER_NONCE_BYTES`, `MAX_FUTURE_DRIFT_SECONDS`
 * and the gas-limit check are **consensus**: a node applying them rejects a
 * block another node would accept, so changing one is a fork. The rest -
 * request sizes, mempool caps, orphan caps, range caps, reorg depth - are
 * **local policy**: they protect this node and never change what the chain
 * says.
 *
 * ## The one that is a trade, not a win
 *
 * `MAX_REORG_DEPTH` refuses to reorganise more than N blocks. It stops a
 * long-range rewrite by somebody who mined a deeper branch in private, which
 * is the attack that a young chain with little total work is most exposed to.
 * The cost is real and must be stated: a node that has been offline or
 * partitioned for longer than N blocks will refuse the honest heaviest chain
 * and needs a manual resync. Bitcoin does not do this; several smaller chains
 * do, precisely because they are small. Molibra is small.
 */

/** HTTP request body. Anything larger is refused before it is buffered. */
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

/** Blocks a single `/molibra/blocks?from=&to=` may return. */
export const MAX_BLOCK_RANGE = 512;

/**
 * CONSENSUS. Header extra data, in bytes. Ethereum uses 32 for the same
 * reason: a header field nobody validates is a free place to put a megabyte.
 * The genesis block is exempt - its extraData carries the sealed attribution
 * and is never verified against a parent.
 */
export const MAX_EXTRA_DATA_BYTES = 512;

/** CONSENSUS. The PoW nonce is a 64-bit search space, not a bignum. */
export const MAX_HEADER_NONCE_BYTES = 8;

/**
 * CONSENSUS, and the one that closes a real attack.
 *
 * `nextDifficulty` lowers difficulty whenever a block claims more than the
 * target interval has elapsed. Without a bound on how far ahead of real time a
 * timestamp may be, a miner claims an enormous elapsed time on every block and
 * walks difficulty down 1/16 at a time until the chain is free to mine - the
 * classic time-warp. Bounding the future drift is what makes the claim cost
 * something.
 */
export const MAX_FUTURE_DRIFT_SECONDS = 120n;

/** Transactions in one block. The gas limit bounds this too; belt and braces. */
export const MAX_TRANSACTIONS_PER_BLOCK = 2000;

/** Mempool: total transactions, and how many one sender may occupy. */
export const MAX_MEMPOOL_SIZE = 5000;
export const MAX_MEMPOOL_PER_SENDER = 64;

/** Blocks held waiting for a parent, and how deep their resolution may go. */
export const MAX_ORPHANS = 256;
export const MAX_ORPHAN_RESOLUTION_DEPTH = 128;

/**
 * Local policy. See the header note - this one has a cost.
 *
 * ⛔⛔ CONSENSUS-AFFECTING IN PRACTICE. It is local policy, not a validity rule,
 * so two nodes with different values do not reject each other's blocks - they
 * can instead end up on different chains after a deep reorg, one having
 * followed it and the other having refused. **Every node must carry the same
 * number**, which means changing it is a flag day: pull, then restart all of
 * them, or accept that they may diverge.
 *
 * ⛔⛔ Lowered 128 -> 32 on 9 Sep 2026 and RESTORED to 128 the same day, after
 * 32 partitioned the network within the hour. Do not lower it again without
 * reading this paragraph.
 *
 * The argument for 32 was that at ~20s blocks it leaves ~11 minutes of
 * rewritable history against ~43 for 128, and that the cost - a partition
 * deeper than N needing manual intervention - was "a person restarting
 * something, not an outage". That was the error: **a restart is exactly what
 * creates the gap.** A node that is down for a few minutes comes back, mines
 * its own branch immediately, and must now reorg to rejoin. Node 2 came back
 * 115 blocks behind, refused, mined an orphan branch, and needed a manual
 * resync. Under 128 it would have healed itself; under 32 every restart of
 * either node became a manual operation. Note the size of that number when
 * choosing: 64 would not have healed it either.
 *
 * ⭐ This is a floor of last resort, and it is no longer the main defence. The
 * anchored floor in src/anchor.js refuses reorgs below a height Ethereum has
 * attested to, at ANY depth and against ANY amount of work, and BOTH production
 * nodes now follow anchors. That is what carries the long-range case, so buying
 * ~11 minutes here instead of ~43 buys very little and costs a manual resync on
 * every restart. See the `finality` block on /molibra for which kind of node
 * you are asking.
 *
 * ⛔ It also sets the shallowest height that is safe to ANCHOR: a block cannot
 * be reorged away once it is more than this many blocks below the tip, so
 * anchor-publisher.mjs publishes at a depth comfortably greater than this.
 * Raising this number raises that depth, and so raises the steady-state
 * `exposed` window on /molibra.
 */
export const MAX_REORG_DEPTH = 128;

/** secp256k1 group order, and the low-s bound (EIP-2). */
export const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const SECP256K1_HALF_N = SECP256K1_N / 2n;

/**
 * How many peers this node will hold.
 *
 * Local policy, not consensus. It bounds the public `/molibra/announce`
 * endpoint: the peer set is iterated on every mined block, so an uncapped one
 * lets a stranger grow it until each block broadcast becomes an outbound flood
 * and this node becomes somebody else's amplifier. Refusing an announcement
 * costs a peer nothing but latency - it can still poll.
 */
export const MAX_PEERS = 64;
