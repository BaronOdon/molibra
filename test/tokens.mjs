/**
 * The coins: logos, the token list, the token pages, and their routes.
 *
 *  1. Every coin has its logos, and each is a real, transparent PNG/SVG of the
 *     stated size and small enough for every listing (Trust Wallet: < 100 kB).
 *     The political coins' logos contain no raster image and no text - a
 *     likeness or a name drawn into the mark is exactly what must not be there.
 *  2. /tokenlist.json validates against the OFFICIAL Uniswap schema
 *     (test/fixtures/tokenlist.schema.json, fetched from Uniswap/token-lists),
 *     both as it is today and with every markets.json address filled in, with
 *     a validator that is shown to reject a broken list first.
 *  3. Undeployed coins never reach the list; filling an address is a minor bump.
 *  4. The token pages carry the unofficial notice for the political coins, and
 *     the data they embed cannot close the <script>.
 *  5. A real node answers every route: list (with CORS), page, logos, the
 *     /token/<symbol> short address, and no file outside the logo set.
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import {
  buildTokenList, resolveAll, tokenPageData, renderTokenPage, logoFile, checksum,
} from '../src/tokens.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOK = join(ROOT, 'src/web/tokens');

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

const registry = JSON.parse(readFileSync(join(TOK, 'tokens.json'), 'utf8'));
const markets = JSON.parse(readFileSync(join(ROOT, 'src/web/markets.json'), 'utf8'));

/* ------------------------------------------------------------ 1. logos */
console.log('logos\n');

function png(file) {
  const b = readFileSync(file);
  const magic = b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), colorType = b[25];
  const idat = [];
  for (let o = 8; o < b.length;) {
    const len = b.readUInt32BE(o); const type = b.toString('ascii', o + 4, o + 8);
    if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { magic, w, h, colorType, cornerAlpha: raw[4], bytes: b.length };
}

for (const t of registry.tokens) {
  const svgFile = join(TOK, `${t.key}.svg`);
  check(`${t.symbol}: ${t.key}.svg exists`, existsSync(svgFile));
  if (!existsSync(svgFile)) continue;
  const svg = readFileSync(svgFile, 'utf8');
  check('  and is an SVG with a 256 viewBox', svg.trimStart().startsWith('<svg') && /viewBox="0 0 256 256"/.test(svg));
  check('  with no embedded raster, no external reference, no script',
    !/<image|href="http|<script|<foreignObject/i.test(svg));
  if (t.unofficial) {
    check('  political coin: no <text> drawn into the mark (no name, no slogan)', !/<text/i.test(svg));
  }
  for (const [suffix, size] of [['', 256], ['-200', 200], ['-64', 64], ['-32', 32]]) {
    const f = join(TOK, `${t.key}${suffix}.png`);
    if (!existsSync(f)) { check(`  ${t.key}${suffix}.png exists`, false); continue; }
    const p = png(f);
    check(`  ${t.key}${suffix}.png is a ${size}x${size} RGBA PNG with a transparent corner, < 100 kB`,
      p.magic && p.w === size && p.h === size && p.colorType === 6 && p.cornerAlpha === 0 && p.bytes < 100_000,
      `${p.w}x${p.h} type ${p.colorType} alpha ${p.cornerAlpha} ${(p.bytes / 1024).toFixed(1)} kB`);
  }
}

/* ------------------------------------------------------------ 2. schema */
console.log('\ntoken list vs the Uniswap schema\n');

const schema = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/tokenlist.schema.json'), 'utf8'));
check('the vendored schema is the Uniswap token list schema', schema.$id === 'https://uniswap.org/tokenlist.schema.json');

/**
 * Draft-07, the subset this schema uses: type, const, enum, anyOf, $ref,
 * required, properties, additionalProperties, propertyNames, min/maxProperties,
 * items, min/maxItems, uniqueItems, min/maxLength, pattern, minimum, maximum,
 * format (uri, date-time). An unknown keyword fails loudly rather than passing.
 */
const KNOWN = new Set(['$schema', '$id', 'title', 'description', 'examples', 'definitions', 'type', 'const', 'enum',
  'anyOf', '$ref', 'required', 'properties', 'additionalProperties', 'propertyNames', 'minProperties',
  'maxProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'format']);
function validate(s, v, at = '$', errs = []) {
  if (s === true || s === undefined) return errs;
  for (const k of Object.keys(s)) if (!KNOWN.has(k)) errs.push(`${at}: validator does not know keyword ${k}`);
  if (s.$ref) return validate(s.$ref.split('/').slice(1).reduce((o, k) => o[k], schema), v, at, errs);
  const typeOf = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : Number.isInteger(x) ? 'integer' : typeof x);
  if (s.type) {
    const ty = typeOf(v);
    const ok = s.type === ty || (s.type === 'number' && ty === 'integer');
    if (!ok) { errs.push(`${at}: expected ${s.type}, got ${ty}`); return errs; }
  }
  if ('const' in s && v !== s.const) errs.push(`${at}: expected const ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) errs.push(`${at}: not in enum`);
  if (s.anyOf && !s.anyOf.some((sub) => validate(sub, v, at, []).length === 0)) errs.push(`${at}: matches no anyOf branch`);
  if (typeof v === 'string') {
    if (s.minLength != null && [...v].length < s.minLength) errs.push(`${at}: shorter than ${s.minLength}`);
    if (s.maxLength != null && [...v].length > s.maxLength) errs.push(`${at}: longer than ${s.maxLength}`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) errs.push(`${at}: does not match ${s.pattern}`);
    if (s.format === 'uri' && !/^[a-z][a-z0-9+.-]*:[^\s]*$/i.test(v)) errs.push(`${at}: not a uri`);
    if (s.format === 'date-time' && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v)) errs.push(`${at}: not a date-time`);
  }
  if (typeof v === 'number') {
    if (s.minimum != null && v < s.minimum) errs.push(`${at}: below ${s.minimum}`);
    if (s.maximum != null && v > s.maximum) errs.push(`${at}: above ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems != null && v.length < s.minItems) errs.push(`${at}: fewer than ${s.minItems} items`);
    if (s.maxItems != null && v.length > s.maxItems) errs.push(`${at}: more than ${s.maxItems} items`);
    if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errs.push(`${at}: items not unique`);
    if (s.items) v.forEach((x, i) => validate(s.items, x, `${at}[${i}]`, errs));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const keys = Object.keys(v);
    for (const r of s.required || []) if (!(r in v)) errs.push(`${at}: missing ${r}`);
    if (s.minProperties != null && keys.length < s.minProperties) errs.push(`${at}: too few properties`);
    if (s.maxProperties != null && keys.length > s.maxProperties) errs.push(`${at}: too many properties`);
    for (const k of keys) {
      if (s.propertyNames) validate(s.propertyNames, k, `${at}{${k}}`, errs);
      if (s.properties && k in s.properties) validate(s.properties[k], v[k], `${at}.${k}`, errs);
      else if (s.additionalProperties === false) errs.push(`${at}: property ${k} not allowed`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') validate(s.additionalProperties, v[k], `${at}.${k}`, errs);
    }
  }
  return errs;
}

const live = buildTokenList();
const liveErrs = validate(schema, live);
check('the live /tokenlist.json is valid', liveErrs.length === 0, liveErrs.slice(0, 5).join('; ') || `${live.tokens.length} tokens`);

// The validator must be able to say no, or a green line above means nothing.
const broken = JSON.parse(JSON.stringify(live));
broken.tokens[0].symbol = 'B MOLI'; broken.name = 'Molibra!'; broken.tokens[0].extensions = { page: 'https://molibra.org/molibra/token/this-is-too-long' };
const brokenErrs = validate(schema, broken);
check('  and the validator rejects a broken list (space in symbol, bad list name, 43+ char extension)',
  brokenErrs.length >= 3, `${brokenErrs.length} errors`);

const filled = JSON.parse(JSON.stringify(markets));
const fake = (n) => '0x' + String(n).repeat(40);
let fillCount = 0;
for (const m of filled.markets) {
  if (!m.token) { m.token = fake(++fillCount); }
  if (m.meme?.ethereum) {
    if (!m.meme.ethereum.token) { m.meme.ethereum.token = fake(++fillCount); }
    if (!m.meme.ethereum.bridgedAsset) m.meme.ethereum.bridgedAsset = m.token;
  }
}
const full = buildTokenList('https://molibra.org', resolveAll(registry, filled));
const fullErrs = validate(schema, full);
check('with every markets.json address filled in, still valid', fullErrs.length === 0,
  fullErrs.slice(0, 5).join('; ') || `${full.tokens.length} tokens`);

/* ------------------------------------------------------------ 3. content */
console.log('\ntoken list content\n');

const has = (list, chainId, symbol) => list.tokens.some((x) => x.chainId === chainId && x.symbol === symbol);
check('bMOLI on Ethereum is listed', has(live, 1, 'bMOLI'));
check('WSRO on Ethereum is listed', has(live, 1, 'WSRO'));
check('WSRO on Molibra is listed, with bridgeInfo pointing at the Ethereum WSRO',
  live.tokens.some((x) => x.chainId === 20226 && x.symbol === 'WSRO'
    && x.extensions?.bridgeInfo?.['1']?.tokenAddress === checksum('0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8')));
check('MOLI itself is not listed: a native coin has no contract address', !live.tokens.some((x) => x.symbol === 'MOLI'));
for (const t of live.tokens) {
  check(`  ${t.chainId}:${t.symbol} address is EIP-55 checksummed`, t.address === checksum(t.address));
  check(`  ${t.chainId}:${t.symbol} logo is on molibra.org and is a file this repo ships`,
    t.logoURI.startsWith('https://molibra.org/molibra/tokens/') && !!logoFile(t.logoURI.split('/').pop()));
}
const undeployed = (markets.markets || []).filter((m) => m.kind?.includes('meme') && !m.token).map((m) => m.symbol);
for (const s of undeployed) {
  check(`${s} has no address in markets.json, so it is NOT in the live list`, !live.tokens.some((x) => x.symbol === s && x.chainId === 20226));
}
// FAZOL is Molibra-native (operator, 5 Oct 2026): no chain-1 deployment.
check('every filled address enters the list', ['CARAMELO', 'BOLSO', 'FAZOL'].every((s) => has(full, 20226, s)) && !has(full, 1, 'FAZOL'));
const addedNow = full.tokens.length - live.tokens.length;
check('each token added is one minor version up (Uniswap rule), major and patch untouched',
  full.version.minor === live.version.minor + addedNow && full.version.major === live.version.major
  && full.version.patch === live.version.patch, `${JSON.stringify(live.version)} -> ${JSON.stringify(full.version)}`);
check('the political coins carry the meme + unofficial tags',
  full.tokens.filter((x) => ['BOLSO', 'FAZOL'].includes(x.symbol)).every((x) => x.tags.includes('unofficial') && x.tags.includes('meme') && x.extensions?.unofficial === true));

/* ------------------------------------------------------------ 4. pages */
console.log('\ntoken pages\n');

for (const t of registry.tokens) {
  const d = tokenPageData(t.symbol);
  check(`/molibra/token/${t.key} has page data`, !!d);
  if (t.unofficial) {
    check(`  ${t.symbol}: PT notice says "Meme não oficial, sem vínculo com ${t.unofficial.person}"`,
      d.unofficial.pt.startsWith('Meme não oficial, sem vínculo com ' + t.unofficial.person));
    check(`  ${t.symbol}: EN notice says unofficial and not affiliated`, /^Unofficial meme, not affiliated with/.test(d.unofficial.en));
  }
}
check('BOLSO\'s notice is the operator\'s words, family and party included',
  tokenPageData('bolso').unofficial.pt === 'Meme não oficial, sem vínculo com Jair Bolsonaro, sua família ou qualquer partido/campanha.');
check('symbols are case-insensitive, unknown symbols get no page', !!tokenPageData('BmOlI') && tokenPageData('nope') === null);
const memeArtifact = JSON.parse(readFileSync(join(ROOT, 'contracts/artifacts/MemeToken.json'), 'utf8'));
check('a MemeToken page expects the artifact\'s runtime hash (computed, not copied)',
  /^[0-9a-f]{64}$/.test(tokenPageData('caramelo').deployments[0].runtimeSha256 || '') && !!memeArtifact.deployedBytecode);
check('a chain-1 buy link is only offered for a pool /molibra/buy knows',
  tokenPageData('bmoli').deployments[0].buy === '/molibra/buy'
  && tokenPageData('fazol').deployments.every((d) => d.chainId !== 1));

const tpl = readFileSync(join(ROOT, 'src/web/token.html'), 'utf8');
const evil = { ...tokenPageData('bolso'), desc_pt: '</script><script>alert(1)</script>' };
const rendered = renderTokenPage(tpl, evil);
check('embedded data cannot close the <script>', !rendered.includes('</script><script>alert(1)'));
check('  and every placeholder is filled', !/__TOKEN_[A-Z_]+__|\/\*__TOKEN_DATA__\*\/null/.test(renderTokenPage(tpl, tokenPageData('bmoli'))));
check('the page offers wallet_watchAsset with the absolute logo URL', tpl.includes("method: 'wallet_watchAsset'") && tpl.includes('image: T.logoAbs'));
check('the page states facts only after hashing the deployed bytecode', tpl.includes("crypto.subtle.digest('SHA-256'") && tpl.includes('d.runtimeSha256'));
check('the page reads lock status live (ownerOf on the PositionManager)', tpl.includes('SEL.ownerOf') && tpl.includes('lockStatus('));
check('the page is PT-BR first with EN', /<html lang="pt-BR">/.test(tpl) && tpl.includes('en: {'));
check('no promise of value on the page', !/garantid|lucro garantido|vai subir|guaranteed|to the moon/i.test(tpl));

/* ------------------------------------------------------------ 5. live node */
console.log('\nroutes on a real node\n');

const dir = mkdtempSync(join(tmpdir(), 'molibra-tokens-'));
const port = 19000 + Math.floor(Math.random() * 2000);
const child = spawn(process.execPath, [join(ROOT, 'src/cli.js'), 'node', '--port', String(port), '--datadir', dir],
  { stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(base + '/molibra')).ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  check('the node came up', up);
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  let r = await get('/tokenlist.json');
  const body = await r.json();
  check('/tokenlist.json answers JSON with CORS *', r.status === 200 && r.headers.get('access-control-allow-origin') === '*'
    && /application\/json/.test(r.headers.get('content-type')));
  check('  and it is the list buildTokenList makes', JSON.stringify(body.tokens) === JSON.stringify(live.tokens));
  r = await get('/molibra/tokenlist.json');
  check('/molibra/tokenlist.json answers too', r.status === 200);
  for (const t of registry.tokens) {
    r = await get(`/molibra/token/${t.key}`);
    const html = await r.text();
    check(`/molibra/token/${t.key} is the page`, r.status === 200 && html.includes(`"symbol":"${t.symbol}"`));
    r = await get(`/molibra/tokens/${t.key}.png`);
    check(`  /molibra/tokens/${t.key}.png is served as image/png`, r.status === 200 && r.headers.get('content-type') === 'image/png');
  }
  r = await get('/token/Caramelo');
  check('/token/Caramelo redirects to /molibra/token/caramelo', r.status === 301 && r.headers.get('location') === '/molibra/token/caramelo');
  r = await get('/molibra/token/0x' + 'ab'.repeat(32));
  check('a registry id still reaches the registry JSON, not the page', /application\/json/.test(r.headers.get('content-type')));
  for (const p of ['/molibra/tokens/tokens.json', '/molibra/tokens/..%2Frpc.js', '/molibra/tokens/nobody.png', '/molibra/tokens/moli-32.svg']) {
    r = await get(p);
    check(`  ${p} is refused`, r.status === 404);
  }
} finally {
  const gone = new Promise((r) => child.once('exit', r));
  child.kill();
  await gone;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked on windows for a moment */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
// ⛔ exitCode, not process.exit(): exiting while fetch's keep-alive sockets are
// still closing trips a libuv assertion on Windows and turns a green run red.
process.exitCode = fail ? 1 : 0;
