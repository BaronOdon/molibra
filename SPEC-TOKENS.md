# Molibra — user-created tokens (specification)

**Status:** implemented and tested. Written 29 Aug 2026; the distribution,
supply and cost model was reworked on **30 Aug 2026** after the operator found
three faults in the first implementation, and §1–§3, §5 and §6 below describe
what the code now does rather than what was once planned.

A token on Molibra is not primarily an asset. It is an **instrument for expressing will**: one
question, its options, and the rule by which people may speak on it. Holding a unit is
standing to speak; spending it is speaking.

Everything that governs how a token behaves is **fixed at creation and published with it**.
A reader must never have to trust a description — the rule is in the record.

---

## 0. Two tiers — the shape of the system

**MOLI is the network's coin and it is transferable.** It pays fees, it is mined, it moves
between wallets, it reaches external wallets. It carries no voting semantics of its own.

**Every other token is created inside the network and carries the rules.** Transferable or
not, one vote or several, whether it generates an app code — all of it declared at creation
and published with the token.

That separation is what keeps the system coherent: the asset is one thing, the instrument for
expressing will is another, and they are never the same object.

### Chalk (GIZ) — a distinct, non-transferable, app-specific token

GIZ is **its own token, not a denomination of MOLI**. It has to be, because it must be shown
as **non-transferable**, and MOLI is transferable — a denomination cannot differ from its
parent on the one property that matters here.

What it borrows from wei is **granularity**, not identity: GIZ is fine-grained and spent in
small amounts, so a single holding covers many expressions across many questions rather than
being a one-shot ticket.

| | |
|---|---|
| Symbol | **GIZ** (Chalk) |
| Scope | Specific to the DataToalha app — the politics chalkboard |
| Transferable | **No.** Displayed as non-transferable wherever it appears |
| Obtained by | **Issuance** — earned by work or granted against a linking proof; never bought, never passed on |
| Supply | **Uncapped**, minted on demand |
| Granularity | Fine — 18 decimals; spendable in small amounts across many questions |
| Spent on | Expressing will; burned on use, at the token's declared `expressionCost` |

**This is what makes the electoral surface clean, and it is a better answer than sponsoring
fees.** A non-transferable token has no market and therefore no price. Nothing of economic
value attaches to political participation, so Res.-TSE 23.610/2019 art. 29, § 8º — economic
advantage, direct or indirect — simply has nothing to bite on. The instrument for speaking
cannot be bought, sold, or accumulated as wealth; it can only be earned and spent.

Fee sponsorship (below) therefore becomes a convenience rather than a necessity: worth doing so
that nobody needs MOLI in hand to make a mark, but no longer the thing carrying the compliance
argument.

**Token creation is unlimited.** Anyone may create any number of tokens, each paying MOLI to
create and each declaring its own rules.

The chalkboard works like this: a person **mines**, accumulating GIZ, and **spends GIZ** to
express will — on one question or on many, and more than once where the question's mode allows
it. Fees are ordinary gas: `gas × gasPrice`, with difficulty and the market setting the price
exactly as they do for any other transaction. Nothing bespoke.

GIZ is the chalk; the chalkboard is public; the person makes their own mark. Nobody is
surveyed, and the mark is theirs.

**What the vote mode still controls.** The mode limits *how many times a wallet may speak*,
independently of how much GIZ it holds. In `single` mode the vote key `H(wallet ‖ tokenId)`
caps a wallet at one expression whether it holds one GIZ or a billion. Holding more never buys
more voice in `single` mode — it only pays for more separate questions.

### Who pays for what

**MOLI is required everywhere, as expected.** Creating a token costs MOLI. Every transaction
pays its gas in MOLI. Mining earns it.

The one act deliberately kept free of any priced asset is **a person expressing their will on
an electoral question** — and two things achieve it together. GIZ is non-transferable, so the
instrument for speaking has no price; and **an expression may be signed with `gasPrice` zero**,
so speaking costs no MOLI either. Nobody needs to hold a transferable asset before they can say
something, and nobody has to be given one.

That second half is a **compliance rule, not a convenience**. The alternative considered first
— sending each person a small MOLI stipend so they could pay the fee — was withdrawn: MOLI is
transferable and therefore priced, and handing a priced asset to somebody for registering a
political preference in an election year is the shape Res.-TSE 23.610/2019 art. 29 §8º
describes. The transferable coin must not touch the ballot, so nothing is handed over.

The free class is exactly the act of speaking. Every other transaction pays the node's
`minGasPrice`, which is what keeps it from becoming a free spam class — and the expression is
not free of cost in any case, since it burns the token's declared `expressionCost`.

The underlying distinction is worth keeping in view. Creating a chalkboard is *publishing*:
the creator puts a question to the public and pays the network to carry it, which no rule
objects to. Expressing will on that board is *speaking*: the instrument for it must not be
something anyone can buy. Publisher pays; speaker earns.

---

## 1. What a token is

```
Token {
  id              H(creator ‖ title ‖ createdAt)  // deterministic, collision-resistant
  creator         address
  title           the question
  options         [string]                        // what may be chosen
  voteMode        single | quantum | capped(n) | weighted   // §2 — immutable, disclosed
  purpose         market | behaviour | social | purchase | electoral  // §1a — immutable
  initialSupply   minted to the creator at creation; normally 0    // §3
  maxSupply       0 means UNCAPPED                                 // §3
  expressionCost  what one expression burns, in wei granularity    // §5
  issuable        may the creator issue more, one-directionally    // §3
  transferable    false by default                // §6 — opt-in, disclosed
  electoral       DERIVED from purpose, never stated separately
  createdAt       block number
}
```

Running accounting kept alongside the record and hashed into the state root:
`minted`, `burned`, `expressions`. Under `weighted` the last two differ, so both
are published and no reader has to infer a count from an amount.

The token id is derived, not chosen, so nobody can squat a name or impersonate another
token's identity.

---

## 1a. Purpose — what the question is for

**Declared at creation, immutable, published with the token, and there is no default.**
A silent default on an immutable record is exactly the trap this field closes.

| Value | Label served with the record |
|---|---|
| `market` | aferição de mercado |
| `behaviour` | comportamento do consumidor |
| `social` | comunicação social |
| `purchase` | **expressão pública de compra** |
| `electoral` | matéria eleitoral |

The DataToalha mark is registered for **pesquisa e comunicação social**, and that
inscription is the scope: a question carried here is market measurement, consumer
behaviour, social communication, or a purchase publicly expressed. Declaring which,
on the record, is what makes the scope checkable rather than asserted.

### `purchase` — and why the name is the point

DataToalha is a **movement of popular expression, from the people to the people**. As
consumers, people demand daily-use goods bearing the characteristics of the political
figure they prefer; as a free people, they demand that the sale of those goods be
**public**. They do not merely permit the publicity — they ask for it. The purchase *is*
the expression, made by the buyer, about themselves.

Anything running in an electoral period is therefore declared `purchase` and **never as
an enquete or a pesquisa**, to be compliant with the TSE resolutions. Under
Res.-TSE 23.600/2019 an enquete is a regulated object, barred outright from 15 August of
an election year, and a pesquisa carries its own registration duty. A purchase publicly
expressed by the person who made it is neither.

**This is enforced, not documented:** `normalizeTokenRecord` refuses a `purchase` token
whose title contains *enquete* or *pesquisa*, and the read routes serve the disclosure
"it is NOT an enquete and NOT a pesquisa" with the record itself.

---

## 2. Vote modes — disclosed on the token, enforced by consensus

The mode is part of the token's immutable record. This is the load-bearing property: a reader
always knows whether they are looking at *one person, one voice* or at *weight bought with
money*, and a weighted token can never masquerade as an equal one.

| Mode | Rule | Enforcement |
|---|---|---|
| **`quantum`** | One expression per wallet per VOTING PLACE; unlimited places. Each question is a macrobiotic quantum, a GIZ unit one of its subquanta: once a unit has left a voting place it can never return to it, but is free to enter another. Key `H(wallet ‖ pollId)`. This is GIZ mode |
| **`single`** | One expression per wallet, for this token only | Vote key `H(wallet ‖ tokenId)` in state; a second attempt is rejected by consensus |
| **`capped(n)`** | Up to *n* expressions per wallet | Counter keyed by `H(wallet ‖ tokenId)`, refused above *n* |
| **`weighted`** | Each unit spent carries one unit of weight | No per-wallet limit; weight is whatever the holder burns |

`single` is the DataToalha rule and should be the default the interface offers. `weighted` is
legitimate for some questions — a shareholders' vote, a funding preference — but it is
**plutocratic by construction** and the interface must say so in those words wherever such a
token is displayed. Disclosure is not a footnote; it is the reason the mode is on-chain.

**A token cannot change mode.** Not by the creator, not by governance. A question whose rules
can move after people have answered is not a record of anything.

---

## 3. Availability (supply) and distribution

Two numbers, not one: `initialSupply` is what exists at creation, `maxSupply` is the ceiling
on what may ever exist, and **`maxSupply: 0` means uncapped**. GIZ is uncapped deliberately:
questions never stop being created, so demand for the instrument to answer them is unbounded
over time. `minted − remaining` is still the burn, and the burn is still the tally.

**Distribution is issuance, and issuance is not transfer.** This is the load-bearing
distinction, and the reason the first implementation was wrong:

| | Direction | Creates a market? |
|---|---|---|
| **Transfer** | holder ↔ holder | **Yes** — a buyer can receive and resell, so a price forms |
| **Issue** | creator → user, one-directional | **No** — recipients cannot pass it on |

The first implementation minted the whole supply to the creator and made GIZ
non-transferable, which together meant **nobody except the creator could ever express**. The
fix is emphatically *not* transferability, which would dismantle the whole art. 29 §8º
position within a day. The fix is an `issuable` flag and an ISSUE transaction that only the
creator may sign.

Consensus refuses the dead end at creation: a token that is **neither issuable nor
transferable** can never reach a second holder, and is rejected before its record becomes
immutable. So is a token with no initial supply and no way to issue any.

An `issuable` token carries a disclosure wherever it appears. Dilution only bites where
holdings buy weight, so the warning is raised for `weighted` and not for the modes in which
a wallet's voice is the same size however much it holds.

**Getting chalk into a hand.** `src/issuer.js` is the publisher's side of this: a person
clicks one button, their browser solves a small puzzle bound to their address, and the node
issues. A grant carries a small **gas stipend** alongside the chalk, because an expression is
still a transaction and still pays gas in MOLI — chalk alone cannot speak. A grant is refused
while the address still holds enough to speak, which caps hoarding without knowing anything
about the person. It is a speed bump, not a Sybil defence (§8.1 of the white paper says so).

⛔ **The puzzle must never run inside the mobile application.** Mining in an app is banned by
Apple 3.1.5(ii) and by Google Play outright. The app's button is the other door: a grant
against a linking proof the app already holds, which is not mining and moves no value the
person owns.

---

## 4. Inflation

**Molibra's own coin.** MOLI currently issues 2 per block with no cap — that is unbounded
inflation, and it should not stay that way by default. Two coherent options, to be chosen
deliberately and then fixed:

- **Halving schedule** — reward halves every *k* blocks, giving a hard asymptotic cap.
- **Tail emission** — reward decays to a small constant, so miners are paid forever and
  supply grows at an ever-shrinking percentage.

Either is defensible. Leaving it undecided is not: a chain whose issuance policy is "whatever
the constant currently is" cannot make any credible statement about scarcity.

**User tokens** inflate only through their declared supply policy (§3). There is no other
mint path. A token with `fixed` supply is mathematically incapable of inflating.

---

## 5. Burn — and why the burn *is* the tally

**Expressing will burns the token's declared `expressionCost`.** The amount is destroyed,
not transferred.

The cost is denominated in wei granularity (`10**15` is 0.001 of a unit), never as one whole
unit — that is what makes a single holding cover many questions rather than being a one-shot
ticket. It is **fixed** for `single`, `quantum` and `capped`: nobody's expression can be
larger than anyone else's, which is what keeps those modes egalitarian. Only `weighted` lets
the burned amount vary, because there the amount *is* the weight — which is precisely why
that mode is plutocratic by construction and labelled so wherever it appears.

This gives four properties at once:

1. **The act costs something**, so identities are not free — the anti-Sybil property.
2. **It cannot be replayed** — the unit no longer exists.
3. **The count is public and needs no trusted counter**: `minted − remaining = expressions cast`.
   Anyone can verify participation totals from supply alone.
4. **It is self-limiting** — a `single`-mode token gives each person exactly one unit, so the
   maximum possible turnout is visible from genesis of the token.

Burning is recorded as an event with the token id and the vote key, never with the choice in
the clear — the choice travels as a commitment (see the vote-privacy design), so the *count*
is public while the *content* stays private until reveal.

Optional, declared at creation: **fee burn**, where a fraction of the MOLI fee for expressing
is destroyed rather than paid to the miner. This makes participation mildly deflationary for
MOLI and is a reasonable counterweight to block issuance. It must be declared, not silent.

---

## 6. Transferability — default off, and why

**User-created tokens are non-transferable unless the creator explicitly opts in, and the
choice is disclosed on the token.**

The reasoning is the same one that shapes the rest of Molibra:

- A non-transferable expression instrument is **outside Lei 14.478/2022** by art. 3º, III —
  an instrument granting access to a specified service, the loyalty-points carve-out. It is
  not a virtual asset, so issuing one is not a regulated activity.
- The moment tokens are transferable and priced, **each issuance is potentially a securities
  offering** (Lei 6.385/1976 art. 2º, IX; CVM Guidance Opinion 40/2022), and a platform that
  lets anyone issue tradable tokens is in a materially different regulatory position from one
  that has a single native coin.
- For **electoral** subject matter this is not a close question: a transferable, priced token
  that grants a say on candidates walks directly into Res.-TSE 23.610/2019 art. 29, § 8º —
  economic advantage, direct or indirect, tied to political-electoral participation.

**Therefore:** transferability is unavailable — refused by consensus — for `electoral`,
`social` and `purchase` tokens alike. Comunicação social on public affairs, and a purchase
publicly expressed in an electoral period, are the same surface art. 29 §8º guards; a priced
instrument for speaking there attaches economic value to political participation just as
directly as one labelled electoral would. `market` and `behaviour` are a different object and
remain opt-in with disclosure. This is the same decoupling as
`A:\datatoalha_legal\28_molibra_*` § 8.8 — the transferable coin must not touch the ballot —
applied one level down, to tokens.

---

## 7. What must be implemented

1. `TOKEN_CREATE` transaction — carries the record in §1; the chain derives the id and rejects
   a duplicate.
2. Token registry in state, contributing to the state root.
3. `EXPRESS` transaction — `{tokenId, voteKey, commitment}`; validates the mode's rule, burns
   one unit, records the vote key.
4. Supply accounting per token: minted, remaining, burned.
5. Read routes: `/molibra/tokens`, `/molibra/token/{id}` returning the full disclosed record
   plus live supply and expression count.
6. Interface rules: mode and supply policy shown wherever a token appears; `weighted` and
   `open` carry explicit warnings; electoral tokens cannot be marked transferable.

Because tokens and vote keys live in **state**, a reorg unwinds an expression and restores the
burned unit automatically — the same property the vote-key design already relies on.

---

## 8. Open decisions for the operator

- ~~**MOLI issuance**~~ — **settled 29 Aug: tail emission** to a permanent 0.25 MOLI floor.
- ~~**Fee burn**~~ — **settled 29 Aug: off**, declared in genesis rather than left silent.
- ~~**Distribution**~~ — **settled 30 Aug: issuance**, one-directional, plus a gas stipend.
- **`single`-mode eligibility:** who receives the one unit, and how is that established
  without building the register of identified political preferences the design refuses?
  Still open, and still the hard one. `quantum`, `capped(n)` and `weighted` ship without it.
- **Coercion resistance:** expressions are individually verifiable, so the person who
  expressed holds a receipt and can prove how they expressed. Not fixable by a parameter.
- **The grant rule:** "refused while you still hold enough to speak" is a speed bump. If the
  board needs more than that, it needs something that identifies people, and that trade is
  the operator's to make — not a default to drift into.
