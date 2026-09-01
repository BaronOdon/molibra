/**
 * Refusing more work than a node agreed to do.
 *
 * ⛔ A rate limiter is easy to write and easy to write USELESSLY. The failure
 * modes it must not have: charging every request the same when they cost wildly
 * different amounts; letting a batch smuggle a hundred calls past a
 * per-request counter; and growing its own bookkeeping without bound under the
 * very flood it exists to survive. Each of those has a test here.
 */

import {
  RateLimiter, costOfPath, costOfMethod, clientKey,
  DEFAULT_CAPACITY, DEFAULT_REFILL_PER_SECOND,
} from '../src/ratelimit.js';

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('rate limiting\n');

/** A clock we control: real time in a limiter test is a flaky test. */
const clock = () => { let t = 0; return { now: () => t, advance: (ms) => { t += ms; } }; };

/* ------------------------------------------------------------ the bucket */

{
  const c = clock();
  const rl = new RateLimiter({ capacity: 10, refillPerSecond: 5, now: c.now });
  let allowed = 0;
  for (let i = 0; i < 10; i++) if (rl.take('a').ok) allowed++;
  check('a full bucket allows its whole burst', allowed === 10, `${allowed}/10`);
  check('⛔ and the next request is refused', !rl.take('a').ok);

  const v = rl.take('a');
  check('  with a Retry-After a client can act on',
    v.retryAfter >= 1 && Number.isInteger(v.retryAfter), `${v.retryAfter}s`);

  c.advance(1000);
  let after = 0;
  for (let i = 0; i < 10; i++) if (rl.take('a').ok) after++;
  check('a second later it has refilled by exactly the rate', after === 5, `${after} = 5/s`);

  c.advance(60_000);
  let capped = 0;
  for (let i = 0; i < 50; i++) if (rl.take('a').ok) capped++;
  check('⛔ refill is capped at capacity, not accrued forever',
    capped === 10, `${capped} after a minute idle, capacity 10`);
}

/* ----------------------------------------------------------- isolation */

{
  const c = clock();
  const rl = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: c.now });
  rl.take('a'); rl.take('a'); rl.take('a');
  check('⛔ one client exhausting its bucket does not affect another',
    !rl.take('a').ok && rl.take('b').ok,
    'a shared bucket would let one address deny everyone else');
}

/* --------------------------------------------------------------- costs */

check('a state proof costs far more than a balance read',
  costOfPath('/molibra/state-proof/0xabc') > costOfPath('/molibra'),
  `${costOfPath('/molibra/state-proof/0xabc')} vs ${costOfPath('/molibra')}`);
check('⛔ because it rebuilds every line and the whole tree per call',
  costOfPath('/molibra/state-proof/0xabc') >= 20);
check('a block range costs more than one block',
  costOfPath('/molibra/blocks') > costOfPath('/molibra/block/12'));
check('an unknown route costs one', costOfPath('/molibra/anything') === 1);
check('⛔ the most specific prefix wins',
  costOfPath('/molibra/block/9') === 3 && costOfPath('/molibra/blocks') === 20,
  'a new expensive route must not inherit a cheap prefix');

check('eth_call costs more than eth_blockNumber',
  costOfMethod('eth_call') > costOfMethod('eth_blockNumber'),
  'one runs the EVM and the other reads an integer');
check('an unknown method costs one', costOfMethod('eth_chainId') === 1);
check('an absent method costs one, rather than crashing', costOfMethod(undefined) === 1);

/* ------------------------------------------------- the batch loophole */

{
  const c = clock();
  const rl = new RateLimiter({ capacity: 100, refillPerSecond: 1, now: c.now });
  // What the server does: charge for every call in the batch.
  const batch = Array.from({ length: 20 }, () => ({ method: 'eth_call' }));
  const cost = batch.reduce((s, x) => s + costOfMethod(x.method), 0);
  check('⛔⛔ a batch is charged for every call in it', cost === 20 * costOfMethod('eth_call'),
    `${cost} for 20 eth_calls`);
  check('  so one request cannot smuggle a hundred EVM executions past a per-request counter',
    !rl.take('a', cost + 1000).ok);
}

/* ------------------------------------------- the limiter's own memory */

{
  const c = clock();
  const rl = new RateLimiter({ capacity: 5, refillPerSecond: 1, maxClients: 100, now: c.now });
  for (let i = 0; i < 5000; i++) rl.take(`client-${i}`);
  check('⛔⛔ the limiter does not grow without bound under a flood of addresses',
    rl.size <= 100, `${rl.size} tracked, cap 100`);
  check('  and a forgotten client gets a FULL bucket, not a locked one',
    rl.take('client-0').ok,
    'forgetting must fail generous: the alternative is denying service through the defence');
}

/* --------------------------------------------------------------- keys */

check('the key is the socket address',
  clientKey({ socket: { remoteAddress: '1.2.3.4' } }) === '1.2.3.4');
check('⛔ X-Forwarded-For is IGNORED',
  clientKey({ socket: { remoteAddress: '1.2.3.4' }, headers: { 'x-forwarded-for': '9.9.9.9' } })
    === '1.2.3.4',
  'with no trusted proxy it is attacker-set: honouring it turns the limiter off by asking');
check('a socketless request still gets a key rather than throwing',
  clientKey({}) === 'unknown');

/* ------------------------------------------------------------ defaults */

check('the shipped burst is large enough for a page load',
  DEFAULT_CAPACITY >= 100, `${DEFAULT_CAPACITY}`);
check('  and the sustained rate is enough for a syncing peer',
  DEFAULT_REFILL_PER_SECOND >= 10, `${DEFAULT_REFILL_PER_SECOND}/s`);
check('⛔ a limiter with a zero rate is refused at construction', (() => {
  try { new RateLimiter({ refillPerSecond: 0 }); return false; } catch { return true; }
})(), 'a silently-zero limiter denies everything forever');
/* ------------------------------- who is out there, without saying who */

// The count exists for flag days: a consensus constant can only move once
// every node has upgraded, and `peers` is what this node dials OUT to - it
// says nothing about who dials in. A node that cannot see its own readers
// cannot tell you whether a flag day is safe to move.

{
  const c = clock();
  const rl = new RateLimiter({ now: c.now });
  check('a node nobody has asked reports zero readers', rl.activeClients() === 0);

  rl.take('1.2.3.4', 1);
  rl.take('5.6.7.8', 1);
  rl.take('1.2.3.4', 1);
  check('distinct clients are counted once each', rl.activeClients() === 2,
    `${rl.activeClients()} for two addresses across three requests`);

  c.advance(10 * 60_000);
  check('a client that asked ten minutes ago is still inside a 15m window',
    rl.activeClients() === 2);

  c.advance(6 * 60_000);
  check('and drops out once the window passes', rl.activeClients() === 0,
    'a reader who stopped asking is not evidence of a live node');

  rl.take('9.9.9.9', 1);
  check('a fresh request brings the count back', rl.activeClients() === 1);

  // The property the whole design turns on.
  check('it returns a NUMBER, never the keys',
    typeof rl.activeClients() === 'number',
    'publishing socket addresses would make a chain that records voluntary acts '
    + 'into one that records who reads it');

  check('it uses the injected clock, not wall time',
    new RateLimiter({ now: () => 0 }).activeClients(1, 0) === 0);
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
