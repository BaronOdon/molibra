#!/usr/bin/env node
/**
 * token-health: what the public scanners say about a token, and what the
 * bytecode itself says, side by side.
 *
 *   node tools/token-health.mjs <address> [--chain 1] [--rpc <url>] [--json]
 *   node tools/token-health.mjs bmoli | wsro | fazol     (names from the token list)
 *
 * Reads, never writes. Sources:
 *   1. The chain (eth_getCode / eth_call / eth_getStorageAt): code size, EIP-1967
 *      proxy slots, owner(), supply, and which privileged selectors the runtime
 *      bytecode contains at all. This is the ground truth the scanners approximate.
 *   2. GoPlus Security token_security API (public, no key).
 *   3. Honeypot.is v2 IsHoneypot + v1 GetPairs (public, no key).
 *
 * ⛔ Every scanner is a heuristic over the same bytecode. When a scanner and the
 * bytecode disagree, the bytecode is right and the scanner is the thing to
 * appeal - but the report prints both, so nobody has to take that on faith.
 *
 * ⛔ Chain 20226 (Molibra) is known to no public scanner; for it only the
 * on-chain section runs, against the node's JSON-RPC.
 */
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { utf8ToBytes, bytesToHex } from 'ethereum-cryptography/utils.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RPC_DEFAULT = { 1: 'https://ethereum-rpc.publicnode.com', 20226: 'https://molibra.org' };

export const selector = (sig) => '0x' + bytesToHex(keccak256(utf8ToBytes(sig))).slice(0, 8);

/** Privileged entry points a scanner looks for, with what each would let someone do. */
export const PRIVILEGED = {
  'mint(address,uint256)': 'create new units at will',
  'mint(uint256)': 'create new units at will',
  'pause()': 'stop all transfers',
  'unpause()': 'resume transfers after a pause',
  'owner()': 'has an owner slot (check who it is)',
  'transferOwnership(address)': 'move ownership',
  'renounceOwnership()': 'give ownership up',
  'blacklist(address)': 'block a holder',
  'addToBlacklist(address)': 'block a holder',
  'setBlacklist(address,bool)': 'block a holder',
  'setFee(uint256)': 'change a transfer tax',
  'setTaxFee(uint256)': 'change a transfer tax',
  'setMaxTxAmount(uint256)': 'cap transaction size (anti-whale)',
  'upgradeTo(address)': 'replace the code (proxy)',
  'upgradeToAndCall(address,bytes)': 'replace the code (proxy)',
};

/** GoPlus fields: what a '1' means, and how a legitimate token clears it. */
export const GOPLUS_EXPLAIN = {
  is_mintable: ['a mint function exists in the code', 'GoPlus flags ANY reachable mint path, including one gated by a proof or by a renounced owner. Not clearable by code change on a deployed contract; answer it in the token page / Etherscan description ("mint only against a proved burn" or "owner renounced"), and on GoPlus via their false-positive report.'],
  is_proxy: ['code can be swapped behind the address', 'deploy without a proxy (ours are not proxies).'],
  owner_address: ['an owner exists', 'renounce (transferOwnership/renounceOwnership to 0x0) or deploy ownerless.'],
  can_take_back_ownership: ['a renounced owner can be reclaimed', 'remove the reclaim path; not present in our contracts.'],
  hidden_owner: ['owner-like power stored outside owner()', 'not present in our contracts.'],
  external_call: ['transfers call out to another contract', 'not present in our contracts.'],
  selfdestruct: ['code can be destroyed', 'not present.'],
  is_blacklisted: ['holders can be blocked', 'not present.'],
  is_whitelisted: ['only listed addresses can trade', 'not present.'],
  transfer_pausable: ['transfers can be stopped', 'not present.'],
  trading_cooldown: ['a cooldown between trades', 'not present.'],
  is_anti_whale: ['a max transaction / max wallet', 'not present.'],
  slippage_modifiable: ['the tax can be changed', 'not present.'],
  is_honeypot: ['simulated sell fails', 'never true for a plain ERC-20; if shown, re-check the pool.'],
  is_open_source: ['0 = source not verified on Etherscan', 'verify the source on Etherscan (Blockscout alone is not read by every scanner).'],
  is_in_dex: ['0 = no recognised DEX pair', 'GoPlus indexes Uniswap v2/v3/v4 pools with liquidity; seed and keep in-range liquidity.'],
};

const has = (code, sig) => code.includes(selector(sig).slice(2));

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

function decodeString(hex) {
  if (!hex || hex === '0x') return null;
  const h = hex.slice(2);
  if (h.length === 64) return Buffer.from(h, 'hex').toString('utf8').replace(/\0+$/, '');
  const len = parseInt(h.slice(64, 128), 16);
  return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8');
}

export async function onChain(rpcUrl, address) {
  const call = (sig) => rpc(rpcUrl, 'eth_call', [{ to: address, data: selector(sig) }, 'latest']).catch(() => null);
  const code = String(await rpc(rpcUrl, 'eth_getCode', [address, 'latest'])).toLowerCase();
  const slot = async (s) => rpc(rpcUrl, 'eth_getStorageAt', [address, s, 'latest']).catch(() => null);
  const [name, symbol, decimals, supply, owner, impl, admin] = await Promise.all([
    call('name()'), call('symbol()'), call('decimals()'), call('totalSupply()'), call('owner()'),
    slot('0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'),
    slot('0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'),
  ]);
  const zero = (v) => !v || /^0x0*$/.test(v);
  return {
    codeBytes: (code.length - 2) / 2,
    name: decodeString(name), symbol: decodeString(symbol),
    decimals: decimals && decimals !== '0x' ? Number(BigInt(decimals)) : null,
    totalSupply: supply && supply !== '0x' ? BigInt(supply).toString() : null,
    owner: owner && owner.length >= 66 ? '0x' + owner.slice(-40) : null,
    proxy: !zero(impl) || !zero(admin),
    privileged: Object.entries(PRIVILEGED).filter(([sig]) => has(code, sig)).map(([sig, what]) => ({ sig, what })),
  };
}

export async function goplus(chainId, address) {
  const r = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address}`,
    { signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  return j?.result?.[address.toLowerCase()] ?? null;
}

export async function honeypot(chainId, address) {
  const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); return r.json(); };
  const [hp, pairs] = await Promise.all([
    get(`https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${chainId}`).catch((e) => ({ error: e.message })),
    get(`https://api.honeypot.is/v1/GetPairs?address=${address}&chainID=${chainId}`).catch(() => null),
  ]);
  return { hp, pairs };
}

/** Resolve a short name (bmoli, wsro...) from the served token list. */
function fromList(name) {
  const file = join(ROOT, 'src/web/tokenlist.base.json');
  if (!existsSync(file)) return null;
  const list = JSON.parse(readFileSync(file, 'utf8'));
  return (list.tokens || []).find((t) => t.symbol.toLowerCase() === name.toLowerCase() && t.address) ?? null;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  let address = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true);
  let chainId = Number(opt('--chain', 1));
  if (address && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    const t = fromList(address);
    if (!t) { console.error(`unknown token ${address}`); process.exit(2); }
    address = t.address; chainId = t.chainId;
  }
  if (!address) { console.error('usage: node tools/token-health.mjs <address|symbol> [--chain 1] [--rpc url] [--json]'); process.exit(2); }
  address = address.toLowerCase();
  const rpcUrl = opt('--rpc', RPC_DEFAULT[chainId]);

  const out = { chainId, address, at: new Date().toISOString() };
  out.chain = await onChain(rpcUrl, address).catch((e) => ({ error: e.message }));
  if (chainId !== 20226) {
    out.goplus = await goplus(chainId, address).catch((e) => ({ error: e.message }));
    out.honeypot = await honeypot(chainId, address);
  }
  if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return; }

  const c = out.chain;
  console.log(`\n== ${c.symbol ?? '?'} (${c.name ?? '?'}) on chain ${chainId}  ${address}\n   ${out.at}`);
  console.log('\n-- bytecode (ground truth)');
  if (c.error) console.log('   error: ' + c.error);
  else {
    console.log(`   code ${c.codeBytes} bytes · decimals ${c.decimals} · totalSupply ${c.totalSupply}`);
    console.log(`   owner(): ${c.owner ?? 'no owner() function'} · EIP-1967 proxy: ${c.proxy ? 'YES' : 'no'}`);
    console.log(`   privileged selectors present: ${c.privileged.length ? c.privileged.map((p) => `${p.sig} (${p.what})`).join('; ') : 'none'}`);
  }
  if (out.goplus) {
    const g = out.goplus;
    console.log('\n-- GoPlus token_security');
    if (!g || g.error) console.log('   ' + (g?.error ?? 'not indexed by GoPlus'));
    else {
      for (const [k, [what, fix]] of Object.entries(GOPLUS_EXPLAIN)) {
        if (!(k in g)) continue;
        const bad = k === 'owner_address' ? !/^0x0{40}$/.test(g[k] || '0x' + '0'.repeat(40)) && g[k] !== ''
          : (k === 'is_open_source' || k === 'is_in_dex') ? g[k] === '0' : g[k] === '1';
        console.log(`   ${bad ? 'FLAG' : 'ok  '} ${k}=${g[k] || '""'}${bad ? `  -> ${what}. Fix: ${fix}` : ''}`);
      }
      console.log(`   holders ${g.holder_count} · creator ${g.creator_percent} · lp_holders ${g.lp_holder_count ?? 0}`);
      for (const h of g.holders || []) console.log(`     holder ${h.address} ${(Number(h.percent) * 100).toFixed(4)}%${h.is_locked ? ' (locked)' : ''}${h.is_contract ? ' [contract]' : ''}`);
      for (const d of g.dex || []) console.log(`     dex ${d.name} pair ${d.pair} liquidity $${Number(d.liquidity).toFixed(2)}`);
      for (const lp of g.lp_holders || []) {
        console.log(`     LP holder ${lp.address} ${(Number(lp.percent) * 100).toFixed(1)}% locked=${lp.is_locked}`);
        for (const n of lp.NFT_list || []) console.log(`       position NFT #${n.NFT_id} value $${n.value} in_effect=${n.in_effect}`);
      }
      const lockedAny = (g.lp_holders || []).some((l) => l.is_locked === 1 || l.is_locked === '1');
      if ((g.lp_holders || []).length && !lockedAny) console.log('   FLAG liquidity not locked -> the LP position is held by a plain wallet. Fix: lock it (docs/TOKEN-TRUST.md, "Liquidity lock").');
      const top = Math.max(0, ...(g.holders || []).filter((h) => !h.is_contract || h.address === g.creator_address).map((h) => Number(h.percent)));
      if (Number(g.creator_percent) > 0.5 || top > 0.5) console.log('   FLAG holder concentration -> one wallet holds most of the supply. Fix: docs/TOKEN-TRUST.md, "Holder concentration".');
    }
  }
  if (out.honeypot) {
    const { hp, pairs } = out.honeypot;
    console.log('\n-- Honeypot.is');
    if (hp?.error) console.log(`   IsHoneypot: ${hp.error}${/pair not found/.test(hp.error) ? '  -> Honeypot.is found no pool it can simulate (it does not index this pool type); nothing was tested, which is NOT a pass or a fail.' : ''}`);
    else console.log(`   isHoneypot ${hp?.honeypotResult?.isHoneypot} · buyTax ${hp?.simulationResult?.buyTax} · sellTax ${hp?.simulationResult?.sellTax} · risk ${hp?.summary?.risk}`);
    console.log(`   pairs known: ${Array.isArray(pairs) ? pairs.length : 'n/a'}`);
  }
  console.log('');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
