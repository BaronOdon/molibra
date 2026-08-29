# Molibra

### A public audit chain for participatory opinion research

**Version 0.1 — 29 August 2026**

---

## Abstract

Molibra is a proof-of-work blockchain with a narrow purpose: to make participation in public
opinion research verifiable by people who do not trust the publisher. It borrows Ethereum's
cryptographic primitives so that ordinary wallets work without a custom client, and adds one
thing Ethereum does not need — a consensus record of who has already spoken on which question.
That record lives in the state, so a duplicate is refused by every node independently and a
chain reorganisation restores the right to speak without any separate bookkeeping. The economic
design deliberately separates the network's transferable coin from the instrument that grants a
say, because a priced token that buys influence is a different, and much worse, object than a
chain.

Molibra records opinions. It has no legal effect of any kind, and it is not a voting system.

---

## Contents

1. [The problem](#1-the-problem)
2. [Design](#2-design)
3. [Compatibility, and its limits](#3-compatibility-and-its-limits)
4. [One wallet, one question, once](#4-one-wallet-one-question-once)
5. [Two tiers, on purpose](#5-two-tiers-on-purpose)
6. [What the application does not contain](#6-what-the-application-does-not-contain)
7. [Attribution](#7-attribution)
8. [Open problems](#8-open-problems)

---

## 1. The problem

Every opinion platform faces the same two objections, and neither is answered by publishing a
number. The first is that the operator counted its own results. The second is that one person
may have counted many times. These are different failures — the first is about trust in the
publisher, the second about the cost of an identity — and a platform that solves only one has
solved neither in the eyes of a sceptic.

Conventional answers make the problem worse. Requiring documents to prove uniqueness turns an
opinion platform into a database of identified political preferences, which is a liability, not
a feature. Auditing by a trusted third party moves the trust rather than removing it.

Molibra takes the position that the count should be reproducible by a stranger from public
data, and that uniqueness should be enforced by **cost** rather than by **identity**.

---

## 2. Design

The chain is an account model with balances and nonces. There is no virtual machine: no
contracts, no storage, no code accounts. This is a deliberate reduction — every feature a chain
does not have is a feature that cannot be exploited, and nothing in the problem statement
requires general computation.

Blocks are sealed by Keccak-256 proof of work. Difficulty retargets by one sixteenth per block
toward a fifteen-second target. The canonical chain is the path of heaviest cumulative
difficulty; on an exact tie the incumbent keeps the head, so nodes do not oscillate. When the
head moves to a competing branch, transactions the abandoned branch had included return to the
queue and balances roll back with it.

A block is always validated **against its own parent's state**, never against whatever the node
currently considers the head. This is what allows a node to fully verify a competing branch
before deciding whether to adopt it, and it is why the fork-choice rule can be stated so
simply.

---

## 3. Compatibility, and its limits

Molibra uses secp256k1 keys, Keccak-256 hashing, twenty-byte addresses derived the Ethereum
way, RLP encoding, and legacy type-0 transactions with EIP-155 replay protection. Chain ID
**20226** is signed into every transaction, so a Molibra transaction cannot be replayed on
another chain and vice versa. The node answers the JSON-RPC methods a wallet calls. The result
is that a standard wallet connects natively.

The compatibility is not total, and the difference is documented rather than glossed. The state
root is a deterministic Keccak-256 over the sorted account set — it gives every node the same
fingerprint for the same state, which is what consensus requires, but it is **not** an Ethereum
Merkle-Patricia root and supports no trie proofs. Wallets do not check it, so nothing breaks;
but anyone building on Molibra should know that light-client proofs do not exist here yet.

---

## 4. One wallet, one question, once

An expression of will is an ordinary signed transaction whose `data` carries a tag, followed by
the question identifier and a commitment. It must be self-addressed and carry no value: the
ballot never moves money. The only thing spent is the fee.

```
data = TAG (4 bytes) ‖ pollId (32 bytes) ‖ commitment (32 bytes)
to    = from        the expression never moves money
value = 0           only the fee is spent
```

On applying it, the chain derives the key `H(wallet ‖ pollId)` and refuses the transaction if
that key is already recorded. The scope is deliberate. A wallet that has spoken on one question
is untouched on every other, so the anti-duplication rule never becomes a general restriction
on an account.

The keys are part of the state and part of the state root. That matters twice. Every node must
agree on who has already spoken, or a block containing a duplicate would be accepted by one
node and rejected by another — a chain split. And because the record is state rather than a
side register, a reorganisation that unwinds the block unwinds the right to speak again for
free, with nothing left to drift out of step.

**The choice is not on the chain.** What is published is a commitment: a hash of the choice and
a blinding factor. Anyone can verify that a wallet spoke once, and count how many wallets
spoke, while learning nothing about what any of them said until a reveal.

### What this does and does not give you

Molibra offers a property most opinion platforms do not: **individual verifiability**. You
construct your own commitment, so you know what you committed. You can find your own
transaction in a block, so you know it was recorded. The public burn count tells you it was
included in the total. Cast-as-intended, recorded-as-cast, counted-as-recorded — all three are
checkable by the person who acted, without trusting anyone.

That property has a price, and §8 states it plainly.

---

## 5. Two tiers, on purpose

**MOLI** is the network's coin. It is transferable, it is mined, it pays for gas, and it
carries no voting semantics whatsoever. Every other token is created inside the network and
carries its own rules — transferable or not, one expression or several — all fixed at creation
and published with the token.

**Chalk**, symbol **GIZ**, is the application token for public expression, and it is
**non-transferable**. It must be its own token rather than a denomination of MOLI, precisely
because a denomination cannot differ from its parent on transferability. It borrows granularity
from the wei convention, not identity: fine-grained, spent in small amounts across many
questions, earned by mining, destroyed on use.

The separation is the whole point. A non-transferable token has **no market and therefore no
price**, so nothing of economic value attaches to expressing a preference. A transferable,
priced coin that granted a say would be a fundamentally different object, and the two must not
touch.

**Expressing burns the unit spent** rather than transferring it, which gives four properties at
once: the act costs something, so identities are not free; it cannot be replayed, because the
unit no longer exists; the count is public and needs no trusted counter, since
`minted − remaining = expressions cast`; and it is self-limiting, because a one-per-person
token makes maximum turnout visible from the start.

Token modes are immutable and disclosed on the token itself: `single` (one expression per
wallet regardless of holdings), `capped(n)`, and `weighted` (one unit burned is one unit of
weight — **plutocratic by construction, and labelled so wherever it appears**). Full
specification in [SPEC-TOKENS.md](SPEC-TOKENS.md).

---

## 6. What the application does not contain

The DataToalha mobile application contains **no wallet, no mining and no transfer of value**.
People mine and hold outside it, and prove control inside it by pasting a signed proof of
participation: the wallet signs a nonce, an application account identifier and an expiry, and
the backend recovers the address and checks that the challenge is unexpired and unused. It is
never a key and never a bare address.

This is an architectural boundary as much as a compliance one. On-device mining and in-app
wallets carry store rules and licensing questions that a research application has no business
taking on. The linking proof gets the property that matters — a verified, unique participant —
without the application ever holding value.

---

## 7. Attribution

The genesis block's `extraData` permanently records the origin of DataToalha, attributed to the
think tanks **Povo Candidato** and **Movimento Libertário do Brasil**; co-authorship with the
**World Spiritual Responsibility Organization**, creator of **Spiritcoin** and **Spiritual
Responsibility AI**; and the theoretical basis in **libertarian theory** and the **Macrobiotic
Quantum Theory**. It is served at `/molibra/theories` by every node and can be read from block
zero directly. See [THEORY.md](THEORY.md).

Recording it in genesis rather than on a web page is the point: a web page can be edited.

---

## 8. Open problems

A design document that lists only what works is a brochure. These are unsolved.

### 8.1 Coercion resistance — the most serious one

Molibra's individual verifiability (§4) has a direct cost: **the person who expressed holds a
receipt.** Because they know their own blinding factor, they can prove to a third party exactly
what they committed to. Receipts enable vote-buying and coercion, and no amount of care
elsewhere in the design compensates for it.

This is a known-hard problem, not an oversight, and it is not fixable by adjusting a parameter.
Receipt-freeness and coercion resistance require machinery Molibra does not have — re-encryption
mixnets, or JCJ-style fake credentials that let a coerced person hand over something
indistinguishable from a real one. Both are substantial additions with substantial costs of
their own.

Until it is solved, Molibra should be understood as suitable for questions where coercion is
not a realistic threat, and unsuitable for any question where someone has a material interest
in buying or compelling an answer. **Stating that limitation is part of the design, not a
disclaimer bolted onto it.**

### 8.2 Eligibility without re-identification

For a `single`-mode token, who receives the one unit, and how is that established without
building the database of identified political preferences that §1 rejects? This is the question
most likely to change the rest of the design. It is open.

### 8.3 Issuance — decided 29 August 2026

**Settled: tail emission.** The reward starts at 2 MOLI and halves every 2,102,400 blocks
(about a year at 15 s) until it reaches a permanent floor of **0.25 MOLI per block**, where it
stays forever.

| | Reward/block | Issued that year | Cumulative |
|---|---|---|---|
| Year 1 | 2.0 | 4.20M | 4.20M |
| Year 2 | 1.0 | 2.10M | 6.30M |
| Year 3 | 0.5 | 1.05M | 7.36M |
| Year 4 → ∞ | **0.25** | 0.525M | +0.525M/yr |

There is deliberately **no hard cap**. A chain whose fees are negligible by design cannot pay
for its own security from fees once issuance ends, so a cap would schedule a security cliff the
design has already promised not to fund. A permanent floor keeps miners paid while inflation
falls asymptotically toward zero as supply grows — roughly 5% at year ten, and declining.

**Fee burn is off**, and declared so rather than left silent. Burning fees is a deflationary
lever, and an appreciating MOLI would make expressing progressively more expensive — attacking
the one property this design exists to protect.

### 8.4 Fee burn

Whether a fraction of the fee is destroyed rather than paid to the miner, and how much. It must
be declared, not silent.

### 8.5 Network hardening

Peering is HTTP push and pull. It suits a known set of nodes and is not a hostile-network
protocol: no peer reputation, no meaningful rate limiting, no eclipse resistance. At the
network's current size, proof of work is also cheap to out-hash — which is correct behaviour
under cumulative-difficulty fork choice, and exactly why the peer set matters today.

### 8.6 Cross-network transfers

A bridge is the most attacked component in this field, and it reintroduces the regulatory
questions the non-transferable design exists to avoid. It is wanted. It is not built. This will
say so until it is.

---

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
