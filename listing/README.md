# Listing Molibra in the canonical chain registry

## Why

MetaMask shows **"Isto é um possível golpe / This is a possible scam"** on the Molibra network
because it cannot match the pair (chainId `20226`, name `Molibra`) against the canonical chain
list. It is a **registration gap, not a defect** — nothing about the node, the site, the
certificate or the contracts is wrong.

`chainid.network` and `chainlist.org` both publish from **`github.com/ethereum-lists/chains`**.
Getting `eip155-20226.json` merged there is what removes the warning.

## What was verified before writing this file

Checked 5 Sep 2026 against the live registry (2,746 chains) and against the registry's own
Kotlin validator (`processor/src/main/kotlin/org/ethereum/lists/chains/Main.kt`):

- `chainId` **20226** — free, no collision.
- `shortName` **moli** — free, no collision.
- `name` **Molibra** — free, no collision; matches the validator's `^[a-zA-Z0-9\-.() ]+$`.
- RPC: `https://molibra.org` answers `eth_chainId` → `0x4f02` and `net_version` → `20226`
  **at the bare origin**, so the registered URL needs no path.
- `nativeCurrency` carries exactly `symbol`/`decimals`/`name`; symbol is under 7 chars.
- Explorer `standard` is `none` (the validator accepts only `EIP3091` or `none`) and the URL
  has no trailing slash (the validator rejects one).

## ⛔ Why there is no `icon` field

The validator's `processIcon()` **errors out** if a chain references an icon that has no
`_data/icons/<name>.json` entry:

    error("The Icon $it does not exist - was used in ${chainFile.name}")

and `checkIcon()` requires every icon URL to start with **`ipfs://`** — an `https://` URL is
rejected. Molibra's icon is served at `https://molibra.org/icon.svg` and is **not pinned to
IPFS**, so referencing it would have failed CI and bounced the PR.

The icon is cosmetic; the warning is about the chainId/name pair. **Ship the listing first.**
Add the logo as a follow-up PR once the SVG (or a PNG) is pinned and a CID exists — `svg`, `png`
and `jpg` are all accepted formats.

## ⛔ There are TWO registries, not one

They are separate repos with separate formats, and only the first is what the wallet reads:

| | repo | path | format |
|---|---|---|---|
| **Wallets** (MetaMask, chainid.network) | `ethereum-lists/chains` | `_data/chains/eip155-20226.json` | JSON |
| **chainlist.org** | `DefiLlama/chainlist` | `constants/additionalChainRegistry/chainid-20226.js` | `export const data = {…}` |

chainlist.org is DefiLlama's site and keeps **its own** additional registry — its README says so
in as many words. Submitting to one does not list you on the other. Both files are in this folder:
`eip155-20226.json` and `chainid-20226.js`.

Verified 5 Sep: `chainlist.org/chain/20226` answers **"nope"**, and
`additionalChainRegistry/chainid-20226.js` is a **404** — neither listing exists yet.

## `features: [{ "name": "EIP155" }]` is verified, not decorative

`src/tx.js:69` **rejects** any transaction without replay protection
(`'unprotected transaction: EIP-155 required'`) and line 71 rejects one carrying another chain's
id. So EIP-155 is not merely supported, it is mandatory. ⛔ **EIP-1559 is NOT declared**, correctly:
`baseFeePerGas` is a hardcoded `0n` stub for RPC compatibility (`src/evm.js:95`), and the chain
signs legacy type-0 transactions only.

## How to submit — ⛔ the operator must push (the disclosure guard blocks GitHub pushes from this box)

1. Fork `https://github.com/ethereum-lists/chains`.
2. Copy this file to `_data/chains/eip155-20226.json` in the fork — **the filename must be
   exactly that**.
3. Commit on a branch, push, open a PR against `master`.
4. CI runs the validator above. If it is green, a maintainer merges; `chainid.network` and
   `chainlist.org` pick it up on their next build.

Then add the network on **chainlist.org** so it is searchable there too.

## ⛔ What will NOT go away, and should not

The warning's second sentence — *"Many popular tokens use the name MOLI, which makes it a target
for scams"* — is a true statement about a shared symbol. A wallet is right to say it. The answer
is the chain being listed and findable, **not a rename**.
