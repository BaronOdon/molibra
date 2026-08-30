# Running a public Molibra node

Anyone may run one. Nothing here is privileged, and a node holds **no credential**: mining needs
the miner's *address*, never a key.

Written against an **Oracle Cloud Always Free** instance (ARM Ampere A1), which is what the
project's own first public node runs on — but nothing below is Oracle-specific except §2.

---

## 0. What a public node must NOT enable

⛔ **Never pass `--treasury` or `--chalk` to a node exposed to the internet.**

Those flags enable `POST /molibra/airdrop`, `/molibra/earn` and `/molibra/grant`, which **hand
out value** to whoever asks. On a private node that is the point; on a public one it is a faucet
for strangers, drained within hours.

Everything else served on `0.0.0.0` is appropriate and necessary:

| Route | Why it is fine, and required |
|---|---|
| `POST /molibra/submit-block` | how peers replicate; refusing it means not participating |
| `POST /molibra/submit-tx` | how anyone broadcasts a transaction |
| `POST /molibra/announce` | how a joiner asks to be pushed to. **Capped at `MAX_PEERS = 64`** |
| `eth_sendRawTransaction` | an ordinary public-chain RPC |
| all `GET /molibra/*` | the audit surface — the entire purpose of the chain |

---

## 1. Get the code

```bash
git clone https://github.com/BaronOdon/molibra.git
cd molibra
npm ci --omit=dev
npm test          # 408 checks. Run them; do not take anyone's word for it
```

Two dependencies, no build step, no compiler.

---

## 2. Oracle Cloud — the two gotchas that cost an afternoon

⛔⛔ **Oracle has TWO firewalls, and opening one is not enough.** This is the single most common
reason a port looks closed on a correctly configured instance.

**(a) The VCN Security List / Network Security Group** — in the Oracle console:
`Networking → Virtual Cloud Networks → your VCN → Security Lists → Default`
Add an **Ingress Rule**: source `0.0.0.0/0`, IP protocol `TCP`, destination port `8545`.

**(b) The instance's own firewall** — Oracle Linux images ship `firewalld`, and Ubuntu images
ship iptables rules that **drop everything except SSH**, applied before your first login:

```bash
# Oracle Linux / RHEL family
sudo firewall-cmd --permanent --add-port=8545/tcp && sudo firewall-cmd --reload

# Ubuntu images: the rules are in iptables, NOT ufw. Editing ufw does nothing.
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8545 -j ACCEPT
sudo netfilter-persistent save
```

⚠ **The instance is ARM (aarch64).** `node:22-alpine` publishes `linux/arm64`, so the Dockerfile
builds unmodified — but any tool you add must too.

⚠ **Always Free instances are reclaimed when idle.** Oracle reclaims Always Free compute that
stays under ~15% CPU for 7 days. A non-mining node is nearly idle. Either run it with `--mine`,
or accept that it may be reclaimed and plan to restart it.

---

## 3. Run it — containers

```bash
docker compose -f deploy/docker-compose.public.yml up -d --build
curl localhost:8545/molibra | head
```

The chain state lives in a named volume, never in the image.

## 3b. Run it — no Docker

Equally valid, and how the project's first node started, because the software needs nothing a
container provides:

```bash
sudo cp deploy/molibra.service /etc/systemd/system/
sudo sed -i "s|__USER__|$USER|; s|__DIR__|$PWD|" /etc/systemd/system/molibra.service
sudo systemctl daemon-reload && sudo systemctl enable --now molibra
journalctl -u molibra -f
```

---

## 4. Joining the network

```bash
--peers http://<some-node>:8545
```

The node then **polls that peer every 10 seconds** (`--sync-interval` to change) and announces
itself so blocks are pushed back.

⛔ **This is not optional decoration.** Before 30 Aug 2026 a joining node synced once at startup
and then froze forever — it *looked* joined while mining a fork nobody would accept, and the
whole test suite passed. If you are running a build older than `b168c68`, you are not following
the chain. Check:

```bash
grep -c startSyncing src/node.js     # must be 1, not 0
```

---

## 5. Confirm it actually works

Do not trust the process being up. A node that answers but does not follow the chain is worse
than one that is down, because it looks fine.

```bash
curl -s localhost:8545/molibra        | grep -E '"height"|"totalDifficulty"'
curl -s localhost:8545/molibra/peers
sleep 60
curl -s localhost:8545/molibra        | grep '"height"'   # must have MOVED
```

If the height does not move while a peer's does, you are not syncing.

---

## 6. TLS

The node speaks plain HTTP by design — one job, no certificate handling. Put a reverse proxy in
front for a public hostname:

```
# Caddy: two lines, certificates handled automatically
node.example.com {
    reverse_proxy 127.0.0.1:8545
}
```

Then set `BIND=127.0.0.1` in `.env` (or bind the process to `127.0.0.1`), so only the proxy can reach it, and
**remove the `8545` ingress rule from §2** — leaving it open would bypass the proxy entirely.
