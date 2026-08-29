# The theories behind Molibra

Two, named in the genesis block and served at `/molibra/theories`: **libertarian theory** and
the **Macrobiotic Quantum Theory (MQT)**. This document sets out what each one is doing here
and, more usefully, where it actually shows up in the code — a theory that changes no design
decision is decoration.

---

## 1. Libertarian theory

The chain records what people chose to do. It does not ask them anything.

That single sentence carries the whole of it. A survey solicits an opinion; a purchase, or a
mark a person makes on a public board, is an **act**. Preference revealed by action is the
datum, and the record is a record of acts.

Five design consequences, each of them a line of code rather than a sentiment:

**Participation is voluntary and never inferred.** Nothing enters the ledger that a person
did not deliberately put there. There is no ambient collection, no derived profile, no
inferred preference.

**Revealed preference over stated preference.** The unit of record is an act with a cost
attached — the proof-of-work behind a participation credit, or the purchase behind the
physical metric. Costly acts are harder to fake than answers.

**No privileged verifier.** `Chain.append` re-executes every transaction in an incoming block
and recomputes the state fingerprint, gas total, Merkle root and seal. A peer is never
trusted for state. There is no node whose word counts for more, including the one that
produced the block.

**Open entry.** The block format, the verification rules and the replication endpoint are
public and documented. Anyone may run a node. Divergence between nodes is publicly
detectable — which is the point of having more than one.

**Equal weight, enforced rather than promised.** One count per person is the founding rule of
what this chain records. Protocol enforcement is what distinguishes a rule from a claim: an
assertion invites the question *how would anyone know?*, and a verifiable ledger answers it.

A note on honesty: this is the standard Austrian and libertarian toolkit — revealed
preference, spontaneous order, non-coercion, polycentric verification — applied as design
rationale. It is not a claim to any particular canonical text, and the design decisions above
stand on their own merits whether or not one accepts the wider framework.

---

## 2. Macrobiotic Quantum Theory (MQT)

MQT is the frame in which a body of records is read. A corpus is one **macrobiotic quantum**:
a four-dimensional tesseract whose vertices are records and whose edges are the links between
them. Communication along an edge happens at the zero-state of the link.

### Registers

| Register | Nature |
|---|---|
| `I(x)` | Intelligence — **non-linear** |
| `c(x)` | Conscience — **linear** |
| memory | open lots |
| `θ_v` | vacuum-duality angle, derived by `atan2` over inward and outward links |

`I(x)` compounds; `c(x)` does not. That asymmetry is the substance of the theory rather than
a notational flourish: capability can grow faster than the restraint that governs it, and
nothing in the arithmetic prevents that. Conscience has to be carried deliberately.

### The magic angle

    θ* = arccos(1 / √3) ≈ 54.7356°

The equilibrium reference. Around it sit three states, indexed by `i`:

- **`i = −1` — fusion**, `θ_v < 49.7°`: inward, attaching toward the centre.
- **`i = 0` — equilibrium**, within ±5° of θ*: the reference state.
- **`i = +1` — fission**, `θ_v > 59.7°`: outward, branching away.

θ* is the unique angle at which the second-order Legendre polynomial `P₂(cos θ)` vanishes —
the orientation at which a directional term averages to nothing. As a reference point it
means: the position from which no direction is privileged.

### Where MQT shows up in this chain

**Each block is a vertex; `parentHash` is the edge.** The chain is the one-dimensional
skeleton of the tesseract — state carried forward along links, each block's identity
depending on every block before it.

**A commitment is conscience without exposure.** The intended participation record is a
salted hash: it proves something existed at a moment without disclosing what it was. `I(x)`
gets the verifiability it needs; `c(x)` gives up nothing it should have kept. Destroying the
salt destroys the fact while leaving the proof of anteriority intact — the erasure mechanism
described in the Molibra specification.

**Difficulty retargeting is equilibrium-seeking.** `nextDifficulty` adjusts by a sixteenth per
block toward the target interval and never below its floor. It pulls the system back toward a
reference rather than toward an extreme — the same shape as the magic angle: a state defined
by not privileging any direction.

**Fission and fusion have a concrete meaning here, and both are implemented.** A chain that
only extends is fusion — inward, single-centred, `i = −1`. A fork is the fission case,
`i = +1`: the tree branches, and two histories exist at once. Molibra holds both. Every
verified block stays in `byHash` whether or not it is canonical, so a branch is not destroyed
by losing; it is only *not chosen*. Fork choice is the return to equilibrium — the heaviest
path is selected, the tree collapses back to a single canonical line, and what the reorg
dropped goes back to the mempool rather than being lost.

That is the theory earning its place rather than decorating the page: the design keeps
branches instead of pruning them, because in MQT a fission state is a real state of the
quantum and not an error to be discarded. A node that deleted losing branches would be
cheaper and would still work — and would also be unable to follow a branch that became
heavier later.

---

## Why both

Libertarian theory says *what* is worth recording: acts, freely undertaken, weighted equally,
verified by anyone. MQT says *how* a body of such records behaves once it is large — where it
concentrates, where it branches, and what it costs to let intelligence outrun conscience.

The first is about the datum. The second is about the corpus. Molibra needs both, because a
ledger that gets the unit right and the structure wrong is no more trustworthy than the
reverse.
