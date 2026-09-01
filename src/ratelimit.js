/**
 * Molibra - refusing more work than a node agreed to do.
 *
 * ## Why this exists now
 *
 * §8.5 has always said the RPC has "no meaningful rate limiting". That was
 * tolerable while the audience was a known set of nodes. It stops being
 * tolerable the moment a trading page invites strangers to point a browser at
 * the same host - and the public node is one vCPU that is already saturated by
 * mining.
 *
 * ⛔ One endpoint makes this urgent rather than tidy. `/molibra/state-proof/`
 * rebuilds the entire sorted line list and the whole Merkle tree on every call:
 * O(n log n) in the size of the state, for one request, from anybody. Adding a
 * proof endpoint without a limiter would have handed the public an amplifier.
 *
 * ## The shape
 *
 * A token bucket per client. Each request costs tokens; the bucket refills at a
 * fixed rate; an empty bucket is a 429 with `Retry-After`. Cost is per ROUTE,
 * because "one request" is not one unit of work - a state proof is not a
 * balance read, and pretending they are the same is how a limiter passes while
 * the box still falls over.
 *
 * ⛔ Bursts are allowed on purpose. A wallet opening a page fires several calls
 * at once and a syncing peer pulls in batches; a limiter that smooths those to
 * a trickle breaks the legitimate case and teaches the operator to disable it.
 * Capacity is the burst, refill is the sustained rate.
 *
 * ⛔⛔ The limiter must not become the thing that exhausts memory. An attacker
 * with many source addresses would otherwise grow the bucket map without bound
 * - a denial of service delivered through the denial-of-service defence. The
 * map is capped and the coldest entries are dropped, which is safe because a
 * dropped entry means a client gets a FULL bucket: forgetting is generous, and
 * generous is the correct direction to fail.
 */

/** Sustained requests per second, and the burst a client may spend at once. */
export const DEFAULT_REFILL_PER_SECOND = 25;
export const DEFAULT_CAPACITY = 200;

/** Never track more clients than this. See the note about the limiter itself. */
export const MAX_TRACKED_CLIENTS = 10_000;

/**
 * What a request costs, by route.
 *
 * ⛔ These are ordered most-specific first and matched by prefix, so a new
 * expensive route added below a cheap prefix does not silently inherit the
 * cheap cost. Anything unmatched costs 1.
 */
export const ROUTE_COSTS = [
  // Rebuilds every state line and the whole Merkle tree, per call.
  ['/molibra/state-proof/', 40],
  // Walks the chain and re-serialises; bounded by MAX_BLOCK_RANGE but still
  // far from free.
  ['/molibra/blocks', 20],
  ['/molibra/headers-rlp', 20],
  // Executes a transaction proof against a block.
  ['/molibra/proof/', 10],
  ['/molibra/block/', 3],
  ['/molibra/header-rlp/', 3],
];

/** JSON-RPC methods that run the EVM, and therefore are not one unit of work. */
export const METHOD_COSTS = {
  eth_call: 10,
  eth_estimateGas: 10,
  eth_getLogs: 10,
  eth_sendRawTransaction: 5,
};

export function costOfPath(path) {
  for (const [prefix, cost] of ROUTE_COSTS) {
    if (String(path).startsWith(prefix)) return cost;
  }
  return 1;
}

export function costOfMethod(method) {
  return METHOD_COSTS[method] ?? 1;
}

export class RateLimiter {
  constructor({
    refillPerSecond = DEFAULT_REFILL_PER_SECOND,
    capacity = DEFAULT_CAPACITY,
    maxClients = MAX_TRACKED_CLIENTS,
    now = () => Date.now(),
  } = {}) {
    if (refillPerSecond <= 0 || capacity <= 0) throw new Error('a limiter needs positive rates');
    this.refillPerSecond = refillPerSecond;
    this.capacity = capacity;
    this.maxClients = maxClients;
    this.now = now;
    this.buckets = new Map();   // key -> { tokens, last }
  }

  /**
   * Spend `cost` for `key`. Returns { ok } or { ok: false, retryAfter } in
   * whole seconds, which is what a client can actually act on.
   */
  take(key, cost = 1) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      // ⛔ Cap BEFORE inserting, or the map is briefly unbounded under exactly
      // the flood this is defending against.
      if (this.buckets.size >= this.maxClients) this.#evictColdest();
      b = { tokens: this.capacity, last: t };
      this.buckets.set(key, b);
    } else {
      const elapsed = Math.max(0, t - b.last) / 1000;
      b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSecond);
      b.last = t;
      // Keep insertion order meaningful for eviction: touch = move to the end.
      this.buckets.delete(key);
      this.buckets.set(key, b);
    }

    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, remaining: Math.floor(b.tokens) };
    }
    const deficit = cost - b.tokens;
    return {
      ok: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil(deficit / this.refillPerSecond)),
    };
  }

  /**
   * Drop the least recently touched tenth. A Map iterates in insertion order
   * and `take` re-inserts on every touch, so the front of the map is the
   * coldest — no timestamps to sort and no second index to keep correct.
   */
  #evictColdest() {
    const drop = Math.max(1, Math.floor(this.maxClients / 10));
    let i = 0;
    for (const k of this.buckets.keys()) {
      this.buckets.delete(k);
      if (++i >= drop) break;
    }
  }

  get size() { return this.buckets.size; }

  /**
   * How many distinct clients this node has served in the last `withinMs`.
   *
   * ⛔⛔ A COUNT, never the keys. The keys are socket addresses, and a chain
   * whose whole claim is that participation is voluntary and never inferred
   * has no business publishing who reads it. One number answers the question
   * that needs answering and discloses nobody.
   *
   * The question it exists for is a flag day. Changing a consensus constant is
   * only safe once every node has upgraded, and "has anyone else got a node?"
   * was previously unanswerable from the outside - the peer list is what this
   * node dials OUT to, and says nothing about who dials in. A node that cannot
   * see its own readers cannot tell you whether a flag day is safe to move.
   *
   * ⛔ It is a floor, not a census. Buckets are evicted under pressure, the
   * window is short, and a reader who has never asked is invisible. Treat a
   * low number as "no evidence of others", never as "there are none".
   */
  activeClients(withinMs = 15 * 60_000, now = this.now()) {
    let n = 0;
    for (const b of this.buckets.values()) if (now - b.last <= withinMs) n++;
    return n;
  }
}

/**
 * The key a request is limited under.
 *
 * ⛔ The socket address, deliberately — NOT `X-Forwarded-For`. That header is
 * set by whoever sent the request when there is no trusted proxy in front, so
 * honouring it would let an attacker mint a fresh identity per request and
 * turn the limiter off by asking. If this node is ever put behind a real proxy
 * this becomes wrong in the other direction, and that is a deliberate
 * trade-off to revisit THEN, with the proxy in hand.
 */
export function clientKey(req) {
  return req?.socket?.remoteAddress ?? 'unknown';
}
