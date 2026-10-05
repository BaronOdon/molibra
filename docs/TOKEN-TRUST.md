# Token trust: what scanners flag, what our coins already satisfy, and what is left

Written 5 Oct 2026. Covers MOLI, bMOLI, WSRO (Coinspirit), CARAMELO, BOLSO and FAZOL.
The goal: no warning beyond the unavoidable minimum for a new token, which is
"new, little liquidity, few holders". Everything else is either already true of
the bytecode, fixable by us, or a form the operator submits
(`listing/tokens/README.md`).

**Tools**

- `node tools/token-health.mjs <address|symbol> [--chain 1] [--json]` shows the bytecode facts
  (code size, owner(), the EIP-1967 proxy slot, which privileged selectors exist),
  GoPlus `token_security` and Honeypot.is, each flag explained with its fix.
- `/molibra/token/<symbol>` re-derives the same bytecode facts in the reader's browser.
- `/tokenlist.json` is the Uniswap-standard list.
- `node tools/render-token-logos.mjs` renders the logos.

## 1. What the scanners say today (5 Oct 2026, `tools/token-health.mjs`)

### bMOLI `0xa302877efb74f567f3605851194b46f1d5746822`

| check | result | meaning | how it clears |
|---|---|---|---|
| bytecode | 5,393 bytes, **no `owner()`**, no proxy, **no** mint/pause/blacklist/fee/upgrade selector | ground truth | — |
| GoPlus `is_open_source` | 1 | Etherscan "Exact Match" (also Blockscout) | done |
| GoPlus `is_mintable` | **1 (FLAG)** | GoPlus flags *any* path that creates units. bMOLI's is `claim()/claimVia()`, which mints only against a proof of MOLI burned on Molibra | cannot change on a deployed contract (that is the point of having no owner). Explain it in the Etherscan description and ask GoPlus for manual review (texts in `listing/tokens/README.md` §3). The token page states the rule beside the live bytecode hash. |
| GoPlus proxy / owner / hidden owner / take-back / blacklist / whitelist / pause / cooldown / anti-whale / tax / selfdestruct / external call / honeypot | all 0 | — | done |
| GoPlus `is_in_dex` | 1, Uniswap v4 pool `0x200f…c312` | — | — |
| holders | 3. The PoolManager holds 99.9992% as liquidity, the vault 1, the operator dust. `creator_percent` 0 | concentration is NOT flagged: the supply is in the pool | done |
| **LP lock** | **FLAG:** all 3 position NFTs (#414183, #414300, #431583) owned by the operator wallet, `is_locked=0` | whoever holds the NFT can pull the liquidity at any moment, which is the classic rug signal | lock them (§4) |
| liquidity | GoPlus values it at $0.81; StateView `getLiquidity` = **0 in range** (the positions are asks above the current tick) | little liquidity, not a code issue | add an in-range position when the operator decides |
| Honeypot.is | `pair not found`, `GetPairs` = [] | **Honeypot.is does not index Uniswap v4 pools** (its documented pair types are V2/V3; live GetPairs for PEPE omits PEPE's v4 pool). Nothing was simulated, so this is neither a pass nor a fail | nothing to do; it clears if a v2/v3 pool ever exists. Say it on the token page if asked |
| MetaMask / Blockaid | earlier "Risky" (`listing/etherscan/README.md`) | Blockaid weighs newness, thin liquidity, deployer behaviour and unverified source | source now verified on Etherscan; send the **updated** false-positive text (`listing/tokens/README.md` §2) |

### WSRO / Coinspirit `0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8`

| check | result | meaning | how it clears |
|---|---|---|---|
| bytecode | 10,152 bytes, OpenZeppelin 5.0.2 ERC20 + Burnable + Pausable + Ownable + Permit + **FlashMint**; `owner()` = **0x0 (renounced)** | `mint` and `pause` exist but are `onlyOwner` with no owner | — |
| GoPlus `is_mintable` | **1 (FLAG)** | the `mint` selector exists | unfixable in code; GoPlus's own docs say a mint function "generally relies on ownership", and `owner_address` already reads 0x0. Manual-review text in `listing/tokens/README.md` §3 |
| GoPlus `transfer_pausable` | 0 | GoPlus already reads the renounced owner correctly here | done |
| GoPlus `is_open_source` | 1 (Etherscan Exact Match) | — | done |
| GoPlus `is_in_dex` | **0 (FLAG)** | no pool with liquidity GoPlus recognises. The v4 ETH/WSRO pool `0x0a6d…62c3` is initialised but has 0 in-range liquidity and no positions recorded; the SushiSwap pool was emptied on 5 Oct | seed an in-range position |
| **holder concentration** | **FLAG:** creator (operator wallet) holds **20,856,000 of 20,950,000 = 99.31%** | the single biggest scanner red flag ("creator holds most of the supply") | §5 distribution plan |
| `holder_count` | "0" | GoPlus's holder index for WSRO is stale/empty | clears on its next index after transfers |
| Honeypot.is | pair not found | as above: no v2/v3 pool | — |

Molibra-side coins (chain 20226) are not scanned by GoPlus, Honeypot.is,
TokenSniffer, De.Fi or Blockaid: no public scanner knows the chain. On Molibra,
trust comes from the token pages, which read the bytecode live, and from the
verified MemeToken source.

## 2. What each scanner checks

| scanner | flags | what it reads | notes |
|---|---|---|---|
| **GoPlus** (`api.gopluslabs.io/api/v1/token_security/1`) | the fields in the tables above, plus `lp_holders[].is_locked`, `holders[]`, `creator_percent`, `trust_list`, `is_in_cex` | bytecode + its own sandbox + DEX indexing. **Indexes Uniswap v4** (`liquidity_type: UniV4`, pair = poolId) | the API most wallets and bots consume. "Submit for manual review" in its console |
| **Honeypot.is** (`api.honeypot.is/v2/IsHoneypot`) | buy/sell simulation, taxes, `summary.risk` | V2/V3-type pools only | v4-only tokens get `pair not found` |
| **TokenSniffer** | 0–100 score: verified source; ownership renounced or absent; no mint; sellable, tax < 5%; adequate liquidity; **≥ 95% of liquidity locked or burned for ≥ 15 days**; **creator < 5%**; **no holder > 5%**; not a clone of a known scam | needs JS / a paid API, so not run here | v4 support and v4-lock recognition **unverified** |
| **De.Fi Scanner** | unusual minting, proxy, ownership, honeypot, permissioned functions, supply, holder concentration | — | no published dispute process |
| **Blockaid** (MetaMask) | Verified / Warning ("impersonation signals, unusual contract behaviour, spam-related distribution") / Malicious; plus Spam from airdrop history | bytecode, upgradeability, **deployer funding source**, liquidity behaviour | false-positive report at report.blockaid.io |
| **Etherscan reputation** | UNKNOWN (default) → NEUTRAL needs verified source, website, logo, email, active socials, a price-aggregator listing | the "Update Token Info" submission | free; one submission per address |
| **CoinGecko / GeckoTerminal** | GT Score: verified info, liquidity, volume, holders, socials | GeckoTerminal indexes v4 on Ethereum | CoinGecko listing needs real trading on a tracked DEX |

**Behaviours that create flags, so we avoid them:**

- No push airdrops to strangers' wallets (Blockaid "spam distribution"). Any community slice is *claimed* by the person, never pushed.
- No URL in a name or symbol (Etherscan SPAM).
- No name that copies an existing token (impersonation).
- Fund the deployer only from the operator's known wallet, never a mixer.

## 3. What our contracts already satisfy

| | MemeToken (CARAMELO, BOLSO, FAZOL) | BridgedMoli (bMOLI) | BridgedAsset (WSRO/FAZOL on Molibra) | Coinspirit (WSRO, Ethereum) |
|---|---|---|---|---|
| verified source | `contracts/MemeToken.sol`, bundle `contracts/etherscan/` | Etherscan + Blockscout ✅ | repo source | Etherscan + Blockscout ✅ |
| owner / admin / roles | **none** | **none** | none (mint = immutable keyless bridge) | renounced to 0x0 |
| proxy / upgrade | none | none | none | none |
| mint after deploy | **none**: fixed supply, minted once in the constructor | only against a burn proof | only by the bridge, only against a burn proof | `onlyOwner`, so unreachable |
| pause / blacklist / whitelist / fee / cooldown / max-tx | none | none | none | pause `onlyOwner`, so unreachable; the rest absent |
| "renounced" | **by construction**: there is nothing to renounce | by construction | by construction | renounced |

The token page states these facts **only when the deployed runtime bytecode
hashes (SHA-256, computed in the reader's browser) to the verified build**.
MemeToken has no immutables, so every MemeToken's runtime equals
`contracts/artifacts/MemeToken.json`, and the page takes the expected hash from
that artifact rather than from a copy.

## 4. Liquidity lock (Uniswap v4 positions are ERC-721 NFTs)

### Options

| | supports v4 on Ethereum | cost | recognised by scanners as "locked" | trust in a third party |
|---|---|---|---|---|
| **UNCX** (`docs.uncx.network`, locker listed at `0x147aeca171a79466fe9e2c03f21b45155ff403f8`, check it is the v4 entry before use) | yes | **0.1 ETH flat + 1% of the locked LP + 2% of collected fees, forever** | most likely (the de facto standard; DexScreener shows UNCX badges). For v4 specifically: **unverified** | UNCX's contracts |
| **GoPlus SafeToken Locker** | yes (since May 2025) | **not published** | very likely by GoPlus itself (their product); others unverified | GoPlus |
| **Team Finance** | **no** v4 (v2/v3, $150) | — | — | — |
| **PinkLock** | v4 not documented | gas only | — | — |
| **`contracts/V4PositionLocker.sol`** (ours) | yes, built for it | **gas only, ~0.0011 ETH (~$3) to deploy once, ~$0.30 per lock; no fee, ever** | **not until a scanner whitelists it**: GoPlus `is_locked` reads a list of known lockers | none: ~100 lines, no owner, verified like our other contracts |

### Our locker: `contracts/V4PositionLocker.sol`

- **Lock:** `PositionManager.safeTransferFrom(you, locker, tokenId, abi.encode(uint64 unlockAt))`. The lock is made in `onERC721Received`: only NFTs sent by the configured PositionManager are accepted, the sender becomes the beneficiary, and a date in the past is refused.
- **While locked:** `collectFees(tokenId)` sends the trading fees to the beneficiary. It does this with `DECREASE_LIQUIDITY` of **zero** and then `TAKE_PAIR`, which is how fees are collected in v4. Liquidity is never touched. `extend(tokenId, later)` only moves the date later. `setBeneficiary` hands the role on.
- **After the date:** `withdraw(tokenId)` returns the NFT to the beneficiary.
- **Absent by construction:** owner, fee, pause, upgrade, any path that decreases liquidity, any way to shorten a lock.
- **⛔ One irreversible mistake is possible:** a plain `transferFrom` (not `safeTransferFrom` with the date) records no lock and the NFT is stuck forever. The signing page must build the call, never a hand-typed one.

**Tests:** `npm test` runs `test/trust-contracts.mjs`, 39 checks on Molibra's EVM against a mock PositionManager. The mock refuses any decrease other than 0, so a locker that tried to pull liquidity out would fail its test. It covers: early withdraw reverts `StillLocked`; strangers are refused; the date never moves earlier; the beneficiary hand-off works; withdraw works at the exact second. Build with `SOLC_DIR=C:\Users\Administrator node contracts/trust-build.mjs` (solc 0.8.26, paris). The Etherscan bundle is `contracts/etherscan/V4PositionLocker.standard-input.json`.

⚠ **Unverified against the real PositionManager:** the action encoding follows
v4-periphery (`DECREASE_LIQUIDITY` 0x01, `TAKE_PAIR` 0x11, `MINT_POSITION` 0x02 and
`SETTLE_PAIR` 0x0d match the codes `memes.html` already uses successfully).
Before the first lock, run `preflight-onchain-call`: deploy, then `eth_call` a
`collectFees` against mainnet. The lock itself is only `safeTransferFrom`, so it is
safe to test with the smallest position (#414300) first.

### Recommendation

1. **Now, at today's pool sizes (bMOLI liquidity valued at $0.81):** use **our locker**. UNCX's 0.1 ETH (~$270) flat fee is hundreds of times the liquidity it would lock and 27× the operator's ETH balance (0.0037 ETH). Lock bMOLI's three positions for **12 months**. Publish the lock on the token page (it reads `locks(tokenId)` live) and send GoPlus the verified locker address for recognition.
2. **When a pool holds real liquidity (≈ $10k+)**, or when GoPlus/TokenSniffer show "not locked" for our locker after a support request: move the position to **UNCX**, the locker every scanner is most likely to recognise. Before that, ask GoPlus the SafeToken Locker fee; if it is small, it is the cheaper route to a GoPlus "locked" reading.
3. For **FAZOL**, lock the position in the same transaction set as the seed (memes page E4 → lock).

**What the operator signs (Ethereum, from `0xf51a…3F5a`), and the cost** (gas measured in the local EVM, priced at 1.35 gwei and ETH $2,700):

| step | gas | ≈ ETH | ≈ USD |
|---|---|---|---|
| deploy `V4PositionLocker(0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e)` | ~847k | 0.00114 | $3.10 |
| verify on Etherscan | — | free | — |
| lock #414183, #414300, #431583 (one `safeTransferFrom` each) | ~80k each (estimate) | ~0.0003 | ~$0.90 |
| **total, one-off** | | **~0.0015** | **~$4** |
| recurring | none; `collectFees` only when wanted (~100k gas) | | |

The address goes into `src/web/tokens/tokens.json` under `lockers["1"]`, and the
pages start reading it.

**Molibra-side pools (MolibraPool):** LP shares are a mapping with **no transfer
function**, so no external contract can hold them; locking would need a locker that
*is* the liquidity provider (adds the liquidity itself). Not built. No public scanner
reads chain 20226, and the token page states plainly that a MolibraPool has no
liquidity lock.

## 5. Holder concentration

Every scanner flags a deployer or single wallet holding most of the supply
(TokenSniffer: creator < 5%, no holder > 5%). Tokens sitting in a pool do not
count against this: bMOLI shows creator 0% because 99.999% is in the v4
PoolManager. So **the distribution plan is: put almost everything in the pool,
lock the pool, and vest the rest.** (For the Molibra memecoins: the curve's liquidity
is locked until 2026-10-26 00:00 UTC, then withdrawable by the creator; the
operator's 3,000 MOLI seed is not locked - see below.)

### FAZOL, CARAMELO and BOLSO: all Molibra-native (operator, 5 Oct 2026)

FAZOL is no longer an Ethereum token: no chain-1 deployment, no Uniswap pool, no
bridge. It is a `MemeToken` on Molibra like BOLSO and CARAMELO, with the same
distribution for all three, none of it in the creator wallet beyond 1%:

| slice | share | where |
|---|---|---|
| sale | **95%** | `contracts/MoliSaleCurve.sol`: sold for MOLI only, price from the parity to 5x; every MOLI paid goes into the coin's MolibraPool; those LP shares are held by the curve and **locked until 2026-10-26 00:00 UTC**; after that the beneficiary (the operator, immutable) may withdraw them, as protection against manipulation, not as a plan to sell. Unsold sale tokens are never withdrawable |
| pool seed | 3,000 MOLI | MolibraPool at the parity, coins taken from the 1% below. ⛔ **Not locked:** the seed's LP shares belong to the operator, who can withdraw them at any time. The curve's LP shares are locked until 2026-10-26 |
| operator reserve | **4%** | `contracts/TokenVesting.sol` (180-day cliff, linear to 720 days, no owner) |
| operations | **1%** | operator wallet |

BOLSO's on-chain name is **"Bolsonaro Meme"** (see the name-risk note below). Each
coin shows a reference pair for display only (CARAMELO-DOGE, BOLSO-TRUMP,
FAZOL-TRUMP): not a peg. Buying on `/molibra/swap` routes to the sale curve or the
pool, whichever gives more; selling always goes to the pool.

### CARAMELO and BOLSO (Molibra)

There are no scanners on chain 20226, but the same principle makes the token pages
honest. A MolibraPool is constant-product, so the seed **ratio** sets the price.
The memes deploy plan decides the seed (`seedMoli` 3,000), and that stays the
memes flow's call. If the pool holds most of the supply, the starting price is
3,000 MOLI ÷ that amount. Hold any reserve in `TokenVesting`, which runs unchanged
on Molibra's EVM (paris), not in the deployer wallet.

### WSRO (Ethereum): 99.31% in the operator wallet

The largest flag on any of our coins. Move the operator's 20,856,000 WSRO the same
way: most of it into a v4 position (locked), and a reserve into `TokenVesting`. This
is a decision about the World Spiritual Responsibility Organization's treasury, so
it is the operator's to make. Cost: `TokenVesting` deploy ~415k gas (~0.00056 ETH,
~$1.50), plus one transfer.

### Community slices / airdrops

If a community slice is wanted, do it as an **opt-in claim** (a person proves an
address and pulls), never a push to many wallets. Blockaid classifies push-airdrop
patterns as spam. Molibra already has a claim-gated airdrop (`/molibra/airdrop`,
linking proof).

## 6. Metadata and listings

Exact texts, fields and file paths: **`listing/tokens/README.md`**. In short:

| where | ready | blocked on | cost |
|---|---|---|---|
| Etherscan "Update Token Info" (bMOLI, WSRO, later FAZOL) | texts PT/EN, SVG/64 px logos | a **@molibra.org mailbox** (MX exists at IONOS, no mailbox known); the deployer's signature (bMOLI's deployer is `0x8d1f…0e14`, not the operator wallet); the site deployed with the token pages | free |
| Blockaid false positive (bMOLI) | updated text (supply 123,101; Etherscan verified) | operator's contact details | free |
| GoPlus manual review (`is_mintable`) | texts | — | free |
| CoinGecko | field list | **real trading** (pools have 0 in-range liquidity today); socials | free (Fast Pass $1,000) |
| GeckoTerminal token info | same texts and logos | trading; domain email | $199 Fast Pass |
| Trust Wallet assets | `info.json` + `logo.png` bundles | **10,000 holders + 15,000 tx**, audit, CMC listing | 500 TWT or 2.5 BNB per PR |
| Wallet logos for users today | `wallet_watchAsset` button on every token page | — | free |

## 7. The two political coins

- Both carry, on the page, in the token list (`tags: unofficial`, `extensions.unofficial`) and in their immutable on-chain `description`:
  - BOLSO: "Meme não oficial, sem vínculo com Jair Bolsonaro, sua família ou qualquer partido/campanha."
  - FAZOL: "Meme não oficial, sem vínculo com Luiz Inácio Lula da Silva nem com qualquer partido/campanha."
- **Logos** are abstract hand gestures, a matching pair: FAZOL's "L", and BOLSO's "arminha" (thumb up, index pointing). Neither has a face, a likeness, a party symbol, a flag, any text, or a realistic weapon. App stores, CoinGecko, Trust Wallet and social platforms reject weapon imagery in logos.
- ⚠ **Name risk (Blockaid "impersonation signals"):** a token whose `name()` is exactly a real person's name ("Bolsonaro") is the pattern impersonation heuristics look for. Before BOLSO is deployed (the name is immutable), consider an on-chain name like **"Bolsonaro Meme"**. The symbol stays BOLSO. "Faz o L" is a slogan, not a name, and carries less of this risk. This is a recommendation; the memes flow owns the name.

## 8. Not verified (stated, not assumed)

- Whether GoPlus, TokenSniffer or DexScreener mark a **v4** position held by UNCX (or by our locker) as locked. Test with the smallest position and re-run `tools/token-health.mjs`.
- `V4PositionLocker` against the real PositionManager (tested against a mock that enforces the same rules). Pre-flight before the first lock.
- TokenSniffer's v4 support; De.Fi's dispute process; the Blockaid form's fields; CoinGecko's minimum liquidity (its support pages returned 403); whether GeckoTerminal still has a free update path; the GoPlus locker's fee.
- Gas for a lock (`safeTransferFrom` into the locker) is an estimate; the deploy gas figures were measured.
