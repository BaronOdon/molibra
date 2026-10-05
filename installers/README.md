# Molibra Miner installers

One-click installers that run a Molibra node and mine MOLI to a wallet.
Download: **https://molibra.org/download** (Windows `.exe`, Mac `.pkg`).

| Folder | What |
|---|---|
| `launcher/` | `molibra-miner.mjs` (supervisor: config, wallet creation, self-update), `status.html`, and **`LEIA-ME.txt`**, the read-me shipped inside both installers |
| `windows/` | Inno Setup script (`molibra-miner.iss`), `build.ps1`, encoding guard |
| `mac/` | `build-mac.sh` (Developer ID signed and notarized `.pkg`), `postinstall`, uninstaller |
| `app/windows/` | the native "Molibra Miner" window |

## Where an installation lives

| System | Folder |
|---|---|
| Windows | `%LOCALAPPDATA%\Molibra` |
| Mac | `~/Library/Application Support/Molibra` |

`config.json` holds the mining address. If no address was given at install time,
a new wallet is created and its key is written to **`MY-WALLET-KEEP-SECRET.txt`**
in that folder, readable only by that user. The key never leaves the machine;
uninstalling keeps it.

**Recovering that wallet:** see [`docs/RECUPERAR-CARTEIRA.md`](../docs/RECUPERAR-CARTEIRA.md)
(Portuguese, with an English summary) or the shipped `LEIA-ME.txt`.

## What the installer ships to the user

- the miner, its window and a desktop / Start-menu shortcut;
- `LEIA-ME.txt` (PT + EN): where the files are, how to back up and import a
  created wallet, and how to mine to your own address. On Windows it is also in
  the Start menu as "Leia-me - carteira e backup"; on Mac it is copied next to
  the uninstaller in Applications and into the install folder.
