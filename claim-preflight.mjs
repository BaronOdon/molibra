/**
 * Pre-flight a bMOLI claim by eth_call, and read the revert BY NAME.
 *
 * ⛔ Nothing is signed or sent here. The point is that a revert is a
 * diagnosis, not a shrug: NotAnchored → ChallengeWindowOpen → clean is the
 * whole sequence, and each name says exactly what is still owed. A claim that
 * pre-flights cleanly is one the operator can sign knowing it mints.
 *
 * The encoder and the error names live in src/bmoliclaim.js, shared with the
 * bridge bot (bots/bridge-bot.mjs), so what is checked by hand here is byte
 * for byte what the bot sends.
 *
 * Usage: node claim-preflight.mjs --tx 0x… [--token 0x…] [--node http://…]
 */
import {
  BMOLI, claimFromProof, revertName, statusCall, decodeStatus,
} from './src/bmoliclaim.js';

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) =>
  a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') === false ? all[i + 1] : true]] : []));

const ETH_RPC = args.rpc ?? 'https://ethereum-rpc.publicnode.com';
const NODE = args.node ?? 'http://193.123.191.142:8545';
// ⛔ The CURRENT BridgedMoli. The stray 0x035b2377… deployed by accident on
//    21 Sep would accept the same proof and mint a token nobody should hold.
const TOKEN = args.token ?? BMOLI;
const FROM = args.from ?? '0xf51ac8FD4112bF1d45fD5C38d5aBfE0C61eC3F5a';

async function rpc(method, params) {
  const r = await fetch(ETH_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  return (await r.json());
}

const txHash = args.tx;
if (!/^0x[0-9a-f]{64}$/i.test(txHash ?? '')) throw new Error('--tx <molibra burn tx hash> is required');

const p = await (await fetch(`${NODE}/molibra/proof/${txHash}`, { signal: AbortSignal.timeout(30000) })).json();
if (p.error) throw new Error(`proof: ${p.error}`);
console.log(`burn tx       : ${txHash}`);
console.log(`  block       : ${p.blockNumber}  ${p.blockHash}`);
console.log(`  canonical   : ${p.canonicalOnThisNode}`);
console.log(`  merkle path : ${(p.proof ?? p.siblings ?? []).length} sibling(s)`);

const data = claimFromProof(p);
const now = parseInt((await rpc('eth_blockNumber', [])).result, 16);
const st = decodeStatus((await rpc('eth_call', [{ to: TOKEN, data: statusCall(p.blockNumber) }, 'latest'])).result);
const at = Number(st.anchoredAt) + 7200;
console.log(`token         : ${TOKEN}`);
console.log(`  supply now  : ${st.supply}`);
console.log(`  usable at   : eth block ${at}  (now ${now}, ${at - now} to go)`);

const out = await rpc('eth_call', [{ to: TOKEN, from: FROM, data }, 'latest']);
if (!out.error) {
  console.log('pre-flight    : ⭐ CLEAN — this claim would mint. Nothing has been sent.');
  process.exit(0);
}
const name = revertName(out.error?.data?.data ?? out.error?.data ?? out.error?.message);
console.log(`pre-flight    : reverts ${name ?? JSON.stringify(out.error).slice(0, 200)}`);
process.exit(1);
