# Listing Molibra in the canonical chain registries

## Status

| | | |
|---|---|---|
| **`ethereum-lists/chains` #8674** | ✅ **MERGED** 6 Sep 2026 19:48 UTC | [PR](https://github.com/ethereum-lists/chains/pull/8674) |
| **`ethereum-lists/chains` #8680** | 🟢 open, CI green — adds the icon, marks the explorer EIP-3091 | [PR](https://github.com/ethereum-lists/chains/pull/8680) |
| **`DefiLlama/chainlist` #3125** | 🟢 open, `validate` green — this is chainlist.org | [PR](https://github.com/DefiLlama/chainlist/pull/3125) |

Submitted 5 Sep 2026 from **[BaronOdon](https://github.com/BaronOdon)**; forks live at
[BaronOdon/chains](https://github.com/BaronOdon/chains) and
[BaronOdon/chainlist](https://github.com/BaronOdon/chainlist).
**#8674 was approved by [ligi](https://github.com/ligi)** and merged through the repo's merge
queue — under 36 hours from submission.

**Molibra is published.** Live in the aggregate the wallets read:

- [`_data/chains/eip155-20226.json` on master](https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/chains/eip155-20226.json)
- [`chainid.network/chains_mini.json`](https://chainid.network/chains_mini.json) — chainId `20226`
  present, 2,750 chains as of 7 Sep 2026

## Why this mattered

MetaMask showed **"Isto é um possível golpe / This is a possible scam"** on the Molibra network
because it could not match the pair (chainId `20226`, name `Molibra`) against the canonical chain
list. A **registration gap, not a defect** — nothing about the node, the site, the certificate or
the contracts was wrong.

⚠ Merging #8674 removes the *cause*. How fast a given wallet stops showing the warning depends on
when it refreshes its copy of that list, which is **not verified here** — do not promise a date.

## ⛔ There are TWO registries, not one

Separate repos, separate formats. Only the first is what a wallet reads:

| | repo | path | format |
|---|---|---|---|
| **Wallets** (MetaMask, chainid.network) | [`ethereum-lists/chains`](https://github.com/ethereum-lists/chains) | `_data/chains/eip155-20226.json` | JSON |
| **chainlist.org** | [`DefiLlama/chainlist`](https://github.com/DefiLlama/chainlist) | `constants/additionalChainRegistry/chainid-20226.js` | `export const data = {…}` |

chainlist.org is DefiLlama's site and keeps **its own** additional registry — [its README says so
in as many words](https://github.com/DefiLlama/chainlist?tab=readme-ov-file#add-a-chain).
Submitting to one does not list you on the other. Both files are in this folder.

## ⛔ Contributor status — the thing that silently gates a first PR

On a **first** contribution to a repo, GitHub holds every workflow at **`action_required`** until a
maintainer approves the run. It is **not a failed check**, there is nothing to fix, and **pushing
more commits does not release it**.

That matters here more than usual, because `ethereum-lists/chains` posts an automated comment
saying they will only look at PRs whose CI is green — so a first-time PR can sit in a deadlock
where nobody looks at it *because* nobody approved the run that would make it green.

**Observed, both ends:**

- **#8674** (first PR from this account) — `build`, `prettier`, `validate_json` and `actionlint`
  all sat at `action_required` for ~2 hours until a maintainer released them. All passed.
- **#8680** (after #8674 merged) — every check ran **automatically**, no approval needed.

So the gate is one-time per repo. Watch it with:

```
gh pr checks <number> --repo <owner>/<repo>
gh api "repos/<owner>/<repo>/actions/runs?per_page=30" \
  --jq '.workflow_runs[] | select(.head_branch=="<branch>") | "\(.name) \(.status) \(.conclusion)"'
```

The second command is the one that distinguishes *held* from *failed* — `gh pr checks` shows a
held run as simply absent.

## What was verified before submitting

Against the live registry and the registry's own Kotlin validator
([`processor/src/main/kotlin/org/ethereum/lists/chains/Main.kt`](https://github.com/ethereum-lists/chains/blob/master/processor/src/main/kotlin/org/ethereum/lists/chains/Main.kt)):

- `chainId` **20226**, `shortName` **moli**, `name` **Molibra** — each checked against all 2,746
  chains then published; no collision. Their README requires `shortName` and `name` to be unique
  (EIP-3770).
- RPC `https://molibra.org` answers `eth_chainId` → `0x4f02` and `net_version` → `20226`
  **at the bare origin**, so the registered URL needs no path.
- `nativeCurrency` carries exactly `symbol`/`decimals`/`name`; symbol under 7 chars.
- Explorer URL has no trailing slash (the validator rejects one), and `standard` is one of the two
  values it accepts.
- Passes `prettier --check` against [their `.prettierrc.json`](https://github.com/ethereum-lists/chains/blob/master/.prettierrc.json)
  (`trailingComma: es5`, `tabWidth: 2`, `semi: false`, `singleQuote: false`) — one of the two gates
  their README names.
- The other gate is `./gradlew run` before submitting. Not run here (no JDK on this box); every
  rule it applies was read out of `Main.kt` and checked by hand instead.

⛔ **The first PR gets the chainId** — a later PR claiming 20226 gets closed. Submitting is also
what reserves it.

## `features: [{ "name": "EIP155" }]` is verified, not decorative

`src/tx.js:69` **rejects** any transaction without replay protection
(`'unprotected transaction: EIP-155 required'`) and line 71 rejects one carrying another chain's
id. EIP-155 is not merely supported here, it is mandatory. ⛔ **EIP-1559 is deliberately NOT
declared**: `baseFeePerGas` is a hardcoded `0n` stub for RPC compatibility (`src/evm.js:95`) and
the chain signs legacy type-0 transactions only.

## The icon: why it was left out, and how it got back in

The validator does not take the `icon` field on trust. `processIcon()` fails the build unless
`_data/icons/<name>.json` ships **in the same PR**:

    error("The Icon $it does not exist - was used in ${chainFile.name}")

and `checkIcon()` accepts **`ipfs://` only** — an `https://` URL is rejected outright. Their README
adds that the CID *"MUST be retrievable via `ipfs get` — not only through some gateway (means
please do not use pinata for now)"*, and that the file must be under 250kb.

At the time of #8674 the icon was an unpinned `https` SVG, so the field was **dropped** rather than
bounce the PR — the warning was about the chainId/name pair, not the logo.

It is pinned now, on our own IPFS node (Oracle instance, public IP, so DHT-reachable), and shipped
in **#8680**:

```
ipfs://QmQsqJ2omWZX8TYtft1euNVB8qcQvU8sZUYKRV9SgPuiRc      935-byte SVG, 64×64
```

**SVG rather than the PNG** deliberately: 935 bytes against 19KB distributes far more reliably, and
the validator accepts `svg` equally. The PNG lives where raster actually matters — the wallet's
EIP-3085 `iconUrls` and the share card.

Retrievability is verified rather than assumed: [ipfs.io](https://ipfs.io/ipfs/QmQsqJ2omWZX8TYtft1euNVB8qcQvU8sZUYKRV9SgPuiRc)
and another public gateway both returned the exact 935 bytes minutes after the CID first existed —
neither is ours, so the content genuinely left the node.

⛔ Keep the daemon running. An unreachable pin makes the registry entry point at nothing.

## The explorer standard changed, and only after the site earned it

#8674 declared `"standard": "none"`, which was **true at the time** — Moliscan answered 404 on
`/tx/`, `/address/` and `/block/`. #8680 changes it to `"EIP3091"`, which is true now:

- <https://molibra.org/molibra/moliscan/block/1>
- <https://molibra.org/molibra/moliscan/address/0x5851cc5884313f7a66697dE3Bb772466dD5895c7>

⛔ **The order is not optional.** A registry read by wallets that claims EIP-3091 against a site
which 404s hands every user a dead "view on explorer" link — worse than the `none` it replaces.
`followup-icon-and-eip3091.sh` **enforces** this: it checks all three paths on the live site and
aborts unless each returns 200. It was observed refusing before the deploy, which is the point.

## How to submit

Both registries, one pass — fork, branch, copy, PR:

```
bash listing/list-the-chain.sh
```

The follow-up, for a chain already merged:

```
bash listing/followup-icon-and-eip3091.sh
```

That one starts from current upstream `master`, diffs our file against theirs minus the two changed
fields, and **stops if anything else has moved** — so a maintainer's edit cannot be clobbered by a
blind copy.

By hand it is the same four steps per registry: fork, copy the file to the path in the table above
under **exactly** that filename, commit on a branch, open a PR against the default branch.

## ⛔ What will NOT go away, and should not

The warning's second sentence — *"Many popular tokens use the name MOLI, which makes it a target
for scams"* — is a true statement about a shared symbol. A wallet is right to say it. The answer is
the chain being listed and findable, **not a rename**.
