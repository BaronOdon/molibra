# bMOLI: Etherscan verification and the MetaMask "Risky" appeal

bMOLI: `0xa302877efb74f567f3605851194b46f1d5746822` (Ethereum mainnet)
Already verified on Blockscout with a full bytecode match. These files are generated from that record by `python build.py`.

## 1. Etherscan: about 3 minutes, no API key needed

1. Open <https://etherscan.io/verifyContract?a=0xa302877efb74f567f3605851194b46f1d5746822>
2. Fill in the form:
   - Compiler Type: **Solidity (Standard-Json-Input)**
   - Compiler Version: **v0.8.26+commit.8a97fa7a**
   - Open Source License: **No License (None)**
3. Continue. Upload **`standard-input.json`**.
4. Constructor Arguments: paste the contents of **`constructor-args.txt`** (hex, no `0x`).
5. Pass the captcha and verify.

(With a free Etherscan API key this can be scripted instead. Record any key in CREDENTIALS.md first.)

## 2. MetaMask "Risky" warning: the Blockaid false-positive report

Form: <https://report.blockaid.io/> (choose "false positive", then enter the token address).

Suggested text:

> bMOLI (0xa302877efb74f567f3605851194b46f1d5746822) is the Ethereum representation of MOLI, the native coin of the Molibra chain (chainId 20226, listed on chainid.network). Each unit is minted only against a proved burn of MOLI on Molibra, checked by the contract against an on-chain anchor. The contract has no owner, no pause, no admin mint and no fee-on-transfer, and it cannot blacklist holders. The source is verified on Blockscout with a full bytecode match. Supply today is 501, and every unit maps to a named burn. We believe the "Risky" flag is a false positive caused by the token being new and thinly traded.

⛔ Submit this only from the operator's own contact details. The form is outward-facing.
