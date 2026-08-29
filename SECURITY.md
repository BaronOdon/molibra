# Security policy

## Reporting a vulnerability

Report privately, not in a public issue. Use GitHub's **Report a vulnerability** button under
the Security tab of this repository, which opens a private advisory visible only to the
maintainers.

Please include what you did, what happened, and what you expected. A proof of concept against
your own local node is the most useful thing you can send. Give us a reasonable window to fix
it before publishing.

Molibra is an experimental network. There is no bug bounty.

## What is in scope

- Consensus faults: a block that one node accepts and another rejects, or a way to make a node
  adopt a chain with less cumulative work.
- State faults: a transaction sequence that mints, destroys or moves value against the rules;
  a way to make two nodes derive different state from the same blocks.
- Signature and replay faults: anything that lets a transaction be replayed on another chain,
  or here from another chain, despite EIP-155.
- Expression faults: any way to record a second expression from one wallet on one question, or
  to recover the content of a commitment before it is revealed.
- Anything that causes a node to disclose a private key, or to write one anywhere but the
  operator's own datadir.

## Known and accepted limitations

These are documented, not defects. Please do not report them as vulnerabilities — but do
report anything that makes one of them *worse* than described.

- **No coercion resistance.** An expression is individually verifiable, which means the person
  who made it holds a receipt and can prove to a third party how they expressed themselves.
  That enables vote-buying and coercion. It is the most serious open problem in the design and
  is discussed in [WHITEPAPER.md](WHITEPAPER.md) §8.
- **Peering is HTTP push and pull, not a hardened gossip protocol.** It suits a known set of
  nodes. It is not yet a hostile-network protocol, and it has no peer reputation, no rate
  limiting worth the name, and no eclipse-attack resistance.
- **Proof of work at a small network size is cheap to out-hash.** Cumulative-difficulty fork
  choice is correct; it is also exactly why the peer set matters while the network is small.
- **`stateRoot` is not a Merkle-Patricia root**, so there are no light-client or inclusion
  proofs. See [README.md](README.md), "Scope".
- **Every block keeps its post-state in memory.** Fine at this scale, unsuitable for a chain
  with years of history.

## Key handling, for anyone running a node

The node writes a private key to `<datadir>/treasury.key` when the treasury is enabled, and
`molibra keys` prints one to your terminal. Both are secrets.

`data/`, `data-*/` and `*.key` are in `.gitignore` for exactly this reason. If you fork this
repository, keep them there. A private key committed to a public repository should be treated
as compromised the moment it is pushed — rotate it rather than deleting the commit, because
the deletion does not un-publish it.
