# Molibra — user-created tokens (draft specification)

**Status:** design, not implemented. Written 29 Aug 2026.

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
| Obtained by | Mining |
| Granularity | Fine — spendable in small units across many questions |
| Spent on | Expressing will; burned on use |

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
an electoral question** — and GIZ being non-transferable is what achieves that, not a fee
exemption. Optionally the gas for such an expression can also be sponsored by the treasury, so
nobody needs MOLI in hand to make a mark; that is a usability choice now, not a compliance one.

The underlying distinction is worth keeping in view. Creating a chalkboard is *publishing*:
the creator puts a question to the public and pays the network to carry it, which no rule
objects to. Expressing will on that board is *speaking*: the instrument for it must not be
something anyone can buy. Publisher pays; speaker earns.

---

## 1. What a token is

```
Token {
  id            H(creator ‖ title ‖ createdAt)   // deterministic, collision-resistant
  creator       address
  title         the question
  options       [string]                          // what may be chosen
  voteMode      single | capped(n) | weighted     // §2 — immutable, disclosed
  supply        §3 — immutable, disclosed
  transferable  false by default                  // §6 — opt-in, disclosed
  createdAt     block number
}
```

The token id is derived, not chosen, so nobody can squat a name or impersonate another
token's identity.

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

## 3. Availability (supply)

| Policy | Meaning |
|---|---|
| **`fixed(N)`** | *N* units minted at creation. Never any more. |
| **`scheduled(N, rate)`** | Up to *N* total, released at a declared rate. Predictable, capped. |
| **`open`** | The creator may mint more at will. |

`open` must carry a visible warning wherever the token appears: the creator can dilute every
holder's weight at any moment. Most honest questions want `fixed`.

For a `single`-mode token, supply is really an eligibility list: one unit is distributed to
each eligible participant, so supply *is* the electorate.

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

**Expressing will burns the unit spent.** The unit is destroyed, not transferred.

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

**Therefore:** transferability must be unavailable for tokens whose subject is electoral, and
opt-in with disclosure everywhere else. This is the same decoupling as
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

- **MOLI issuance:** halving or tail emission? (§4 — needs deciding, not defaulting.)
- **Fee burn:** on or off, and what fraction?
- **`single`-mode distribution:** who receives the one unit, and how is eligibility
  established without re-identifying people?
- **Transferability for non-electoral tokens:** allowed at all, or off across the board for
  simplicity and a cleaner regulatory posture?
