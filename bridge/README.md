# Molibra → Ethereum, phase 1: verification

An Ethereum contract that checks, for itself, that a transaction happened on Molibra.

Molibra uses the primitives Ethereum already has — Keccak-256, RLP, EIP-155 transactions — so
the EVM needs no new machinery to verify a Molibra block header. `MolibraProver` re-derives the
block hash from the header bytes, checks the header satisfies its own difficulty, and folds the
Merkle path to the transaction root. It trusts nobody who passed the proof along.

## Try it

```bash
# compile the contracts and RUN them against a real Molibra proof, locally
node bridge/build-and-test.mjs [path/to/node_modules/with/solc,ethers,@ethereumjs]

# then, with a node running, open the page and use your own wallet
node src/cli.js node --port 8545
#   http://127.0.0.1:8545/molibra/bridge
```

The page deploys both contracts to whatever network your wallet is on, funds the test bridge,
fetches a proof from the Molibra node, and calls `release`. Your wallet signs everything; the
page holds no key.

Supporting routes: `GET /molibra/proof/{txHash}`, `GET /molibra/header-rlp/{blockHash}`,
`GET /molibra/bridge/artifact/{name}`.

## Two things that cost real time, recorded so they cost it once

**Compile for `paris`, not the compiler's default.** solc 0.8.26 targets Cancun and emits
`PUSH0`/`MCOPY`. On a network that has not reached that hardfork the contract deploys happily
and then every call dies with an **invalid-instruction halt and no revert reason** — which reads exactly
like a broken verifier rather than a wrong compilation target.

**Molibra's Merkle tree promotes an odd trailing node; it does not duplicate it.** A verifier
written to the usual convention rejects every block with an odd transaction count. The proof
therefore carries the actual combining steps rather than one entry per level, and the tests run
every tree size from 1 to 12.

## ⛔ What this is not

`MolibraTestBridge` releases ETH against a **single** header with valid proof of work. Molibra's
difficulty is small, so such a header can be mined privately in seconds and a perfectly valid
proof produced for a transaction no honest node ever accepted. **It is a test rig. Do not put
other people's money in it.**

A bridge that carries value for third parties needs, technically: a header chain with
accumulated difficulty, a confirmation depth, and a difficulty floor that tracks the live
network — so that forging a proof means out-working the network rather than out-working one
block. And before any of that is written, the condition recorded in
`A:\datatoalha_legal\28_molibra_*` §8.8 applies: **written prior opinion from an electoral
lawyer and a capital-markets lawyer.** Releasing value on behalf of third parties is a
regulated activity (PSAV, Lei 14.478/2022 arts. 2º and 5º).

⛔⛔ **GIZ never crosses**, in any wrapping — see `mayCrossABridge()` in `src/proof.js`. MOLI is
a transferable coin and an ordinary question; GIZ is marketless chalk and bridging it would
manufacture the very price its design denies.
