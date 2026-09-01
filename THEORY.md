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

## 3. Coercion — where the two theories meet

Libertarian theory names coercion as the thing not to do. MQT says what coercion *is*,
mechanically, and therefore which defences can work at all. This section is the join, and it is
the reason both theories are named in the genesis block instead of one.

### Coercion, in the registers

A free act runs the loop the registers describe. The agent's own `I(x)` explores and selects;
on closure the result consolidates into the agent's own `c(x)`. Both halves belong to the
agent.

Coercion severs them. The exploration is performed by the coercer; the consolidation is charged
to the victim. Something enters the linear, invariable sink that the local non-linear explorer
did not produce.

**Coercion is a write to another's `c(x)` from outside their `I(x)`.**

That is why it is not one harm among many. `I(x)` is reversible — a bad exploration can be
explored back out, and nothing there is conserved. `c(x)` is monotone and irreversible by
construction: it is the register that does not revise. Coercion is the operation that reaches
past the reversible register and writes to the one that is not. The asymmetry §2 already
asserts — capability compounds, restraint does not — is the same asymmetry that makes coercion
uniquely expensive to its victim. What it installs cannot be taken back out.

### Coercion in the vacuum duality

`θ_v` is measured against a vacuum: the reference from which no direction is privileged,
`θ* = arccos(1/√3)`, the angle at which the second-order term averages to nothing. Read as a
statement about agency rather than geometry, **freedom is isotropy**. An agent at the reference
has no direction imposed on it — every branch is available and none is weighted from outside.

Coercion is the imposition of a preferred axis on another's vacuum. It does not persuade an
agent to prefer a direction; it makes the other directions unavailable, which is the same thing
as weighting them to zero. In the index it drives the victim toward **`i = −1`, fusion** —
inward attachment, but to a centre that is not their own. Forced fusion is the compact
statement: the coercer supplies the centre, the victim supplies the conscience it consolidates
into.

The duality gives a second and sharper reading. Communication along an edge happens at the
zero-state of the link: the two vertices meet at vacuum and the edge itself carries no bias.
**A coercive edge is one that transmits at a non-zero state** — the message arrives
pre-weighted. A network that admits such edges cannot compute a true `θ_v` for any node,
because inward and outward link counts no longer report the nodes' own states. Coercion
corrupts the measurement, not only the outcome.

That is exactly what it does to the libertarian datum. §1 records acts rather than answers
because costly acts are hard to fake. Coercion does not fake the cost — it reassigns who bears
it, and leaves a real act standing where no preference was revealed. A ledger whose entire
warrant is that acts are harder to falsify than opinions is defeated by coercion specifically,
and by very little else.

### Which register is under attack

Not the act. The **memory** register — open lots, the held state between intelligence and
conscience — is where a receipt lives. `c(x)` is a fingerprint and `I(x)` is transient; memory
is a document. A coercer need not watch the act if the act leaves something afterwards
provable, which is the whole of §8.1 of the whitepaper: the person knows their own blinding
factor and can therefore prove what they committed.

So every real defence against coercion is a statement about memory — about what can still be
proved later, and to whom. That is a useful filter, and it disposes of a class of proposals at
once: anything that hardens the act while leaving the receipt intact addresses nothing.

### Three windows, three different problems

Coercion has a time structure, and mechanisms that read as interchangeable in prose act on
different windows:

| window | what the coercer does | what would defeat it | Molibra today |
|---|---|---|---|
| **before** the act | compels the choice | an alternative that survives the threat | nothing |
| **during** the act | supervises it | the act being unobservable | nothing |
| **after** the act | demands the receipt | no receipt, or none distinguishable from a false one | nothing — individual verifiability *is* the receipt |

Three empty cells is the point. §8.1 already states the chain has no coercion resistance; the
register reading adds which problem would have to be solved, and that these are not one
problem. A mechanism that empties the third column leaves the first two untouched.

### Where the structure already resists, and why

Three properties resist coercion without having been designed for it. Each is the same move:
there is nothing for a coercer to grip.

**No privileged verifier — no chokepoint to coerce.** `Chain.append` re-executes every
transaction and recomputes the state fingerprint, gas total, Merkle root and seal; a peer is
never trusted for state. A coercer does not have to reach a million participants if one node's
word counts for more. A trusted role is a coercion target before it is anything else, so
polycentric verification removes a preferred axis from the topology — the same isotropy the
magic angle names, one level up from the single agent.

**A mint authority nobody holds — no key-holder to coerce.** The bridge's minting address is
derived as `last20(keccak256("molibra:bridge-authority:v1" || tokenId))`: the image of a hash,
not of a public key. No private key exists anywhere, so no one can be compelled to sign — there
is no person, and no quorum of persons, standing between the rule and its execution. This was
chosen so that only consensus can mint. That it also defeats the rubber hose is a consequence,
and it is the same consequence as the quantum one: **a secret nobody holds cannot be
extracted**, whether the adversary is Shor's algorithm or a threat in a room. Bridges secured
by multisigs or validator keys carry both exposures, and carry them for the same reason.

**A branch is not destroyed by losing.** Every verified block stays in `byHash` whether or not
it is canonical. Coercion's signature move is to eliminate the alternative — to make the other
branch not exist rather than not be chosen. At its consensus layer this chain declines to do to
blocks what a coercer does to people: what fork choice rejects is *not chosen*, and it stays
available if it later becomes heavier. A node that pruned losing branches would be cheaper and
would still work.

⛔ None of the three is coercion resistance. They are the absence of the gripping points a
coercer would use, which raises the cost without bounding it. The property §8.1 says is missing
is still missing.

### What MQT does not supply

MQT says coercion is a register violation and that the violated register is irreversible. It
does not say that this is wrong. *Ought not* is not derivable from *cannot be undone*, and a
theory of dynamics claiming otherwise would be overreaching in precisely the way this document
says a decorative theory does.

The prohibition is libertarian: non-aggression, a norm held for reasons of its own. MQT
contributes the mechanism, the measurement, and the reason the norm is not merely one
preference among several — the harm lands in the register that does not revise. The norm comes
from one theory and the mechanics from the other, and coercion is the one act that is both a
moral violation and a register violation.

### The relations, associated

| coercion | MQT | libertarian theory | in the chain |
|---|---|---|---|
| the act | a write to `c(x)` from outside `I(x)` | aggression | — |
| its irreversibility | `c(x)` monotone, never revised | why the wrong is not repaired by compensation alone | — |
| removal of the alternative | forced fusion, `i = −1` toward a foreign centre | a compelled choice is not a choice | fork retention — a branch is *not chosen*, never destroyed |
| the weighted approach | an edge transmitting at a non-zero state | stated preference contaminating revealed preference | — |
| what it grips | the memory register — the receipt | — | §8.1: individual verifiability *is* the receipt |
| where it aims | a privileged verifier; a key-holder | the chokepoint polycentrism denies it | no trusted peer; a mint authority with no key |
| freedom, by contrast | isotropy at `θ*` — no direction privileged | non-aggression as the condition of spontaneous order | equal weight, enforced rather than promised |

---

## Why both

Libertarian theory says *what* is worth recording: acts, freely undertaken, weighted equally,
verified by anyone. MQT says *how* a body of such records behaves once it is large — where it
concentrates, where it branches, and what it costs to let intelligence outrun conscience.

The first is about the datum. The second is about the corpus. Molibra needs both, because a
ledger that gets the unit right and the structure wrong is no more trustworthy than the
reverse.

And they are not separable at the point that matters: coercion, §3, is simultaneously the
libertarian wrong and the MQT register violation, which is why a defence that satisfies one
reading and not the other is not a defence.
