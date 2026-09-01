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

The chain is an account model with balances and nonces, and it runs a general-purpose virtual
machine: contracts, storage and code accounts all exist. The bridged assets and the MOLI/WSRO
pair are ordinary contracts on it.

That is a change. This document previously said there was no virtual machine, and argued that a
feature a chain does not have is a feature that cannot be exploited. The argument was right and
the property it protected still has to hold, so it is now obtained a different way: **the
regulated instructions are decoded before the machine ever runs, and arbitrary code cannot
reach them.**

Every native payload — an expression of will, a token creation, an issuance, a bridge claim —
has its decoder run first. A transaction reaches the virtual machine only when it is none of
them. A contract call and an expression both live in `data`; if a contract could claim an
expression payload, or an expression could be routed into bytecode, the rules in §5 would be
optional. They are not, because the ordering is consensus and not convention: a node that ran
them in the other order would compute a different state root and fork away from the network.

So the chain has general computation and, simultaneously, a class of instructions that general
computation cannot forge, wrap, or route around. An electoral token's non-transferability is
enforced by the validator rather than by the token's own code, which means no contract can wrap
it into something tradeable. That is a stronger guarantee than the absence of a machine was,
because it survives the machine being there.

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
root is a deterministic Keccak-256 over the sorted state — accounts first, then contract code
and storage, tokens and their balances, voting places, spent credentials, and the bridge
ledgers. Each of those is appended **only when present**, so a chain that has never used a
feature hashes exactly as it did before that feature existed, and adding one is not a fork.

It gives every node the same fingerprint for the same state, which is what consensus requires,
but it is **not** an Ethereum Merkle-Patricia root. Wallets do not check it, so nothing breaks.

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
questions, **earned**, destroyed on use.

Earned, not bought and not received from another holder. GIZ reaches people by **issuance**,
which runs one way only: the creator may issue, a holder can never pass a unit on. Transfer
and issuance are different operations and only one of them creates a market — which is why
the answer to "how does anybody get chalk?" is issuance rather than transferability. A person
with nothing clicks one button, their browser does a few seconds of visible work, and the
publisher issues chalk and the gas to spend it. Publisher pays; speaker earns.

Supply is **uncapped**, minted on demand, because questions never stop being created. Each
expression burns the token's declared cost — fixed for every mode but `weighted`, so nobody's
expression can be larger than anyone else's.

The separation is the whole point. A non-transferable token has **no market and therefore no
price**, so nothing of economic value attaches to expressing a preference. A transferable,
priced coin that granted a say would be a fundamentally different object, and the two must not
touch.

**Expressing burns the unit spent** rather than transferring it, which gives four properties at
once: the act costs something, so identities are not free; it cannot be replayed, because the
unit no longer exists; the count is public and needs no trusted counter, since
`minted − remaining = expressions cast`; and it is self-limiting, because a one-per-person
token makes maximum turnout visible from the start.

Token modes are immutable and disclosed on the token itself: `quantum` (one expression per
wallet per voting place — the GIZ rule), `single` (one expression per wallet regardless of
holdings), `capped(n)`, and `weighted` (one unit burned is one unit of weight —
**plutocratic by construction, and labelled so wherever it appears**).

So is the token's **purpose**, which has no default: `market` (aferição de mercado),
`behaviour` (comportamento do consumidor), `social` (comunicação social), `purchase`
(**expressão pública de compra**) or `electoral` (matéria eleitoral). DataToalha is a movement
of popular expression, from the people to the people: as consumers, people demand daily-use
goods bearing the characteristics of the political figure they prefer, and as a free people
they demand that the sale be public. The purchase *is* the expression. Anything running in an
electoral period is declared `purchase` and **never called an enquete or a pesquisa** — under
the TSE resolutions those are regulated objects, and this is not one of them. The chain
refuses the words in the title rather than discouraging them in a document. Full
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
protocol: **no peer reputation and no eclipse resistance.** A node that supplied most of
another's connections would decide what that node believes is the longest chain, without any
hash power at all.

Rate limiting is no longer on that list. The RPC bounds how much work one client address may
ask for, charging per route and per method rather than per request — a state proof rebuilds the
whole Merkle tree and is not the same unit of work as reading a balance, and a batch is charged
for every call inside it. Bursts are allowed, because a wallet opening a page and a peer pulling
blocks both arrive in bursts; the limiter is sized so that legitimate sync passes untouched,
which was verified against a real second node rather than assumed. At the
network's current size, proof of work is also cheap to out-hash — which is correct behaviour
under cumulative-difficulty fork choice, and exactly why the peer set matters today.

### 8.6 Cross-network transfers

A bridge is the most attacked component in this field, and it reintroduces the regulatory
questions the non-transferable design exists to avoid. This section said "it is not built" until
it was. It is now built and settled in both directions on Ethereum mainnet.

The design holds **nothing**. There is no vault and no custodian, because value crosses by
destruction and proof rather than by deposit: units are burned on one side and minted on the
other against a proof that the burn happened. Nearly every large bridge loss in this field was a
custody or quorum compromise, and there is no custody here to compromise. The mint authority on
the receiving side is the image of a hash rather than of a public key, so no signature reaches
it — only consensus can mint, and only after a Merkle proof.

⛔ **What is trusted, stated rather than glossed.** Settlement is against a **bonded attestation**
of Molibra's chain state, not against verified proof of work. Verifying the work itself is
implemented and trustless, and costs 168,288 gas per header — which is unaffordable at 5,760
blocks a day, so the affordable path is the bonded one. That is strictly weaker and nobody should
describe the bridge as proof-of-work-secured.

⛔⛔ **And the honest limit of the bond.** The publisher can be slashed for *equivocation* — one
key attesting to two different blocks at one height. A publisher who posts a single false
attestation and never a second has committed no provable fault, and cannot be slashed for it.
The challenge window therefore buys time to *notice* and to stop accepting, not an on-chain
remedy. A watcher runs against every attestation and reports disagreement; that watcher is the
thing that makes the window worth anything, and it is why it exists.

⛔ **MOLI leaving is one-way.** Burning MOLI here to mint a representation elsewhere destroys it;
returning would require the reverse instruction, which does not exist yet. Until it does, this
says so.

§8.5 remains the honest constraint on all of it: an attestation is only as good as the chain it
attests to.

---

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
