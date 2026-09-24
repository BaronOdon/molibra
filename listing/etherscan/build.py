"""Build Etherscan's "Solidity (Standard-Json-Input)" files for bMOLI from Blockscout's verified record.

Blockscout verified 0xa302...6822 with a full bytecode match, so its source and
settings are exactly what compiled the deployed contract. Etherscan's form takes:
  - compiler v0.8.26+commit.8a97fa7a, licence "No License (None)"
  - standard-input.json (this script writes it)
  - constructor-args.txt (ABI-encoded, no 0x)

Run:  python build.py   (reads blockscout.json beside it)
"""
import json
from pathlib import Path

here = Path(__file__).parent
d = json.loads((here / "blockscout.json").read_text(encoding="utf-8"))
settings = d["compiler_settings"]
if isinstance(settings, str):
    settings = json.loads(settings)
std = {
    "language": "Solidity",
    "sources": {d["file_path"]: {"content": d["source_code"]}},
    "settings": settings,
}
(here / "standard-input.json").write_text(json.dumps(std, indent=2), encoding="utf-8")
(here / "constructor-args.txt").write_text(d["constructor_args"].removeprefix("0x"), encoding="utf-8")
print("compiler", d["compiler_version"], "| viaIR", settings.get("viaIR"), "| evm", settings.get("evmVersion"),
      "| optimizer", settings.get("optimizer"))
print("constructor args", len(d["constructor_args"]) // 2 - 1, "bytes")
