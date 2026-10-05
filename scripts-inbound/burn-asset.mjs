/**
 * Which Ethereum ERC-20 a burn proof is about, as a PARAMETER.
 *
 * prove-burn.mjs was written for one asset, WSRO. The inbound bridge itself
 * never was: `proveBurn` takes the contract, `foreignTokenId` derives the
 * Molibra id from (chain, contract), and BRIDGE_REGISTER is per asset. So the
 * only thing that needed generalising is the claimant-side tooling - which
 * contract, what it is called, and how many decimals its amounts carry.
 *
 * ⛔ Decimals are READ ON CHAIN, never assumed. An 18 hard-coded against a
 * 6-decimal token prints a burn of 2,000 as 0.000000002 and nobody notices
 * until the wrong amount is on a page.
 *
 * WSRO stays the default, so every existing invocation means what it meant.
 */

export const WSRO = '0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8';

const SEL_DECIMALS = '0x313ce567';   // decimals()
const SEL_SYMBOL = '0x95d89b41';     // symbol()

/**
 * Split argv into positionals and `--name value` flags.
 *   prove-burn.mjs <ethTx> [recipient] [--token 0x..] [--cap <whole units>]
 */
export function parseArgs(argv) {
  const pos = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

/** ABI string (or a legacy bytes32 symbol) to text; null when unreadable. */
export function decodeSymbol(hex) {
  const h = String(hex ?? '').replace(/^0x/, '');
  if (h.length === 64) {   // bytes32, as some old tokens return
    return Buffer.from(h, 'hex').toString('utf8').replace(/\0+$/, '') || null;
  }
  if (h.length < 128) return null;
  const len = parseInt(h.slice(64, 128), 16);
  if (!len || len > 64) return null;
  return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8') || null;
}

/**
 * Resolve the asset: its contract (default WSRO), symbol and decimals, read
 * from Ethereum through `call(to, data) -> hex`.
 */
export async function resolveBurnAsset({ token, call }) {
  const contract = String(token ?? WSRO).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(contract)) throw new Error(`--token must be a contract address, got ${token}`);
  const decRaw = await call(contract, SEL_DECIMALS);
  if (!decRaw || decRaw === '0x') throw new Error(`${contract} has no decimals(): not an ERC-20 (or not on this chain)`);
  const decimals = Number(BigInt(decRaw));
  if (!(decimals >= 0 && decimals <= 36)) throw new Error(`${contract} reports ${decimals} decimals`);
  const symbol = decodeSymbol(await call(contract, SEL_SYMBOL).catch(() => null))
    ?? contract.slice(0, 8);
  return { contract, symbol: symbol.trim().toUpperCase(), decimals };
}

/** Integer base units -> a decimal string, exactly. */
export function formatUnits(amount, decimals) {
  const n = BigInt(amount); const d = BigInt(decimals);
  if (d === 0n) return n.toString();
  const base = 10n ** d;
  const frac = (n % base).toString().padStart(Number(d), '0').replace(/0+$/, '');
  return (n / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac : '');
}

/** Whole units (a decimal string) -> integer base units, exactly. */
export function parseUnits(s, decimals) {
  const t = String(s).trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`not an amount: ${s}`);
  const [w, f = ''] = t.split('.');
  if (f.length > decimals) throw new Error(`${s} has more than ${decimals} decimals`);
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
