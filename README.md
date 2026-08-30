# Molibra

A public audit chain. Native coin: **MOLI**.

[![Licence](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-130%20passing-brightgreen.svg)](#tests)
[![Node](https://img.shields.io/badge/node-%3E%3D20-informational.svg)](#install)

**[White paper](WHITEPAPER.md)** · [Theory](THEORY.md) · [Token spec](SPEC-TOKENS.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

Molibra uses the same cryptographic primitives as Ethereum — secp256k1 keys, Keccak-256,
20-byte addresses, EIP-155 signed transactions — and serves the JSON-RPC method set that
wallets actually call. That is what lets MetaMask and friends add it as a custom network
and sign for it with no bespoke client.

| | |
|---|---|
| Chain | Molibra |
| Coin | MOLI (18 decimals) |
| Chain ID | **20226** |
| Consensus | Proof of work (Keccak-256), retargeting toward a 15-second interval |
| Fork choice | Heaviest chain by cumulative difficulty, with reorg |
| Transactions | Legacy type 0, EIP-155 replay-protected |
| Block reward | 2 MOLI, halving to a 0.25 MOLI floor (§8.3) |

## Origin and authorship

The DataToalha phenomenon this chain records is attributed to the think tanks
**Povo Candidato** and **Movimento Libertário do Brasil**. Molibra is co-authored with the
**World Spiritual Responsibility Organization**, creator of **Spiritcoin** and
**Spiritual Responsibility AI**.

Its theoretical basis is **libertarian theory** and the **Macrobiotic Quantum Theory (MQT)** —
see [THEORY.md](THEORY.md).

All of the above is sealed into the genesis block's `extraData` and served at
`/molibra/theories`. Genesis is immutable, so the attribution cannot be quietly revised later.

## Install

```bash
npm install
```

Requires Node 20 or newer. Two dependencies: `@ethereumjs/rlp` and `ethereum-cryptography`.

## Use

```bash
# a fresh keypair
node src/cli.js keys

# chain status (add --balance 0x... for an account)
node src/cli.js info

# mine n blocks and exit
node src/cli.js mine --miner 0xYourAddress -n 5

# run a node: JSON-RPC + the public audit surface
node src/cli.js node --port 8545

# run a node that also mines
node src/cli.js node --port 8545 --miner 0xYourAddress --mine

# run a second node that peers with the first
node src/cli.js node --port 8546 --datadir ./data-b --peers http://127.0.0.1:8545

# pull and independently re-verify a peer's blocks
node src/cli.js sync --peer http://127.0.0.1:8545
```

## Connect a wallet

Add a custom network with:

- **Network name** — Molibra
- **RPC URL** — `http://127.0.0.1:8545`
- **Chain ID** — `20226`
- **Currency symbol** — `MOLI`

The chain ID is signed into every transaction, so a Molibra transaction cannot be replayed
on another chain and a transaction from another chain is refused here. Both directions are
covered by the test suite.

## Expressions of will

Molibra's one addition to the Ethereum transaction model. An expression is an ordinary signed
transaction whose `data` carries a tag:

```
data  = TAG (4 bytes) ‖ pollId (32 bytes) ‖ commitment (32 bytes)
to    = from        self-addressed: the ballot never moves money
value = 0           only the fee is spent
```

Applying it derives `H(wallet ‖ pollId)` and **refuses the transaction if that key already
exists**. The scope is per question, so a wallet that has spoken on one is untouched on every
other. The keys live in the state and in the state root, which means every node agrees on who
has spoken — and a reorg that unwinds the block unwinds the right to speak again for free,
with no side register to drift out of step.

The choice itself is **not on the chain**. What is published is a commitment: a hash of the
choice and a blinding factor. Anyone can verify a wallet spoke once and count how many wallets
spoke, without learning what any of them said.

> **This gives individual verifiability, and therefore a receipt.** Someone who expressed can
> prove to a third party what they committed to, which enables coercion and vote-buying. It is
> the design's most serious open problem — see [WHITEPAPER.md](WHITEPAPER.md) §8.1. Molibra is
> not suitable for questions where someone has a material interest in compelling an answer.

## The audit surface

Everything a third party needs in order to check the chain themselves, over plain HTTP:

| Route | What it returns |
|---|---|
| `GET /molibra` | Chain identity, height, head, attribution, theories, peers |
| `GET /molibra/head` | The current head block |
| `GET /molibra/blocks?from=&to=` | A range of blocks |
| `GET /molibra/block/{number\|hash}` | One block |
| `GET /molibra/tx/{hash}` | A transaction with its receipt |
| `GET /molibra/theories` | Attribution and theoretical basis, plus the sealed genesis bytes |
| `GET /molibra/peers` | Known peers |
| `GET /molibra/tokens`, `/molibra/token/{id}` | Token records with mode, purpose, live supply, burn count and the disclosures |
| `GET /molibra/issuer` | The chalkboard issuer: what it issues, how much, and the rule it applies |
| `GET /molibra/earn?address=` | A puzzle to solve, bound to that address |
| `POST /molibra/earn` | Redeem a solved puzzle; the publisher issues chalk and the gas to spend it |
| `POST /molibra/grant` | A grant against a linking proof — the application's one button, with no puzzle |
| `GET /molibra/chalk` | The page a person uses to release chalk to their address (pt-BR first, en second) |
| `GET /molibra/create` | Create a question: the form, with the chain's own rules checked as you type |
| `GET /molibra/wallet.js` | The in-page wallet: key generation, sealing, signing |
| `GET /molibra/vendor/{hashes,curves}/…` | The crypto that page needs, served from this node rather than a CDN |

Add **`?decoded=1`** to either block route to get transactions as objects instead of raw RLP
hex. The default is the *replication* payload — the exact bytes a joining node consumes — so
the decoded view is opt-in rather than the other way round. An explorer wants `decoded=1`; a
syncing node does not.

Peers exchange blocks by `POST /molibra/submit-block`. There is no bespoke wire protocol
standing between the public and the data: if you can reach a node over HTTP, you can
replicate the chain and verify it yourself.

## Verification is not delegated

A node never trusts a peer for state. Every incoming block is re-executed **against its own
parent's state**, not against whatever the node currently calls the head — that is what makes
a competing branch verifiable before the node decides whether to adopt it. The state
fingerprint, gas total, transaction Merkle root, difficulty and proof of work are all
recomputed. Anything that disagrees is rejected.

## Fork choice

The chain is a tree of known blocks; the canonical chain is the heaviest path through it,
measured by cumulative difficulty.

- A block whose parent is unknown is **held as an orphan** and connected when the parent
  arrives.
- A block on a **lighter** branch is verified and kept, but does not move the head.
- A branch with **more cumulative work** triggers a reorg: the node walks back to the common
  ancestor, unwinds the abandoned suffix, and applies the new branch.
- Transactions dropped by a reorg **go back to the mempool** and can be mined again. Their
  receipts are withdrawn and balances roll back with them.
- Side branches are **persisted**, not discarded: one that is heavier tomorrow is useless if
  it was thrown away today.

On an exact tie in cumulative work the incumbent head stands, so a node never flip-flops.
Two nodes can therefore disagree transiently on an equal-work tie until one side is extended,
at which point they converge. That is a deliberate choice, and the honest cost of it.

`GET /molibra` reports `totalDifficulty`, `knownBlocks` and `lastReorg` so the behaviour is
observable from outside.

## Tests

```bash
npm test
```

130 checks covering: genesis and sealed attribution; mining and block rewards; the JSON-RPC
method set; a real signed transaction from submission through receipt; replay, wrong-chain,
insufficient-funds and tampered-block rejection; the audit routes; two-node replication with
independent re-verification; fork choice (reorg onto heavier work, lighter branches kept but
not adopted, orphan connection, transaction return to the mempool, balance rollback, and side
branches surviving a restart); expressions of will (accepted once, refused twice on the same
question, accepted on a different question, refused when addressed elsewhere or carrying value,
re-derived identically by a second node, and unwound correctly by a reorg); and reload-from-disk
revalidation.

## Scope of v0.1

Honest about what is and is not here:

- **No EVM.** Value transfers only. `eth_call` returns `0x` and `eth_getCode` is empty for
  every address, because every account is externally owned.
- **`stateRoot` is not an Ethereum MPT root.** It is a deterministic Keccak-256 over the
  sorted account set. It gives every node the same fingerprint for the same state, which is
  what consensus needs, but it does not support trie proofs and is not comparable with an
  Ethereum state root. Wallets do not check it.
- **Peering is HTTP push and pull**, not a gossip network. Fine for a known set of nodes;
  it is not yet a hostile-network protocol.
- **Every block keeps its post-state in memory.** That is what makes validating a side branch
  against its own parent cheap, and it is fine at this scale, but it is not how a chain with
  years of history would do it.
- **No difficulty ceiling on a reorg.** A node will follow the heaviest branch it is offered,
  which is correct under proof of work and is exactly why the peer set matters while the
  network is small.
- **No coercion resistance.** Expressions are individually verifiable, which means they come
  with a receipt. See [WHITEPAPER.md](WHITEPAPER.md) §8.1.

Issuance is **settled**: 2 MOLI per block, halving every 2,102,400 blocks to a permanent floor
of **0.25 MOLI**, forever. No hard cap, deliberately — see [WHITEPAPER.md](WHITEPAPER.md) §8.3.
Fee burn is **off**. Distribution is **settled**: GIZ is issuable one-directionally by its
creator and never transferable, with supply uncapped and each expression burning the token's
declared cost. The remaining open problems, including coercion resistance and `single`-mode
eligibility, are §8.

**Speaking is free.** An expression may be signed with `gasPrice: 0`: the act already burns the
token's declared `expressionCost`, so the anti-spam property a fee would provide is provided
twice over, and nobody needs to hold a transferable asset before they can say something. Every
other transaction pays the node's `minGasPrice`, so a free transaction class does not become a
free spam class.

The earning puzzle at `/molibra/chalk` is **not block mining**: it does not secure the chain
and it creates no MOLI. It is a cost function for a faucet, and the page says so in those
words. It must never be shipped inside the mobile application — mining in an app is banned by
Apple 3.1.5(ii) and by Google Play, and the app's path is the linking-proof grant instead.

## Not financial advice

MOLI is the coin of an experimental network run by its users. It is not an investment, not a
security offering, and nobody guarantees it has or keeps any value. Mining consumes
electricity. Never share a private key or seed phrase with anyone.

## Licence

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution that must be preserved,
and [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
