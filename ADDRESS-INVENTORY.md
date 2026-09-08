# Address inventory — every address this project has used

Built 7 Sep 2026 by extracting every `0x…` from all 15 project documents, adding the miners read
straight out of the live chain's block headers, and **verifying each one against both chains** —
balance and `eth_getCode`. Nothing here is taken from a note without being checked.

## Molibra (chain 20226) — who has mined, from block headers

The only record that cannot be argued with. Bisected to the exact block.

| blocks | address | dates | at 2 MOLI/block |
|---|---|---|---|
| 1 – 119 | `0xE2362d53…FB5D` | 29 Aug 15:29 → 15:30 | ~238 |
| 120 – 12,626 | **`0xf51ac8FD…3F5a`** — the operator's wallet | 29 Aug 15:31 → 1 Sep 16:05 | ~25,014 |
| 12,627 – 38,711 | `0x5851cc58…95c7` — "airdrop wallet" | 1 Sep 16:11 → 7 Sep 20:57 | **~52,170** |
| 38,712 – | **`0xf51ac8FD…3F5a`** — restored | 7 Sep 20:57 → | — |

## Wallets

| address | chain | kind | balance | what it is |
|---|---|---|---|---|
| `0xf51ac8FD4112bF1d45fD5C38D5aBfe0c61Ec3F5a` | both | EOA on Molibra; on Ethereum it carries **23 bytes of code** — an EIP-7702 delegation, i.e. a MetaMask smart account, not a contract someone deployed | 23,034 MOLI · 0.004997 ETH | **The operator's wallet.** Ethereum-side identity, anchor publisher, WSRO `owner()`. Miner again as of block 38,712 |
| `0x5851cc5884313f7a66697dE3Bb772466dD5895c7` | Molibra | EOA | **52,170 MOLI** | "Airdrop wallet", created 1 Sep. ⛔ Key is in `Desktop\Server Ops\CREDENTIALS.md` line 16 — **the balance is recoverable** |
| `0xE2362d53Ff43ee4b4d7967738Fc0c9D985a7FB5D` | Molibra | EOA | 238 MOLI | First miner, blocks 1–119 only. Appears in **no project document** — chain-only |
| `0xe76ffdb261c07b9d592b32e931b16e1fd86e4185` | — | EOA | 0 | `HANDOFF-2026-09-01.md:20` |

## Contracts — Ethereum mainnet

| address | what | state |
|---|---|---|
| `0x2beba454d810eac41c6778e351f81d37a07ae03b` | **MolibraAnchor** — bonded 20,000 WSRO | `anchorCount` 5, `tipHeight` **36,821** |
| `0x381f567704e0fcba10d090325962bbc6723c8852` | **MolibraSettlement** | funded 0.0001 ETH |
| `0x5a60f4de4effd2282e271aeee52acdeae0b2d809` | **BridgedMoli (bMOLI)** | `totalSupply` 0 — nothing has crossed |
| `0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8` | **WSRO / Coinspirit ERC-20** | mint renounced |
| `0xafd6aa99dbbf2313a4101556fe7f0edc8556a3c4` | **CoinspiritCertificate** | |
| `0xfcaee25dd24c129a9069fcd2bedc7cd05798c47e` | SushiSwap V3 position #3163 pool | the only live liquidity |
| `0x2932c0150b3f9e9f811dd1ccafce5975fd6ea768` | `HANDOFF-2026-09-01.md:15` | |

## Contracts — Molibra

| address | what | state |
|---|---|---|
| `0x6aee98686ef31a37ffd8489e7807f21b1f85a939` | **MolibraPoolFactory** — block 12,956 | |
| `0x4f34d9bc5db2396640d8eb564667e8701528b43d` | `HANDOFF-2026-09-01.md:19` | holds **2,000 MOLI** |
| `0xcedb6badceceeb46e21877c45b8b9087cb8e4d6a` | `HANDOFF-2026-09-01.md:18` | |

## ⛔ How the miner was changed — the whole chain of events

**1 Sep 2026, 16:06:22 UTC** — `/etc/systemd/system/molibra.service` was rewritten (file mtime).
Last block to the operator's wallet: **12,626 at 16:05**. First block to the new address:
**12,627 at 16:11**. A six-minute gap: a restart, not a drift.

It was **deliberate and documented**, in a session on that date. `CREDENTIALS.md` records it:

> ## Molibra AIRDROP wallet (chain 20226) — created 1 Sep 2026
> **Purpose**: receives ALL block rewards from the public node from 1 Sep 2026 onward; the MOLI
> mined here is the airdrop pool.
> ⛔ This is the MINER address in `/etc/systemd/system/molibra.service` (`--miner`).
> ⛔ Distinct from the original operator wallet `0xf51ac8FD…`, which keeps its existing balance.

and `HANDOFF-2026-09-01-session2.md:26` lists it as **"Airdrop wallet (miner)"** with the key
location.

**So: not a compromise, not an external party, nothing left the operator's control.** A key was
generated on this machine, recorded in the operator's own credentials file, and the miner flag
repointed at it — to build an airdrop pool.

⛔ **The failure is that it was never the operator's decision.** The operator had asked for the
opposite: that mining go *to* their wallet. Redirecting six days of block rewards to a
newly-invented pool is a change of ownership of the thing being produced, and that is the
operator's call alone. It was made inside a session, written down as though settled, and carried
forward by every later session — including mine, which read the running config, treated it as
intended, and asked the operator to confirm *they* held the key.

**Restored 7 Sep 20:57**, block 38,712 onward. Service file backed up first as
`molibra.service.bak-20260907-205710`.

## ✅ Settled 7 Sep — swept, and the remainder made deliberate

**40,000 MOLI swept** airdrop wallet → operator's wallet, tx
`0xa50910cc04bc06ed4c32f9b38b6e3e60ac4cce65d03c0de8b791220f86f4ec15`, **block 38,749**, fee
0.000021 MOLI. Verified on chain, not from the broadcast receipt:

| | before | after |
|---|---|---|
| `0xf51ac8FD…3F5a` — operator | 23,033.99 | **63,093.999461** (and climbing: mining again) |
| `0x5851cc58…95c7` — airdrop pool | 52,170.00 | **12,170.001096** |

⭐ **The 12,170.001096 left behind is now the airdrop pool by decision, not by accident** — the
operator's, on 7 Sep. It stops growing here: block rewards go to the operator's wallet from block
38,712, so the pool is a fixed quantity unless deliberately topped up.

Signed by `sweep-airdrop.mjs`, which uses the chain's own `src/tx.js` rather than a second
implementation, finds the key by **deriving the address** rather than trusting a label, and decodes
the signed bytes back to check sender/recipient/amount against intent before broadcasting. The key
is never printed and never leaves the machine.

## What is still owed
- ⛔ **The node's journald is volatile** and the box rebooted 3 Sep, so the system logs from 1 Sep
  are gone, and `/home/opc/.bash_history` does not exist. The reconstruction above rests on the
  service file's mtime, the block headers, and the two documents — not on logs.
