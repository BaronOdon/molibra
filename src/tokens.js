/**
 * Coins the site publishes: the token list (/tokenlist.json), the per-coin
 * page (/molibra/token/<symbol>) and the logos (/molibra/tokens/<file>).
 *
 * ONE source of metadata, src/web/tokens/tokens.json, and ONE source of the
 * addresses that do not exist yet, src/web/markets.json (written by the memes
 * deploy flow). A deployment in tokens.json either pins a live address or
 * names `marketsKey` + `addressPath`; the coin enters the token list the
 * moment that path in markets.json holds an address, and not before - a token
 * list entry pointing at nothing is worse than no entry.
 *
 * ⛔ Nothing here makes an outbound request: a mining node cannot, and the
 * route must answer the same thing on every node. Every live fact on the token
 * page (bytecode, owner, supply, pool, lock) is read by the BROWSER, from the
 * chain, at render time.
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { utf8ToBytes, bytesToHex } from 'ethereum-cryptography/utils.js';

const SRC = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SRC, '..');
const WEB = join(SRC, 'web');
const TOKENS_DIR = join(WEB, 'tokens');
const REGISTRY = join(TOKENS_DIR, 'tokens.json');
const MARKETS = join(WEB, 'markets.json');

export const SITE = 'https://molibra.org';
export const CHAIN_NAMES = { 1: 'Ethereum', 20226: 'Molibra' };

const selector = (sig) => '0x' + bytesToHex(keccak256(utf8ToBytes(sig))).slice(0, 8);

/** EIP-55. The token-list schema asks for checksummed addresses. */
export function checksum(address) {
  const a = address.toLowerCase().replace(/^0x/, '');
  const h = bytesToHex(keccak256(utf8ToBytes(a)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return out;
}

const pick = (obj, path) => String(path || '').split('.').filter(Boolean)
  .reduce((o, k) => (o == null ? undefined : o[k]), obj);
const isAddr = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);

let cache = null;
/** tokens.json + markets.json, re-read only when either file changes. */
export function load() {
  const mt = (f) => (existsSync(f) ? statSync(f).mtimeMs : 0);
  const stamp = `${mt(REGISTRY)}:${mt(MARKETS)}`;
  if (cache && cache.stamp === stamp) return cache;
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  let markets = { markets: [] };
  try { markets = JSON.parse(readFileSync(MARKETS, 'utf8')); } catch { /* absent: nothing resolves from it */ }
  cache = { stamp, ...resolveAll(registry, markets), updated: new Date(Math.max(mt(REGISTRY), mt(MARKETS))).toISOString() };
  return cache;
}

/** Pure: the registry with every markets.json path resolved. Tests call it with a fixture. */
export function resolveAll(registry, markets) {
  const byKey = Object.fromEntries((markets.markets || []).map((m) => [m.key, m]));
  const tokens = registry.tokens.map((t) => ({
    ...t,
    deployments: (t.deployments || []).map((d) => resolveDeployment(d, byKey)),
  }));
  return { registry, markets, byKey, tokens };
}

function resolveDeployment(d, byKey) {
  const out = { ...d };
  const m = d.marketsKey ? byKey[d.marketsKey] : null;
  if (!d.address && d.addressPath) {
    const v = m ? pick(m, d.addressPath) : null;
    out.address = isAddr(v) ? v.toLowerCase() : null;
    out.fromMarkets = true;
  }
  if (d.pool) {
    const p = { ...d.pool };
    if (p.type === 'molibra-pool') {
      const pm = byKey[p.marketsKey];
      p.address = pm && isAddr(pm.pool) ? pm.pool.toLowerCase() : null;
    }
    if (p.type === 'uniswap-v4' && !p.poolId && p.poolIdPath) {
      const v = m ? pick(m, p.poolIdPath) : null;
      p.poolId = typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : null;
    }
    if (!p.positions && p.positionsPath) {
      const v = m ? pick(m, p.positionsPath) : null;
      p.positions = Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n > 0) : [];
    }
    out.pool = p;
  }
  return out;
}

export const findToken = (symbol) => {
  const s = String(symbol || '').toLowerCase();
  return load().tokens.find((t) => t.key === s || t.symbol.toLowerCase() === s) ?? null;
};

/* ------------------------------------------------------------ token list */

const TAGS = {
  meme: { name: 'Meme', description: 'A meme coin. No promise of value.' },
  unofficial: { name: 'Unofficial', description: 'Unofficial meme: not affiliated with or endorsed by any person it is named after.' },
  bridged: { name: 'Bridged', description: 'Exists on this chain only against a proved burn on another chain.' },
};

/**
 * The Uniswap token list (https://uniswap.org/tokenlist.schema.json).
 *
 * Version: tokens.json carries the hand-maintained base (major for a removal
 * or an address change, patch for metadata). Each address filled in from
 * markets.json since then is a token ADDED, which the standard calls a minor
 * bump, so minor = base.minor + the count of resolved markets addresses. It is
 * monotonic as long as addresses only ever get filled in; replacing one is a
 * major change and must be bumped by hand.
 */
export function buildTokenList(site = SITE, resolved = load()) {
  const { registry, tokens } = resolved;
  const updated = resolved.updated ?? new Date().toISOString();
  const list = [];
  let added = 0;
  for (const t of tokens) {
    for (const d of t.deployments) {
      if (d.native || !d.address) continue;
      if (d.fromMarkets) added++;
      const entry = {
        chainId: d.chainId,
        address: checksum(d.address),
        name: t.name,
        symbol: t.symbol,
        decimals: t.decimals,
        logoURI: `${site}/molibra/tokens/${t.key}.png`,
      };
      const tags = [...(t.tags || [])];
      if (d.bridgeOf && !tags.includes('bridged')) tags.push('bridged');
      if (tags.length) entry.tags = tags;
      const ext = {};
      if (t.unofficial) ext.unofficial = true;
      if (d.bridgeOf) {
        const origin = t.deployments.find((o) => o.chainId === d.bridgeOf && o.address);
        if (origin) ext.bridgeInfo = { [String(d.bridgeOf)]: { tokenAddress: checksum(origin.address) } };
      }
      if (Object.keys(ext).length) entry.extensions = ext;
      list.push(entry);
    }
  }
  const usedTags = new Set(list.flatMap((e) => e.tags || []));
  const base = registry.listVersion;
  return {
    name: registry.listName,
    timestamp: updated,
    version: { major: base.major, minor: base.minor + added, patch: base.patch },
    logoURI: `${site}/molibra/tokens/moli.png`,
    keywords: ['molibra', 'moli', 'memes'],
    tags: Object.fromEntries(Object.entries(TAGS).filter(([k]) => usedTags.has(k))),
    tokens: list,
  };
}

/* ------------------------------------------------------------ logos */

/** `caramelo.png`, `caramelo-200.png`, `caramelo-64.png`, `caramelo-32.png`, `caramelo.svg` - nothing else. */
export function logoFile(name) {
  const m = /^([a-z]+)(-200|-64|-32)?\.(png|svg)$/.exec(String(name));
  if (!m || (m[2] && m[3] === 'svg')) return null;
  if (!load().tokens.some((t) => t.key === m[1])) return null;
  const file = join(TOKENS_DIR, name);
  return existsSync(file) ? { file, type: m[3] === 'png' ? 'image/png' : 'image/svg+xml' } : null;
}

/* ------------------------------------------------------------ page */

/** Selectors whose PRESENCE in runtime code the page reports, with what each would allow. */
const PRIVILEGED = [
  ['mint(address,uint256)', 'emitir novas unidades', 'mint new units'],
  ['mint(uint256)', 'emitir novas unidades', 'mint new units'],
  ['pause()', 'pausar transferências', 'pause transfers'],
  ['owner()', 'tem um dono (veja quem é)', 'has an owner (see who)'],
  ['blacklist(address)', 'bloquear um titular', 'block a holder'],
  ['setBlacklist(address,bool)', 'bloquear um titular', 'block a holder'],
  ['setFee(uint256)', 'mudar uma taxa', 'change a fee'],
  ['setTaxFee(uint256)', 'mudar uma taxa', 'change a fee'],
  ['upgradeTo(address)', 'trocar o código', 'replace the code'],
  ['upgradeToAndCall(address,bytes)', 'trocar o código', 'replace the code'],
].map(([sig, pt, en]) => ({ sig, sel: selector(sig).slice(2), pt, en }));

const sha256Hex = (hex) => createHash('sha256').update(Buffer.from(hex.replace(/^0x/, ''), 'hex')).digest('hex');

/** The page's data: the token, its templates' facts, and what the browser must check. */
export function tokenPageData(symbol) {
  const t = findToken(symbol);
  if (!t) return null;
  const { registry } = load();
  const buyHtml = existsSync(join(WEB, 'buy.html')) ? readFileSync(join(WEB, 'buy.html'), 'utf8') : '';
  const deployments = t.deployments.map((d) => {
    const tpl = d.template ? registry.templates[d.template] : null;
    let runtimeSha256 = d.runtimeSha256 ?? null;
    // MemeToken has no immutables, so every deployment's runtime is the
    // artifact's: the expected hash comes from the artifact, not from a copy.
    if (!runtimeSha256 && tpl?.artifact && existsSync(join(ROOT, tpl.artifact))) {
      try { runtimeSha256 = sha256Hex(JSON.parse(readFileSync(join(ROOT, tpl.artifact), 'utf8')).deployedBytecode); } catch { /* none */ }
    }
    let buy = d.buy ?? null;
    // A chain-1 buy link is offered only when /molibra/buy actually knows the
    // pool: buy.html falls back to bMOLI for a name it does not know, which
    // would sell the reader the wrong coin.
    const out = buy && /[?&]out=([a-z]+)/.exec(buy);
    if (out && !new RegExp(`\\b${out[1]}:\\s*\\{\\s*token`).test(buyHtml)) buy = null;
    return {
      ...d, buy, runtimeSha256,
      template: d.template ?? null,
      facts_pt: tpl?.facts_pt ?? [], facts_en: tpl?.facts_en ?? [], source: tpl?.source ?? null,
    };
  });
  return {
    key: t.key, symbol: t.symbol, name: t.name, decimals: t.decimals, kind: t.kind,
    desc_pt: t.desc_pt, desc_en: t.desc_en, unofficial: t.unofficial ?? null,
    logo: `/molibra/tokens/${t.key}.png`, logoAbs: `${SITE}/molibra/tokens/${t.key}.png`,
    deployments, privileged: PRIVILEGED,
    lockers: registry.lockers ?? {},
    others: load().tokens.map((o) => ({ key: o.key, symbol: o.symbol })),
  };
}

/** Fill the template. JSON is escaped so no value can close the <script>. */
export function renderTokenPage(html, data) {
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  const BS = String.fromCharCode(92);   // a backslash, spelled so no editor can eat it
  const json = JSON.stringify(data).split('<').join(BS + 'u003c')
    .split(LS).join(BS + 'u2028').split(PS).join(BS + 'u2029');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return html
    .replace('/*__TOKEN_DATA__*/null', json)
    .replaceAll('__TOKEN_TITLE__', esc(`${data.symbol} · ${data.name}`))
    .replaceAll('__TOKEN_LOGO__', esc(data.logo))
    .replaceAll('__TOKEN_LOGO_ABS__', esc(data.logoAbs));
}
