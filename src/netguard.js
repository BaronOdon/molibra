/**
 * Molibra - which addresses a stranger may make this node dial.
 *
 * POST /molibra/announce is public, and an announced URL becomes a peer this
 * node fetches from on a timer and pushes every mined block to. Without a
 * check that is a server-side request forgery primitive: announce
 * http://169.254.169.254/ (cloud metadata), http://127.0.0.1:2019/ (Caddy's
 * admin API) or anything on the private network, and the node does the
 * requesting from inside.
 *
 * ⛔ Refused: non-http(s) schemes, credentials in the URL, loopback, private
 * (RFC 1918 / ULA), link-local (incl. 169.254.169.254 metadata), CGNAT,
 * unspecified, multicast/reserved, and the well-known metadata host names.
 * A DNS name is resolved and refused if ANY address it resolves to is refused.
 *
 * ⛔ Residual risk, stated: a name can be rebound after the check (DNS
 * rebinding). The check raises the bar from "type a URL" to "run a rebinding
 * DNS server"; it does not close it. A LAN deployment that genuinely peers on
 * private addresses opts in with MOLIBRA_ALLOW_PRIVATE_PEERS=1.
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const BLOCKED_NAMES = [
  /^localhost$/i, /\.localhost$/i,
  /^metadata$/i, /^metadata\.google\.internal$/i, /\.internal$/i,
  /^instance-data(\.ec2\.internal)?$/i,
];

function v4ToInt(ip) {
  return ip.split('.').reduce((n, o) => (n * 256) + Number(o), 0);
}
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [v4ToInt(base), bits]);

function v4Blocked(ip) {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    return n >= base && n < base + size;
  });
}

/** True when `ip` (v4 or v6 literal) must never be dialled on a stranger's say-so. */
export function isBlockedAddress(ip) {
  let a = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const family = isIP(a);
  if (family === 4) return v4Blocked(a);
  if (family !== 6) return true; // not an address at all: refuse
  // IPv4-mapped / -compatible (::ffff:a.b.c.d, ::a.b.c.d), dotted or hex form.
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped && isIP(mapped[1]) === 4) return v4Blocked(mapped[1]);
  const hexMapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16); const lo = parseInt(hexMapped[2], 16);
    return v4Blocked(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (a === '::' || a === '::1') return true;
  const first = parseInt(a.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true;  // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true;  // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true;  // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true;  // ff00::/8 multicast
  if (a.startsWith('64:ff9b:')) return true;      // NAT64 can reach v4 private space
  if (a.startsWith('fd00:ec2::')) return true;    // AWS IMDS v6 (also covered by fc00::/7)
  return false;
}

const allowPrivate = () => process.env.MOLIBRA_ALLOW_PRIVATE_PEERS === '1';

/**
 * Validate an announced peer URL. Resolves to the normalised `scheme://host:port`
 * string, or throws with a reason a caller can return as a 400.
 */
export async function checkPeerUrl(raw, { resolve = lookup } = {}) {
  const text = String(raw ?? '').trim().replace(/\/$/, '');
  let url;
  try { url = new URL(text); } catch { throw new Error('url must be http(s)://host:port'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('url must be http or https');
  if (url.username || url.password) throw new Error('url must not carry credentials');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('url must be http(s)://host:port, with no path');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('url needs a host');
  const normalised = `${url.protocol}//${url.host}`;
  if (allowPrivate()) return normalised;

  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('refused: a private, loopback, link-local or metadata address');
    return normalised;
  }
  if (BLOCKED_NAMES.some((re) => re.test(host))) throw new Error('refused: a local or metadata host name');
  let addresses;
  try {
    addresses = await resolve(host, { all: true, verbatim: true });
  } catch {
    throw new Error('refused: the host name does not resolve');
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (!list.length || list.some((a) => isBlockedAddress(a.address ?? a))) {
    throw new Error('refused: the host name resolves to a private, loopback, link-local or metadata address');
  }
  return normalised;
}
