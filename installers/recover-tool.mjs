/**
 * Orphaned-work payout (22 Nov 2026). Reads the recovery ledger a node built
 * from verified claims and pays each owed address its recovered MOLI from a
 * funding wallet. The verification already happened on-chain (proof of work,
 * canonical excluded, 10k/address cap); this tool only moves the money, and
 * only what a human has reviewed.
 *
 *   node installers/recover-tool.mjs list   --ledger <recover-claims.json>
 *        print every unpaid address and what it is owed, and the total.
 *   node installers/recover-tool.mjs pay    --ledger <file> --node <url>
 *        (--key-file <hex> | --key-vault <name>) --max-moli <cap> [--confirm]
 *        without --confirm it is a DRY RUN (prints the plan, sends nothing).
 *        Refuses if the total exceeds --max-moli. Marks each address paid in the
 *        ledger as its transfer is accepted, so a re-run never pays twice.
 *
 * ⛔ The funding key only ever lives in this process; nothing here prints it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { signTransaction } from '../src/tx.js';
import { privateToAddress, toChecksumAddress, toHex, fromHex } from '../src/crypto.js';
import { RecoveryLedger } from '../src/recover.js';

const VAULT = 'C:/Users/Administrator/Desktop/Server Ops/vault.ps1';
const args = Object.fromEntries(process.argv.slice(3).flatMap((a, i, all) =>
  a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') === false ? all[i + 1] : true]] : []));
const cmd = process.argv[2];
const MOLI = 10n ** 18n;
const fmt = (wei) => `${(Number(BigInt(wei) / 10n ** 14n) / 1e4).toFixed(4)} MOLI`;

function fundingKey() {
  if (args['key-file']) return fromHex(readFileSync(args['key-file'], 'utf8').trim());
  if (args['key-vault']) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', VAULT, 'get', args['key-vault']],
      { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || !r.stdout?.trim()) throw new Error(`vault has no key named ${args['key-vault']}`);
    return fromHex(r.stdout.trim());
  }
  throw new Error('--key-file <hex> or --key-vault <name> is required');
}

async function rpc(node, method, params) {
  const r = await fetch(node, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

if (cmd === 'list') {
  const led = new RecoveryLedger(args.ledger ?? 'recover-claims.json');
  const rows = led.unpaid();
  let total = 0n;
  for (const r of rows) { total += BigInt(r.dueWei); console.log(`${r.address}  ${fmt(r.dueWei)}`); }
  console.log(`\n${rows.length} address(es) owed; total ${fmt(total)}`);
} else if (cmd === 'pay') {
  if (!args.node) throw new Error('--node <url> is required');
  if (!args['max-moli']) throw new Error('--max-moli <cap> is required (safety ceiling on total spend)');
  const led = new RecoveryLedger(args.ledger ?? 'recover-claims.json');
  const rows = led.unpaid();
  let total = 0n;
  for (const r of rows) total += BigInt(r.dueWei);
  const cap = BigInt(args['max-moli']) * MOLI;
  console.log(`plan: pay ${rows.length} address(es), total ${fmt(total)} (cap ${args['max-moli']} MOLI)`);
  for (const r of rows) console.log(`  -> ${r.address}  ${fmt(r.dueWei)}`);
  if (total > cap) throw new Error(`total ${fmt(total)} exceeds --max-moli ${args['max-moli']}: refusing`);
  if (!args.confirm) { console.log('\nDRY RUN (no --confirm): nothing sent.'); process.exit(0); }

  const key = fundingKey();
  const from = toChecksumAddress(privateToAddress(key));
  const chainId = Number(args['chain-id'] ?? 20226);
  let nonce = BigInt(await rpc(args.node, 'eth_getTransactionCount', [from, 'pending']));
  let gasPrice = BigInt(await rpc(args.node, 'eth_gasPrice', []));
  if (gasPrice < 1000000000n) gasPrice = 1000000000n;
  console.log(`\nfunding from ${from} (nonce ${nonce}, gasPrice ${gasPrice})`);
  let paidCount = 0, paidWei = 0n;
  for (const r of rows) {
    const value = BigInt(r.dueWei);
    const raw = signTransaction({ nonce, gasPrice, gasLimit: 21000n, to: r.address, value, data: '0x' }, key, chainId);
    try {
      const txHash = await rpc(args.node, 'eth_sendRawTransaction', [toHex(raw)]);
      led.markPaid(r.address, value, txHash);
      paidCount++; paidWei += value; nonce += 1n;
      console.log(`  paid ${r.address}  ${fmt(value)}  tx ${txHash}`);
    } catch (error) {
      console.log(`  FAILED ${r.address}: ${error.message} (left unpaid; re-run to retry)`);
    }
  }
  console.log(`\ndone: paid ${paidCount}/${rows.length}, ${fmt(paidWei)} total. Mine a block to confirm the transfers.`);
} else {
  console.log('usage: list --ledger <file> | pay --ledger <file> --node <url> (--key-file|--key-vault) --max-moli <cap> [--confirm]');
}
