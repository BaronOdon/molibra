# Security policy

## Reporting a vulnerability

Report privately, not in a public issue. Use GitHub's **Report a vulnerability** button under
the Security tab of this repository, which opens a private advisory visible only to the
maintainers.

Please include what you did, what happened, and what you expected. A proof of concept against
your own local node is the most useful thing you can send. Give us a reasonable window to fix
it before publishing.

Molibra is an experimental network. There is no bug bounty.

## What is in scope

- Consensus faults: a block that one node accepts and another rejects, or a way to make a node
  adopt a chain with less cumulative work.
- State faults: a transaction sequence that mints, destroys or moves value against the rules;
  a way to make two nodes derive different state from the same blocks.
- Signature and replay faults: anything that lets a transaction be replayed on another chain,
  or here from another chain, despite EIP-155.
- Expression faults: any way to record a second expression from one wallet on one question, or
  to recover the content of a commitment before it is revealed.
- Anything that causes a node to disclose a private key, or to write one anywhere but the
  operator's own datadir.

## Implemented hardening

Every bound below exists because something without it was unbounded, and anything unbounded on
a public endpoint is a denial of service waiting for somebody bored enough. They live together
in [`src/limits.js`](src/limits.js) so the posture can be read in one place, and each one is
exercised against the actual attack shape in `test/run.js` §10 — not asserted.

**Consensus rules.** A node applying these rejects a block another node would accept, so
changing one is a fork.

| Guard | The attack it closes |
|---|---|
| **Future-timestamp bound** (120 s) | The **time warp**. Difficulty falls whenever a block claims the target interval elapsed, so an unbounded future timestamp is a free difficulty cut, repeatable every block until the chain costs nothing to mine. |
| **`extraData` ≤ 512 bytes** | A header field nobody bounds is a free place to put a megabyte that every node then stores and rehashes forever. |
| **Header nonce ≤ 64 bits** | The PoW search space is 64 bits; a bignum nonce is work for every verifier and none for the miner. |
| **Gas checked before execution** | A block whose transactions overrun the gas limit is invalid. Discovering that only after executing them means having done exactly the work the attacker wanted done. |
| **≤ 2,000 transactions per block** | Belt and braces alongside the gas limit; rejected before the proof of work is even looked at. |
| **Low-s signatures only (EIP-2)** | **Malleability.** For every valid `(r, s)` the pair `(r, n − s)` signs the same message, so the same authorised transaction can exist under two hashes. A stranger rebroadcasts the mutation, it is mined under a hash the sender never saw, and every client tracking its own transaction is left watching one that will never appear. |

**Local policy.** These protect a node and never change what the chain says.

| Guard | The attack it closes |
|---|---|
| **Request body ≤ 2 MB**, enforced while reading | Memory exhaustion from a body that is never allowed to finish arriving. |
| **Block range ≤ 512 per response** | Making a node build a multi-megabyte JSON string on demand for a stranger. `syncFrom` pages, so a joining node still gets the whole chain. |
| **Mempool: 5,000 total, 64 per sender** | Flooding. The per-sender cap matters as much as the total: one address filling every slot crowds everybody out just as effectively as thousands filling one each. When full, only a higher bid gets in, displacing the cheapest. |
| **Orphan pool ≤ 256, resolution depth ≤ 128** | The orphan pool is the one place a node stores something it has **not** validated, so it is the one place an unverifiable block costs a peer nothing to plant. The depth bound stops a peer-supplied orphan chain becoming a stack overflow. |
| **Reorg depth ≤ 128** | A branch mined in private and released to replace settled history. |
| **Sync yields to the event loop** | A node that goes silent whenever it catches up looks down to every wallet pointed at it. Verifying re-executes every transaction, so it yields every 32 blocks — the same reason the mining loop grinds in slices. |

### The reorg bound is a trade, not a win

`MAX_REORG_DEPTH` refuses to reorganise more than 128 blocks. It closes the long-range
rewrite, which is the attack a young chain with little cumulative work is most exposed to. The
cost is real and is stated rather than buried: **a node offline or partitioned for longer than
128 blocks will refuse the honest heaviest chain and needs a manual resync.** Bitcoin does not
do this; several smaller chains do, precisely because they are small. Molibra is small. The
refused blocks are kept, not discarded, so an operator can inspect what was offered.

## Is this "better than the urna eletrônica"?

On some axes yes, on others no, and the honest answer matters more than the flattering one.

**Where this record is stronger:**

- **Anyone can re-derive the tally.** Every node re-executes every transaction and arrives at
  the same state root independently — proven in the tests by a second node reaching the same
  root from the raw blocks. There is no totalisation step anybody has to be trusted about.
- **A person can verify their own expression is included**, by hash, in a specific block.
- **The rules cannot move after people have answered.** Mode, purpose, cost, ceiling and
  transferability are immutable and hashed into the state root. There is no setter.
- **The count needs no trusted counter**: burning *is* the tally.
- **It is open, reproducible and permissionlessly replicable** by anyone with the source.

**Where it is weaker, and cannot simply be parameterised into strength:**

- **Coercion resistance.** The urna's ballot secrecy is strong. Molibra's is not: individual
  verifiability *means* a receipt, and a receipt enables vote-buying. This is a genuine
  trade-off between two properties that pull against each other, not an omission. See
  [WHITEPAPER.md](WHITEPAPER.md) §8.1.
- **One person, one voice.** The urna binds to an identified electorate. Molibra binds to
  addresses, and addresses are free. The earning puzzle is a speed bump, not a Sybil defence.
- **Availability.** A small proof-of-work network is far easier to disrupt than air-gapped
  national infrastructure.

**And the framing that matters most:** Molibra does not run elections and is not a voting
system. What it carries is **expressão pública de compra** — a purchase, made public by the
person who made it. It is not an enquete and not a pesquisa. Any comparison with the urna is a
comparison of *record integrity*, not of electoral machinery, and it should never be presented
as the latter.

## Known and accepted limitations

These are documented, not defects. Please do not report them as vulnerabilities — but do
report anything that makes one of them *worse* than described.

- **No coercion resistance.** An expression is individually verifiable, which means the person
  who made it holds a receipt and can prove to a third party how they expressed themselves.
  That enables vote-buying and coercion. It is the most serious open problem in the design and
  is discussed in [WHITEPAPER.md](WHITEPAPER.md) §8.

  ⛔ **Hiding the address in the explorer is not a fix, and must never be shipped as one.**
  The explorer is a *view*. The chain is public and replicated on purpose: `/molibra/block/{id}`
  serves the raw signed transactions, every node holds them, and anyone with `curl` reads the
  sender. Obscuring the address in one explorer while every node publishes it is a curtain, not
  a lock — and it is worse than doing nothing, because people would rely on it.

  Coercion resistance is also stricter than privacy: it requires the person to be **unable to
  prove** how they expressed *even when they want to*. Holding their own key, they always can.

  What would actually work, in order of cost:

  1. **Optional participation.** If publishing on-chain is opt-in, "I never put mine on the
     chain" stays credible, because not everyone's is. Real, partial, and cheap — deniability
     at the level of participation rather than of content.
  2. **A fresh address per voting place**, derived from the master key so the association is
     *recomputable only by the key holder* and stored nowhere. This is the right primitive for
     "only the owner knows which address is theirs" — derivation, not encryption. ⚠ On its own
     it **breaks one-address-one-voice**: a person can derive unlimited addresses and take one
     grant each, which lands on the open eligibility problem.
  3. **Blind-signature credentials with per-poll nullifiers.** The publisher blind-signs an
     eligibility credential; the person expresses from an unlinked address presenting it; the
     nullifier refuses a second expression in that voting place without revealing whose it is.
     **Unlinkable and unique at once.** Implementable without zero-knowledge machinery, but it
     is a consensus change of real size — the validator would key uniqueness on the nullifier
     instead of on the sender.
  4. **Coercion resistance proper** needs more still: re-voting (JCJ-style) or a mixnet, so
     that no receipt is meaningful. Nothing short of that earns the phrase.
- **Peering is HTTP push and pull, not a hardened gossip protocol.** It suits a known set of
  nodes. The bounds above stop a peer exhausting memory or CPU, but there is still **no peer
  reputation, no authentication between peers, no per-IP rate limiting and no eclipse-attack
  resistance**. Do not mistake the hardening table for a hostile-network protocol.
- **The earning puzzle is a cost function, not a Sybil defence.** Somebody willing to run it
  against a thousand fresh addresses gets a thousand grants, exactly as they could mine a
  thousand times.
- **Proof of work at a small network size is cheap to out-hash.** Cumulative-difficulty fork
  choice is correct; it is also exactly why the peer set matters while the network is small.
- **`stateRoot` is not a Merkle-Patricia root**, so there are no light-client or inclusion
  proofs. See [README.md](README.md), "Scope".
- **Every block keeps its post-state in memory.** Fine at this scale, unsuitable for a chain
  with years of history.

## Key handling, for anyone running a node

The node writes a private key to `<datadir>/treasury.key` when the treasury is enabled, reads
one from `<datadir>/issuer.key` when the chalkboard issuer is enabled, and `molibra keys`
prints one to your terminal. All are secrets. The issuer key is the **token creator's** key —
whoever holds it can issue chalk, so it is the more sensitive of the two.

Binding the RPC to `0.0.0.0` exposes every route above, including the POST endpoints, to
anything that can reach the host. Bind to `127.0.0.1` unless you intend to serve the public,
and put a reverse proxy with real rate limiting in front of it if you do.

`data/`, `data-*/` and `*.key` are in `.gitignore` for exactly this reason. If you fork this
repository, keep them there. A private key committed to a public repository should be treated
as compromised the moment it is pushed — rotate it rather than deleting the commit, because
the deletion does not un-publish it.
