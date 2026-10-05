# Hardening deploy notes

Suggestions to apply by hand on each public node. Nothing here is applied
automatically, and nothing here is a secret: the repository is public, so
host names, addresses and keys stay out of this file. Replace the
`<placeholders>` on the host.

Apply to **node 2 first**, check it, then node 1.

## 1. Node heap: systemd drop-in

The node holds the whole chain in memory and `persist()` serialises it (about
100 MB on node 1). The default V8 old-space limit can be hit under load before
the host runs out of RAM. Raise it explicitly, and keep it well below the
host's physical RAM so the kernel OOM killer is not what stops the process.

```sh
sudo mkdir -p /etc/systemd/system/molibra.service.d
sudo tee /etc/systemd/system/molibra.service.d/10-heap.conf >/dev/null <<'EOF'
[Service]
Environment=NODE_OPTIONS=--max-old-space-size=3072
EOF
sudo systemctl daemon-reload
```

Optional overrides for the RPC socket limits (defaults shown; only set these if
you have measured a reason to):

```ini
[Service]
Environment=MOLIBRA_REQUEST_TIMEOUT_MS=30000
Environment=MOLIBRA_HEADERS_TIMEOUT_MS=15000
Environment=MOLIBRA_KEEPALIVE_TIMEOUT_MS=10000
Environment=MOLIBRA_MAX_CONNECTIONS=512
```

Anchor publishers: the node now believes anchors only from the two operator
publishers by default. To name others, add
`--anchor-publishers 0x...,0x...` to the node's `ExecStart` and
`--publishers 0x...,0x...` to the anchor poller's. An empty list is refused.

## 2. Caddy: security headers, access log, upstream keepalive

The node keys its rate limiter on the rightmost `X-Forwarded-For` entry **only
when the request arrives from 127.0.0.1**, i.e. from Caddy. Caddy's
`reverse_proxy` sets that header itself, and, with no `trusted_proxies`
configured, does not pass through a client-supplied one. Do not add
`trusted_proxies` unless there really is another proxy in front of Caddy.

The upstream keepalive must be **shorter** than the node's
`keepAliveTimeout` (10 s), or Caddy can reuse a socket the node has just
closed and answer 502.

```caddyfile
<your.domain> {
	encode gzip

	header {
		# Pages must not be framed (clickjacking on the wallet/swap pages).
		X-Frame-Options "DENY"
		Content-Security-Policy "frame-ancestors 'none'"
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}

	log {
		output file /var/log/caddy/molibra-access.log {
			roll_size 50MiB
			roll_keep 10
			roll_keep_for 336h
		}
		format json
	}

	request_body {
		max_size 2MB
	}

	reverse_proxy 127.0.0.1:8545 {
		transport http {
			keepalive 5s
			dial_timeout 5s
			response_header_timeout 60s
		}
	}
}
```

Notes:

- `Content-Security-Policy` above sets only `frame-ancestors`; it does not
  restrict scripts, so it cannot break the existing pages. Tightening it
  further needs a page-by-page review first.
- Add `preload` to HSTS only once every subdomain is on HTTPS for good.
- The access log contains client IP addresses. Keep the retention short
  (14 days above), keep the file readable only by the Caddy user, and never
  publish it.
- Check with `caddy validate --config /etc/caddy/Caddyfile` before
  `sudo systemctl reload caddy`.

## 3. Deploy order

For each node, node 2 first, then node 1 once node 2 is healthy:

```sh
cd /home/opc/molibra
git fetch origin && git log --oneline -1 origin/main     # confirm the hardening commit is there
sudo systemctl stop molibra
git reset --hard origin/main
npm ci --omit=dev
# (optional) install the drop-in from section 1 and daemon-reload
sudo systemctl start molibra
sudo systemctl start molibra-anchors.service             # the poller imports src/anchor.js now
journalctl -u molibra -n 50 --no-pager                   # look for "anchor publishers:" and no ANCHOR IGNORED floods
curl -s http://127.0.0.1:8545/molibra | head -c 600      # finality.anchored true, finalizedHeight <= height
```

Then on the second node, after the first is back:

- both heads advance and stay within a few blocks of each other
  (`check-nodes.sh`);
- `/molibra` reports `finality.finalizedHeight` at or below the local height;
- `curl -s -XPOST 127.0.0.1:8545/molibra/announce -H 'content-type: application/json' -d '{"url":"http://169.254.169.254"}'`
  answers 400.

Rollback: `git reset --hard <previous commit> && sudo systemctl restart molibra`.
The change touches no consensus rule and no on-disk format, so a rollback is
safe at any time.
