# Contributing to Molibra

## Before anything else

**Never commit a private key, a datadir, or a `.env`.** `data/`, `data-*/` and `*.key` are in
`.gitignore` — leave them there. A key pushed to a public repository is compromised the moment
it lands; rotate it, do not try to delete the commit.

## Getting a node running

```bash
npm install          # two dependencies, no build step
npm test             # 130 checks, all of which must pass
node src/cli.js keys # a fresh keypair — the private key never leaves your machine
node src/cli.js node --port 8545 --miner 0xYourAddress --mine
```

Node 20 or newer.

## What changes are easy to accept

Bug fixes with a failing test that the fix turns green. Documentation that corrects something
untrue. Anything from the open-problems list in [WHITEPAPER.md](WHITEPAPER.md) §8, discussed in
an issue first — those are design questions, not tickets.

## What changes need a conversation first

**Consensus-affecting changes.** Anything touching block validation, the state root, difficulty
retargeting, fork choice or the transaction format changes what nodes agree on. An honest
mistake here splits the network. Open an issue describing the rule change and what happens to
nodes that have not upgraded.

**These parameters are fixed and will not be changed:**

| | |
|---|---|
| Chain ID | `20226` — changing it invalidates every signed transaction and forces a network reset in every wallet |
| Coin symbol | `MOLI` |
| Genesis `extraData` | The sealed attribution. It is immutable by design |

**GIZ must stay non-transferable.** This is not a preference. The whole argument in
[WHITEPAPER.md](WHITEPAPER.md) §5 — that nothing of economic value attaches to expressing a
preference — rests on it having no market and therefore no price. A patch making it
transferable will be declined regardless of how it is implemented.

## House style

The code is plain modern JavaScript, ESM, no build step, no transpiler, and two runtime
dependencies. Keep it that way; a dependency is a permanent liability in something people are
asked to run and audit.

Comments explain **why**, not what. If a line encodes a decision — especially one that was got
wrong once — say so in the comment. Several already do, and they are the most valuable lines in
the repository.

Match the surrounding code. There is no linter to argue with.

## Tests

`test/run.js` is a single acceptance suite that runs real nodes, signs real transactions with
real keys, and checks real receipts. It is deliberately not a pile of mocks: the point is to
prove the wallet path works, not to assert that it does.

Add checks in the same style. **A green suite is not evidence that your change works** — start
a second node against a running one, let it sync, let it mine, and confirm both converge. That
scenario was completely broken once while the whole suite passed.

## Reporting a security issue

Privately. See [SECURITY.md](SECURITY.md).

## Licence

Contributions are accepted under the Apache License 2.0, the licence this project is
distributed under. By opening a pull request you confirm you have the right to contribute the
code and agree to license it on those terms.
