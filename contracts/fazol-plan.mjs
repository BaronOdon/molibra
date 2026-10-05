/**
 * FAZOL: build every transaction the operator will sign, and SIMULATE them
 * against live chains. Sends nothing, signs nothing.
 *
 *   Ethereum (eth_simulateV1 on a public node, one simulated block, in order):
 *     E1 deploy MemeToken "Faz o L" / FAZOL, 1e9 to the operator
 *     E2 FAZOL.approve(Permit2, v4Seed)
 *     E3 Permit2.approve(FAZOL, PositionManager, v4Seed, +30 days)
 *     E4 PositionManager.multicall([initializePool, modifyLiquidities(MINT_POSITION, SETTLE_PAIR)])
 *     -- then reads: StateView.getSlot0, V4Quoter for a small buy
 *     E5 FAZOL.burn(bridgeIn)  -> the Transfer-to-zero log the inbound bridge proves
 *   Molibra (live node, eth_estimateGas simulates a CREATE):
 *     factory, CARAMELO, BOLSO, FAZOL BridgedAsset deploys; the BRIDGE_REGISTER payload
 *
 * Encoders are the PAGE's (src/web/memes.html ABI region), so what is simulated
 * here is what the page will send. Writes contracts/fazol-plan.json and
 * contracts/etherscan/FAZOL.verify.json.
 *
 *   node contracts/fazol-plan.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RLP } from '@ethereumjs/rlp';

import { keccak256, toHex, fromHex } from '../src/crypto.js';
import { foreignTokenId } from '../src/foreign.js';
import { bridgeAuthority, encodeBridgeRegister } from '../src/bridgemint.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const page = read('src/web/memes.html');
const REG = JSON.parse(read('src/web/markets.json'));
const MEME = JSON.parse(read('contracts/artifacts/MemeToken.json'));
const region = page.match(/\/\* ABI-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* ABI-END \*\//)[1];
const L = new Function(region + `
return { word, addr32, encCtor, encBridgedCtor, parseDec, parityTokens, v4Plan, encPermit2Approve,
  bridgeIds, encBridgeRegister, sqrtAtTick, isqrt };`)();
const pageConst = (n) => page.match(new RegExp(`const ${n} = '([^']*)';`))[1];

const ETH_RPC = process.env.ETH_RPC ?? 'https://ethereum-rpc.publicnode.com';
const MOLIBRA_RPC = process.env.MOLIBRA_RPC ?? 'https://molibra.org/molibra';
const OP = '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a';
const POSM = '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e';
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const STATE_VIEW = '0x7ffe42c4a5deea5b0fec41c94c136cf115597227';
const V4_QUOTER = '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203';
const POOL_MANAGER = '0x000000000004444c5dc75cb358380d2e3de08a90';
const CHAINLINK = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419';
const BMOLI_POOL_ID = '0x200f192a14c85d09943f76ae3def3ffe596d93594b6d8ab55b99cdf612b4c312';
const TIP = 50_000_000n;   // 0.05 gwei

const sel = (s) => toHex(keccak256(new TextEncoder().encode(s))).slice(0, 10);
const kec = (hex) => toHex(keccak256(fromHex('0x' + String(hex).replace(/^0x/, ''))));
const rpc = async (url, method, params) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}${j.error.data ? ' ' + JSON.stringify(j.error.data) : ''}`);
  return j.result;
};
const eth = (m, p) => rpc(ETH_RPC, m, p);
const mol = (m, p) => rpc(MOLIBRA_RPC, m, p);
const hx = (v) => '0x' + BigInt(v).toString(16);
const f18 = (v, d = 6) => (Number(v) / 1e18).toFixed(d);

let pass = 0, fail = 0;
const check = (l, ok, d = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? '  ' + d : ''}`); };

/* --------------------------------------------------------- live inputs */
const fz = REG.markets.find((m) => m.key === 'fazol');
const E = fz.meme.ethereum;
const block = await eth('eth_getBlockByNumber', ['latest', false]);
const base = BigInt(block.baseFeePerGas);
const nonce = BigInt(await eth('eth_getTransactionCount', [OP, 'latest']));
const ethBal = BigInt(await eth('eth_getBalance', [OP, 'latest']));
const lr = await eth('eth_call', [{ to: CHAINLINK, data: sel('latestRoundData()') }, 'latest']);
const ethUsdE18 = BigInt('0x' + lr.slice(66, 130)) * 10n ** 10n;
const slot = await eth('eth_call', [{ to: STATE_VIEW, data: sel('getSlot0(bytes32)') + BMOLI_POOL_ID.slice(2) }, 'latest']);
const sqB = BigInt('0x' + slot.slice(2, 66));
const moliUsdE18 = (ethUsdE18 << 192n) / (sqB * sqB);
let cpUsd = REG.counterparts[fz.meme.counterpart].usd; let cpSrc = 'markets.json snapshot ' + REG.snapshot.at;
try {
  const j = await (await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${fz.meme.counterpart}&vs_currencies=usd&include_last_updated_at=true`)).json();
  if (j[fz.meme.counterpart]?.usd) {
    cpUsd = String(j[fz.meme.counterpart].usd);
    cpSrc = `CoinGecko live, last_updated ${new Date(j[fz.meme.counterpart].last_updated_at * 1000).toISOString()}`;
  }
} catch { /* keep the snapshot */ }
const tokUsdE18 = L.parseDec(cpUsd);
console.log(`Ethereum block ${BigInt(block.number)} · base fee ${(Number(base) / 1e9).toFixed(4)} gwei`);
console.log(`ETH US$ ${f18(ethUsdE18, 4)} (Chainlink) · MOLI US$ ${f18(moliUsdE18, 8)} · ${fz.meme.counterpart} US$ ${cpUsd} (${cpSrc})`);
console.log(`operator: nonce ${nonce}, ${f18(ethBal, 6)} ETH\n`);

/* ------------------------------------------------- the transactions */
const nonceBytes = (n) => { if (n === 0n) return new Uint8Array(); let h = n.toString(16); if (h.length % 2) h = '0' + h; return fromHex('0x' + h); };
// CREATE address = last20(keccak(rlp([sender, nonce])))
const predicted = '0x' + kec(toHex(RLP.encode([fromHex(OP), nonceBytes(nonce)]))).slice(-40);
const SUPPLY = L.parseDec(fz.meme.supply);
const ctorArgs = L.encCtor(fz.meme.name, 'FAZOL', fz.meme.description, SUPPLY, OP);
const deployData = MEME.bytecode + ctorArgs;
const V4SEED = L.parseDec(E.v4Seed);
const BURN = L.parseDec(E.bridgeIn);
const now = BigInt(Math.floor(Date.now() / 1000));
const v = L.v4Plan({ token: predicted, ethUsdE18, tokenUsdE18: tokUsdE18, amount1: V4SEED, fee: BigInt(E.v4Fee),
  tickSpacing: BigInt(E.v4TickSpacing), multiple: E.v4RangeMultiple, owner: OP, deadline: now + 3600n });
const poolId = kec(v.poolKeyHex);
const txs = [
  { step: 'E1 deploy FAZOL', from: OP, data: deployData },
  { step: 'E2 FAZOL.approve(Permit2)', from: OP, to: predicted, data: sel('approve(address,uint256)') + L.addr32(PERMIT2) + L.word(V4SEED) },
  { step: 'E3 Permit2.approve(FAZOL, PositionManager)', from: OP, to: PERMIT2, data: L.encPermit2Approve(predicted, POSM, V4SEED, now + 30n * 86400n) },
  { step: 'E4 PositionManager.multicall(initializePool, mint)', from: OP, to: POSM, data: v.data },
  { step: 'E5 FAZOL.burn(bridgeIn)', from: OP, to: predicted, data: sel('burn(uint256)') + L.word(BURN) },
];
const KEYT = L.addr32('0x' + '00'.repeat(20)) + L.addr32(predicted) + L.word(E.v4Fee) + L.word(E.v4TickSpacing) + L.addr32('0x' + '00'.repeat(20));
// quoteExactInputSingle(((PoolKey),bool zeroForOne,uint128 exactAmount,bytes hookData)) - 0.001 ETH in
const QUOTE_IN = 10n ** 15n;
const quoteData = sel('quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))')
  + L.word(32) + KEYT + L.word(1) + L.word(QUOTE_IN) + L.word(32 * 8) + L.word(0);
const reads = [
  { step: 'read getSlot0', from: OP, to: STATE_VIEW, data: sel('getSlot0(bytes32)') + poolId.slice(2) },
  { step: 'read PoolManager FAZOL balance', from: OP, to: predicted, data: sel('balanceOf(address)') + L.addr32(POOL_MANAGER) },
  { step: 'read V4Quoter 0.001 ETH -> FAZOL', from: OP, to: V4_QUOTER, data: quoteData },
];
const order = [txs[0], txs[1], txs[2], txs[3], ...reads, txs[4]];
const sim = await eth('eth_simulateV1', [{
  blockStateCalls: [{ calls: order.map((c) => ({ from: c.from, ...(c.to ? { to: c.to } : {}), data: c.data, gas: hx(3_000_000) })) }],
  validation: false, traceTransfers: false,
}, 'latest']);
const res = sim[0].calls;
order.forEach((c, i) => { c.sim = res[i]; });

console.log('Ethereum, simulated in order with eth_simulateV1:');
for (const c of order) {
  const ok = c.sim.status === '0x1';
  check(`${c.step}`, ok, `gas ${BigInt(c.sim.gasUsed)}${ok ? '' : ' ' + JSON.stringify(c.sim.error ?? c.sim.returnData).slice(0, 160)}`);
}
const created = res[0].logs?.[0]?.address?.toLowerCase();
check('E1 deploys at the address predicted from the operator nonce', created === predicted, `${predicted} (nonce ${nonce})`);
const s0 = res[4].returnData;
const simSqrt = BigInt('0x' + s0.slice(2, 66));
const simTick = BigInt.asIntN(24, BigInt('0x' + s0.slice(66, 130)));
check('the pool is initialised at the parity sqrtPriceX96', simSqrt === v.sqrtPriceX96, simSqrt.toString());
check('  and its tick is the page\'s tickAtSqrt (TickMath port agrees with the chain)', simTick === v.tick, `tick ${simTick}`);
const pmBal = BigInt(res[5].returnData);
check('the PoolManager holds the FAZOL the page said the position needs', pmBal === v.needed, `${f18(pmBal, 4)} FAZOL`);
const qOut = BigInt('0x' + res[6].returnData.slice(2, 66));
const parityOut = (QUOTE_IN * ethUsdE18) / tokUsdE18;
check('a 0.001 ETH buy is quoted near parity, less the 0.25% fee and the 25-tick gap',
  qOut < parityOut && qOut * 1000n > parityOut * 990n, `${f18(qOut, 4)} FAZOL vs ${f18(parityOut, 4)} at parity`);
const burnLog = res[7].logs?.find((l) => l.topics?.[2] === '0x' + '00'.repeat(32));
check('E5 burn emits Transfer(operator, 0x0, amount) from FAZOL - what src/burnproof.js proves',
  !!burnLog && burnLog.address.toLowerCase() === predicted && BigInt(burnLog.data) === BURN && burnLog.topics[1].endsWith(OP.slice(2)));

// Fees: what each signature costs at today's base fee, worst case 2×base + tip.
const gasOf = (c) => (BigInt(c.sim.gasUsed) * 125n) / 100n;
let worst = 0n; let likely = 0n;
for (const c of txs) { c.gas = gasOf(c); worst += c.gas * (2n * base + TIP); likely += BigInt(c.sim.gasUsed) * (base + TIP); }
console.log(`\n  Ethereum cost, 5 signatures: likely ${f18(likely, 6)} ETH (~US$ ${(Number(likely) / 1e18 * Number(ethUsdE18) / 1e18).toFixed(2)}), ceiling ${f18(worst, 6)} ETH; operator holds ${f18(ethBal, 6)} ETH`);
// A wallet requires gas × maxFee for the transaction in hand, on top of what the
// earlier ones actually spent (base + tip), so check it in order, one at a time.
{
  let left = ethBal; let short = null;
  for (const c of txs) {
    if (left < c.gas * (2n * base + TIP)) { short = c.step; break; }
    left -= BigInt(c.sim.gasUsed) * (base + TIP);
  }
  check('the operator\'s ETH covers each signature\'s fee ceiling, in order', !short,
    short ? `short at ${short}: top up or wait for a lower base fee` : `${f18(left, 6)} ETH left after all five`);
  if (ethBal <= worst) console.log('  note: the SUM of all five ceilings exceeds the balance; only the in-order check binds');
}

/* -------------------------------------------------------- Molibra */
console.log('\nMolibra, simulated on the live node (eth_estimateGas runs the CREATE):');
const ids = { tokenId: foreignTokenId(1n, predicted) };
ids.authority = bridgeAuthority(ids.tokenId);
const pageIds = L.bridgeIds(kec, 1, predicted);
check('page and src agree on the FAZOL token id and keyless authority', pageIds.tokenId === ids.tokenId && pageIds.authority === ids.authority, ids.authority);
const molBal = BigInt(await mol('eth_getBalance', [OP, 'latest']));
const molGas = {};
const est = async (label, data) => { try { molGas[label] = BigInt(await mol('eth_estimateGas', [{ from: OP, data }])); check(`${label} would deploy`, true, `gas ${molGas[label]}`); } catch (e) { check(`${label} would deploy`, false, e.message); } };
await est('factory', pageConst('FACTORY_BYTECODE'));
for (const key of ['caramelo', 'bolso']) {
  const m = REG.markets.find((x) => x.key === key);
  await est(m.symbol, MEME.bytecode + L.encCtor(m.meme.name, m.symbol, m.meme.description, L.parseDec(m.meme.supply), OP));
}
const bridgedData = pageConst('BRIDGED_BYTECODE') + L.encBridgedCtor(fz.meme.name, 'FAZOL', ids.authority);
await est('FAZOL BridgedAsset', bridgedData);
const CAP = L.parseDec(E.bridgeCap);
const registerFor = (asset) => encodeBridgeRegister({ originChainId: 1n, contract: predicted, assetContract: asset, cap: CAP, symbol: 'FAZOL' });
check('page encBridgeRegister == src encodeBridgeRegister', L.encBridgeRegister(1, predicted, OP, CAP, 'FAZOL') === registerFor(OP));
console.log(`  operator holds ${f18(molBal, 3)} MOLI on Molibra`);

/* ---------------------------------------------------------- outputs */
const plan = {
  generated: new Date().toISOString(),
  inputs: { ethBlock: Number(BigInt(block.number)), baseFeeGwei: Number(base) / 1e9, ethUsd: f18(ethUsdE18, 4), moliUsd: f18(moliUsdE18, 10),
    counterpart: fz.meme.counterpart, counterpartUsd: cpUsd, counterpartSource: cpSrc, operatorEthNonce: Number(nonce), operatorEth: f18(ethBal, 6) },
  ethereum: {
    fazol: { predictedAddress: predicted, validOnlyIfNextTxFromOperatorIsTheDeploy: true, name: fz.meme.name, symbol: 'FAZOL', supply: fz.meme.supply },
    pool: { key: v.key, poolId, sqrtPriceX96: v.sqrtPriceX96.toString(), tick: Number(v.tick), tickLower: Number(v.tickLower), tickUpper: Number(v.tickUpper),
      liquidity: v.liquidity.toString(), fazolIn: v.needed.toString(), fazolPerEth: f18((ethUsdE18 * 10n ** 18n) / tokUsdE18, 4) },
    txs: txs.map((c) => ({ step: c.step, to: c.to ?? null, data: c.data, simulatedGasUsed: Number(BigInt(c.sim.gasUsed)), gas: Number(c.gas),
      maxPriorityFeePerGas: TIP.toString(), maxFeePerGas: (2n * base + TIP).toString(), status: c.sim.status })),
    costEth: { likely: f18(likely, 6), ceiling: f18(worst, 6) },
  },
  molibra: {
    fazolForeignAssetId: ids.tokenId, fazolBridgeAuthority: ids.authority,
    bridgedAssetDeploy: { data: bridgedData, estimateGas: String(molGas['FAZOL BridgedAsset'] ?? '') },
    bridgeRegister: { to: '<the BridgedAsset address from its receipt>', cap: E.bridgeCap,
      payloadTemplate: registerFor('0x' + 'aa'.repeat(20)).replace('aa'.repeat(20), '<BridgedAsset address, 20 bytes>'), gas: 500000 },
    estimateGas: Object.fromEntries(Object.entries(molGas).map(([k, g]) => [k, String(g)])),
  },
};
writeFileSync(join(HERE, 'fazol-plan.json'),
  JSON.stringify(plan, (k, x) => (typeof x === 'bigint' ? x.toString() : x), 2) + '\n');
mkdirSync(join(HERE, 'etherscan'), { recursive: true });
writeFileSync(join(HERE, 'etherscan', 'FAZOL.verify.json'), JSON.stringify({
  howTo: 'Etherscan > Verify & Publish > Solidity (Standard-Json-Input). Upload MemeToken.standard-input.json; compiler and constructor arguments below.',
  chainId: 1, address: predicted, addressNote: 'predicted from the operator nonce; use the receipt address if it differs',
  contractName: 'contracts/MemeToken.sol:MemeToken', compilerVersion: 'v' + MEME.compiler.replace('.Emscripten.clang', ''),
  optimization: true, runs: 200, evmVersion: 'paris', licenseType: 'Apache-2.0',
  standardJsonInput: 'MemeToken.standard-input.json', constructorArguments: ctorArgs,
}, null, 2) + '\n');
console.log(`\nwrote contracts/fazol-plan.json and contracts/etherscan/FAZOL.verify.json\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
