# Token listings: what the operator submits, and the exact texts

Prepared 5 Oct 2026. **Nothing here has been submitted.** Every form below is
outward-facing, has a captcha or a login, and must go from the operator's own
accounts and contact details. Background and reasoning: `docs/TOKEN-TRUST.md`.

Logos (all transparent, all checked at 32 px and 256 px):

| file | use |
|---|---|
| `src/web/tokens/<key>.svg` | Etherscan (SVG accepted), the site |
| `src/web/tokens/<key>.png` (256×256) | Trust Wallet, the token list, wallets |
| `src/web/tokens/<key>-200.png` | CoinGecko (200×200) |
| `src/web/tokens/<key>-64.png` | Etherscan (PNG 64×64) |
| `src/web/tokens/<key>-32.png` | small lists |

`<key>` = `moli`, `bmoli`, `wsro`, `caramelo`, `bolso`, `fazol`. Once deployed, the
same files are served at `https://molibra.org/molibra/tokens/<key>.png`.

## Fields that are the same everywhere

| field | value |
|---|---|
| Website | `https://molibra.org` · token page `https://molibra.org/molibra/token/<key>` |
| Token list | `https://molibra.org/tokenlist.json` |
| Source code | `https://github.com/BaronOdon/molibra` |
| Whitepaper | `https://molibra.org/molibra/whitepaper` |
| Email | ⚠ **must be on the project domain** (Etherscan rejects free-mail). molibra.org has IONOS mail (MX `mx00/mx01.ionos.co.uk`), but no mailbox is recorded anywhere. **Create `contato@molibra.org` in IONOS first** and record it in CREDENTIALS.md. |
| Socials | none exist yet. Etherscan, CoinGecko and GeckoTerminal all score "active socials"; an X account and a Telegram group are the minimum the forms expect. Leave blank rather than invent. |

⛔ Before submitting for any token, the **site must list that token's address**:
`/molibra/token/<key>` and `/tokenlist.json` do so automatically once the address
exists. Deploy the site first, then submit.

---

## 1. Etherscan: "Update Token Info"

<https://etherscan.io/tokenupdate>. Free (7–10 business days); Priority Support
is paid. Requirements: verified source (bMOLI ✅, WSRO ✅, both "Exact Match"
on 5 Oct 2026; FAZOL after its verification, `contracts/etherscan/FAZOL.verify.json`),
an ownership signature from the **deployer** address (the form asks you to sign a
message with the deployer: bMOLI was deployed by `0x8d1f2713…0e14`, WSRO and FAZOL by
the operator wallet `0xf51a…3F5a`), and a working site that shows the address.
One submission per address; it cannot be edited afterwards, so check twice.

⚠ **bMOLI's deployer is `0x8d1f2713eb83e4d55fbeda47b26fd08ec9170e14`**, not the
operator wallet (GoPlus `creator_address`). Etherscan's ownership check signs with
the deployer or the owner; bMOLI has no owner. Whoever holds that key signs.

### bMOLI

- Project name: Molibra · Token name: Bridged MOLI · Symbol: bMOLI · Decimals: 18
- Sector: Bridge / Layer 1
- Description (EN, neutral, as Etherscan asks):
  > bMOLI is MOLI, the native coin of the Molibra proof-of-work chain (chain ID 20226), on Ethereum. Each unit is minted only by claim()/claimVia() against a proof of MOLI burned on Molibra, checked against an Ethereum anchor; bMOLI sent to the keyless vault 0x0173f059ce912bb442296f3763746637f7d20fc1 returns as MOLI on Molibra. The contract has no owner, no proxy, no pause, no blacklist and no transfer fee.
- Descrição (PT):
  > bMOLI é o MOLI, moeda nativa da rede Molibra (prova de trabalho, chain ID 20226), na Ethereum. Cada unidade só é emitida por claim()/claimVia() contra a prova de MOLI queimado na Molibra, conferida contra uma âncora na Ethereum; bMOLI enviado ao cofre sem chave 0x0173f059ce912bb442296f3763746637f7d20fc1 volta como MOLI na Molibra. O contrato não tem dono, proxy, pausa, lista negra nem taxa de transferência.
- Logo: `src/web/tokens/bmoli.svg` (or `bmoli-64.png`)

### WSRO

- Project name: World Spiritual Responsibility Organization · Token name: Coinspirit · Symbol: WSRO · Decimals: 18
- Description (EN):
  > Coinspirit (WSRO) is the coin of the World Spiritual Responsibility Organization, co-author of the Molibra chain. It is an OpenZeppelin 5.0.2 ERC-20 whose ownership has been renounced: the mint and pause functions exist in the code but can no longer be called by anyone. On Molibra it circulates as a bridged asset, 1:1 against WSRO burned on Ethereum.
- Descrição (PT):
  > Coinspirit (WSRO) é a moeda da World Spiritual Responsibility Organization, coautora da rede Molibra. É um ERC-20 OpenZeppelin 5.0.2 com a propriedade renunciada: as funções mint e pause existem no código, mas ninguém pode mais chamá-las. Na Molibra circula como ativo de ponte, 1:1 contra WSRO queimado na Ethereum.
- Logo: `src/web/tokens/wsro.svg`

### FAZOL (after deployment and verification)

- Token name: Faz o L · Symbol: FAZOL · Decimals: 18 · Sector: Meme
- Description (EN):
  > FAZOL is an unofficial meme coin inspired by the popular Brazilian slogan "Faz o L". It is not affiliated with or endorsed by Luiz Inácio Lula da Silva or any party or campaign. Fixed supply minted once in the constructor; no owner, no mint, no pause, no blacklist, no transfer fee. No promise of value.
- Descrição (PT):
  > FAZOL é uma memecoin não oficial, inspirada no bordão popular "Faz o L". Meme não oficial, sem vínculo com Luiz Inácio Lula da Silva nem com qualquer partido/campanha. Oferta fixa emitida uma única vez no construtor; sem dono, sem mint, sem pausa, sem lista negra, sem taxa de transferência. Nenhuma promessa de valor.
- Logo: `src/web/tokens/fazol.svg`

---

## 2. Blockaid (MetaMask's "Risky"/"Malicious" label) - false-positive report

<https://report.blockaid.io/> → false positive → token address. Or, in MetaMask,
"See details → Report an issue". Text for bMOLI, **updated** from
`listing/etherscan/README.md` (that text says supply 501 and Blockscout only; both are
now out of date):

> bMOLI (0xa302877efb74f567f3605851194b46f1d5746822, Ethereum) is the Ethereum representation of MOLI, the native coin of the Molibra chain (chainId 20226, listed in ethereum-lists/chains). Each unit is minted only against a proved burn of MOLI on Molibra, checked by the contract against an on-chain anchor. The contract has no owner, no proxy, no pause, no admin mint, no blacklist and no fee on transfer. Source verified on Etherscan (Exact Match) and Blockscout. Supply on 5 Oct 2026: 123,101 bMOLI, of which 123,100 sit in the Uniswap v4 PoolManager as liquidity. Token page with live on-chain facts: https://molibra.org/molibra/token/bmoli. We believe the flag is a false positive caused by the token being new and thinly traded.

Same structure for WSRO (owner renounced, verified, `https://molibra.org/molibra/token/wsro`).

---

## 3. GoPlus - feedback / manual review

GoPlus console → token page → "Feedback Center" → "Submit for manual review"; or
Telegram @Goplusservice. The one flag GoPlus raises on **both** coins that the code
answers is `is_mintable=1`:

> bMOLI 0xa302877efb74f567f3605851194b46f1d5746822: is_mintable=1. The only path that creates units is claim()/claimVia(), which mints solely against a cryptographic proof of MOLI burned on the Molibra chain, verified on-chain against an anchor contract. There is no owner and no role that can mint at will. Verified source: https://etherscan.io/address/0xa302877efb74f567f3605851194b46f1d5746822#code

> WSRO 0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8: is_mintable=1. mint(address,uint256) is onlyOwner and owner() is 0x0000000000000000000000000000000000000000 (renounced), as GoPlus itself reports in owner_address. Nobody can call it.

Also ask GoPlus to recognise the locker once deployed (section "Liquidity lock" in
`docs/TOKEN-TRUST.md`) - give them its verified address.

---

## 4. CoinGecko - listing request

Footer of coingecko.com → "Request Form". **Free**; Fast Pass $1,000 (not
recommended). ⛔ **Do not apply yet:** CoinGecko lists a token that is *actively
trading on an exchange it tracks*. bMOLI and WSRO pools had **zero in-range
liquidity and no volume** on 5 Oct 2026 (StateView `getLiquidity` = 0), so the
request would be rejected and a rejection is remembered. Apply once a pool has
in-range liquidity and real trades.

Fields to have ready: name, symbol, contract (Ethereum), decimals 18, explorer
link, website, whitepaper, GitHub, socials (missing - see top), circulating and
total supply (read them on the token page), logo 200×200 (`<key>-200.png`),
the descriptions from section 1, and the trading pool: Uniswap v4,
GeckoTerminal pool pages
`https://www.geckoterminal.com/eth/pools/0x200f192a14c85d09943f76ae3def3ffe596d93594b6d8ab55b99cdf612b4c312` (bMOLI) and
`…/0x0a6dc02a1171887ace334623cff297e0aab91d90a2a2ea7973503200896562c3` (WSRO).

---

## 5. GeckoTerminal - "Update token info"

<https://www.geckoterminal.com/update-token-info>. GeckoTerminal already indexes
the bMOLI v4 pool. The update form shows **Fast Pass $199 per request** (paid in
crypto, < 24 h); whether a free path still exists was not verifiable on 5 Oct 2026.
It needs the verified contract, the information visible on the official site, and
an email OTP (domain email above). Same texts and logos as section 1. Worth paying
only once there is trading to show.

---

## 6. Trust Wallet - assets repository

Bundles ready in `listing/tokens/trustwallet/blockchains/ethereum/assets/<ChecksumAddress>/`
(`info.json` + `logo.png`, 256×256, < 100 kB) for bMOLI and WSRO.

⛔ **They do not qualify today and should not be submitted:** Trust Wallet requires
**10,000 holders and 15,000 transactions**, an audit, a CoinMarketCap listing, and
charges **500 TWT or 2.5 BNB per pull request**, non-refundable; "brand new tokens
are not accepted". Keep the bundle for later.

Nothing is needed for a user to *see* the logo in Trust Wallet or MetaMask today:
the "Adicionar à carteira" button on each token page sends `wallet_watchAsset`
with `https://molibra.org/molibra/tokens/<key>.png`.
