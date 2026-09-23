/**
 * Pre-flight a bMOLI claim by eth_call, and read the revert BY NAME.
 *
 * ⛔ Nothing is signed or sent here. The point is that a revert is a
 * diagnosis, not a shrug: NotAnchored → ChallengeWindowOpen → clean is the
 * whole sequence, and each name says exactly what is still owed. A claim that
 * pre-flights cleanly is one the operator can sign knowing it mints.
 *
 * Usage: node claim-preflight.mjs --tx 0x… [--token 0x…] [--node http://…]
 */
import { keccak256, toHex } from './src/crypto.js';

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) =>
  a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') === false ? all[i + 1] : true]] : []));

const ETH_RPC = args.rpc ?? 'https://ethereum-rpc.publicnode.com';
const NODE = args.node ?? 'http://193.123.191.142:8545';
// ⛔ The CURRENT BridgedMoli. The stray 0x035b2377… deployed by accident on
//    21 Sep would accept the same proof and mint a token nobody should hold.
const TOKEN = args.token ?? '0xa302877efb74f567f3605851194b46f1d5746822';
const FROM = args.from ?? '0xf51ac8FD4112bF1d45fD5C38d5aBfE0C61eC3F5a';

const sel = (s) => toHex(keccak256(new TextEncoder().encode(s))).slice(0, 10);
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const pad = (h) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');

const ERRORS = Object.fromEntries([
  'AlreadyClaimed()', 'NotAnchored(uint256)', 'PublisherSlashed()',
  'ChallengeWindowOpen(uint256,uint256)', 'HeaderDoesNotMatchAnchor(bytes32,bytes32)',
  'NotInBlock()', 'NotAMoliBurn()', 'ABridgeOutBurnsNothing()', 'ZeroAmount()',
  'BadProof()', 'BrokenAncestry(uint256)',
].map((s) => [sel(s), s]));

async function rpc(method, params) {
  const r = await fetch(ETH_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  return (await r.json());
}

/** ABI-encode claim(uint256,bytes,bytes,bytes32[],bool[]). */
function encodeClaim(height, headerRlp, rawTx, siblings, onRight) {
  const bytesArg = (hex) => {
    const body = hex.replace(/^0x/, '');
    const padded = body.padEnd(Math.ceil(body.length / 64) * 64, '0');
    return word(body.length / 2) + padded;
  };
  const arrArg = (items) => word(items.length) + items.join('');
  const tails = [
    bytesArg(headerRlp),
    bytesArg(rawTx),
    arrArg(siblings.map((s) => pad(s))),
    arrArg(onRight.map((b) => word(b ? 1 : 0))),
  ];
  let offset = 5 * 32;                       // height + four dynamic heads
  const heads = tails.map((t) => { const h = word(offset); offset += t.length / 2; return h; });
  return sel('claim(uint256,bytes,bytes,bytes32[],bool[])') + word(height) + heads.join('') + tails.join('');
}

const txHash = args.tx;
if (!/^0x[0-9a-f]{64}$/i.test(txHash ?? '')) throw new Error('--tx <molibra burn tx hash> is required');

const p = await (await fetch(`${NODE}/molibra/proof/${txHash}`, { signal: AbortSignal.timeout(30000) })).json();
if (p.error) throw new Error(`proof: ${p.error}`);
const siblings = (p.proof ?? p.siblings ?? []).map((s) => s.hash ?? s.sibling ?? s);
const onRight = (p.proof ?? p.siblings ?? []).map((s) => s.onRight ?? s.right ?? s.siblingOnRight);
console.log(`burn tx       : ${txHash}`);
console.log(`  block       : ${p.blockNumber}  ${p.blockHash}`);
console.log(`  canonical   : ${p.canonicalOnThisNode}`);
console.log(`  merkle path : ${siblings.length} sibling(s)`);

const data = encodeClaim(p.blockNumber, p.headerRlp, p.raw, siblings, onRight);
const now = parseInt((await rpc('eth_blockNumber', [])).result, 16);
const st = (await rpc('eth_call', [{ to: TOKEN, data: sel('status(uint256)') + word(p.blockNumber) }, 'latest'])).result;
const at = Number(BigInt('0x' + st.slice(130, 194))) + 7200;
console.log(`token         : ${TOKEN}`);
console.log(`  supply now  : ${BigInt('0x' + st.slice(194, 258))}`);
console.log(`  usable at   : eth block ${at}  (now ${now}, ${at - now} to go)`);

const out = await rpc('eth_call', [{ to: TOKEN, from: FROM, data }, 'latest']);
if (!out.error) {
  console.log('pre-flight    : ⭐ CLEAN — this claim would mint. Nothing has been sent.');
  process.exit(0);
}
const revert = out.error?.data?.data ?? out.error?.data ?? '';
const name = ERRORS[String(revert).slice(0, 10)];
console.log(`pre-flight    : reverts ${name ?? JSON.stringify(out.error).slice(0, 200)}`);
process.exit(1);
