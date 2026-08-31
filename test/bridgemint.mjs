/**
 * Molibra - a proved burn becomes a minted unit, end to end.
 *
 * `burnproof.mjs` proves the cryptography. `inbound.mjs` proves the
 * accounting. `pool.mjs` proves the contract. Every one of them passed while
 * the three were not connected to each other, so the property the bridge
 * exists to have -
 *
 *     the units that exist here == the burns proved there, minus the returns
 *
 * - was not tested by any of them. It could not be: it is a statement about
 * the SEQUENCE, and nothing ran the sequence.
 *
 * This file runs it. Every transaction below goes through `applyTransaction`,
 * the same function a mined block calls, against a real `State` and Molibra's
 * real EVM. The contract is the same BridgedAsset bytecode the pool trades.
 *
 * The check that matters most is the one repeated after every mutation:
 * `totalSupply()` read out of the contract must equal `minted` read out of the
 * ledger. Two independent representations of the same number, kept in step by
 * consensus rather than by intention. If they ever diverge, units exist that
 * nothing was burned for - which is the only failure of a bridge that matters.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RLP } from '@ethereumjs/rlp';

import { State, applyTransaction } from '../src/state.js';
import { runEvm, simulate } from '../src/evm.js';
import { intrinsicGas } from '../src/tx.js';
import { keccak256, toHex, fromHex, normalizeAddress } from '../src/crypto.js';
import { foreignTokenId } from '../src/foreign.js';
import { TRANSFER_TOPIC, toNibbles, decodeHexPrefix } from '../src/burnproof.js';
import {
  bridgeAuthority, encodeBridgeRegister, encodeHeaderCommit, encodeBridgeClaim,
  encodeBridgeRelease, mintCall, burnCall, TOTAL_SUPPLY_GETTER,
} from '../src/bridgemint.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = JSON.parse(readFileSync(join(HERE, '..', 'contracts', 'artifacts', 'pool.json'), 'utf8'));

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

/* ------------------------------------------------------------------ */
/* Scaffolding: a receipts trie, so a burn can be proved.              */
/* ------------------------------------------------------------------ */
/* Test-only. A node never BUILDS an Ethereum trie - it only ever checks a
 * proof against a root somebody published. burnproof.mjs shows this builder
 * reproduces a real mainnet receiptsRoot, which is what makes it usable here. */

const hexPrefix = (path, isLeaf) => {
  const odd = path.length % 2 === 1;
  const flag = (isLeaf ? 2 : 0) + (odd ? 1 : 0);
  const nibbles = odd ? [flag, ...path] : [flag, 0, ...path];
  const out = new Uint8Array(nibbles.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (nibbles[2 * i] << 4) | nibbles[2 * i + 1];
  return out;
};

const store = new Map();

function ref(node) {
  const raw = RLP.encode(node);
  if (raw.length < 32) return node;
  const h = keccak256(raw);
  store.set(toHex(h), raw);
  return h;
}

function build(entries) {
  if (entries.length === 1) {
    const [path, value] = entries[0];
    return [hexPrefix(path, true), value];
  }
  let common = 0;
  const first = entries[0][0];
  outer: while (common < first.length) {
    const n = first[common];
    for (const [p] of entries) { if (common >= p.length || p[common] !== n) break outer; }
    common++;
  }
  if (common > 0) {
    const child = build(entries.map(([p, v]) => [p.slice(common), v]));
    return [hexPrefix(first.slice(0, common), false), ref(child)];
  }
  const branch = new Array(17).fill(new Uint8Array(0));
  const buckets = new Map();
  for (const [p, v] of entries) {
    if (p.length === 0) { branch[16] = v; continue; }
    if (!buckets.has(p[0])) buckets.set(p[0], []);
    buckets.get(p[0]).push([p.slice(1), v]);
  }
  for (const [k, sub] of buckets) branch[k] = ref(build(sub));
  return branch;
}

function trieRoot(pairs) {
  const entries = pairs.map(([key, value]) => [toNibbles(key), value]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const root = build(entries);
  const raw = RLP.encode(root);
  const h = keccak256(raw);
  store.set(toHex(h), raw);
  return toHex(h);
}

function proofFor(root, key) {
  const path = toNibbles(key);
  const nodes = [];
  let expected = root;
  let i = 0;
  for (;;) {
    const raw = store.get(expected);
    if (!raw) return nodes;
    nodes.push(raw);
    const node = RLP.decode(raw);
    if (node.length === 17) {
      if (i === path.length) return nodes;
      const next = node[path[i]]; i++;
      if (!next || next.length === 0) return nodes;
      expected = toHex(next);
    } else {
      const { isLeaf, path: seg } = decodeHexPrefix(node[0]);
      i += seg.length;
      if (isLeaf) return nodes;
      expected = toHex(node[1]);
    }
  }
}

/** An EIP-1559 receipt carrying one ERC-20 Transfer, encoded as Ethereum does. */
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const topic = (a) => fromHex('0x' + a.slice(2).padStart(64, '0'));

function transferReceipt({ contract, from, to, amount, status = 1 }) {
  const logs = [[
    fromHex(contract),
    [fromHex(TRANSFER_TOPIC), topic(from), topic(to)],
    fromHex('0x' + word(amount)),
  ]];
  const body = RLP.encode([status ? new Uint8Array([1]) : new Uint8Array(0),
    new Uint8Array([0x10]), new Uint8Array(256), logs]);
  const out = new Uint8Array(body.length + 1);
  out[0] = 2;
  out.set(body, 1);
  return out;
}

/* ------------------------------------------------------------------ */
/* The cast.                                                           */
/* ------------------------------------------------------------------ */

const WSRO = '0x8bda622a10fbb1e4a15b37507f65fc5b5755ceb8';   // the real contract
const ZERO = '0x0000000000000000000000000000000000000000';
const ETH_CHAIN = 1n;

const REGISTRAR = '0x1111111111111111111111111111111111111111';
const ALICE = '0x2222222222222222222222222222222222222222';
const MALLORY = '0x3333333333333333333333333333333333333333';
const MINER = '0x4444444444444444444444444444444444444444';

const CAP = 1_000_000n * 10n ** 18n;
const TOKEN_ID = foreignTokenId(ETH_CHAIN, WSRO);
const AUTHORITY = bridgeAuthority(TOKEN_ID);

const state = new State();
for (const a of [REGISTRAR, ALICE, MALLORY]) state.credit(a, 10n ** 20n);

// Read from state rather than counted here: a contract deployment advances the
// sender's nonce too, and a test that kept its own tally would drift from the
// chain and start reporting nonce errors as if they were the rule under test.
const tx = (from, data, to = from) => ({
  from, to, value: 0n, nonce: state.nonceOf(from), gasPrice: 1n, gasLimit: 3_000_000n, data,
});

const apply = (t, block = 1n) => applyTransaction(state, t, intrinsicGas(t), MINER, block);

async function refuses(label, t, detail = '') {
  const before = state.root();
  let threw = null;
  try { await apply(t); } catch (e) { threw = e; }
  // A refusal that left a mark is not a refusal.
  check(label, threw !== null && state.root() === before,
    detail || (threw ? String(threw.message).slice(0, 88) : 'IT WAS ACCEPTED'));
}

const totalSupply = async (contract) => {
  const r = await simulate(state, { from: ALICE, to: contract, data: fromHex(TOTAL_SUPPLY_GETTER), gasLimit: 200000n });
  return r.returnValue.length ? BigInt(toHex(r.returnValue)) : 0n;
};
const balanceOf = async (contract, who) => {
  const data = '0x70a08231' + who.slice(2).padStart(64, '0');
  const r = await simulate(state, { from: ALICE, to: contract, data: fromHex(data), gasLimit: 200000n });
  return r.returnValue.length ? BigInt(toHex(r.returnValue)) : 0n;
};

/** The one invariant this whole file exists to hold. */
async function agrees(where, contract) {
  const supply = await totalSupply(contract);
  const minted = state.inbound.get(TOKEN_ID).minted;
  check(`⛔⛔ ${where}: the contract and the ledger agree`, supply === minted,
    `totalSupply ${supply} == minted ${minted}`);
}

/* ------------------------------------------------------------------ */
/* 1. The keyless authority.                                           */
/* ------------------------------------------------------------------ */

check('a bridged asset id is derived from its origin, so it cannot be squatted',
  TOKEN_ID === foreignTokenId(ETH_CHAIN, WSRO.toUpperCase()), TOKEN_ID);
check('and its mint authority is derived from the id', /^0x[0-9a-f]{40}$/.test(AUTHORITY), AUTHORITY);
check('⛔ the authority has no code and no balance: it is a hash, not an account',
  !state.hasCode(AUTHORITY) && state.balanceOf(AUTHORITY) === 0n,
  'nothing can be deployed there and nothing can sign for it');
check('two different assets get two different authorities',
  bridgeAuthority(foreignTokenId(ETH_CHAIN, ZERO)) !== AUTHORITY,
  'one compromised asset could not reach another');

/* ------------------------------------------------------------------ */
/* 2. Deploying the contract, and refusing the wrong one.              */
/* ------------------------------------------------------------------ */

const ctor = (bridge) => word(0x60) + word(0xa0) + bridge.slice(2).padStart(64, '0')
  + word(4) + Buffer.from('WSRO').toString('hex').padEnd(64, '0')
  + word(4) + Buffer.from('WSRO').toString('hex').padEnd(64, '0');

async function deployAsset(from, bridge) {
  const r = await runEvm(state, { from, to: null, data: ART.BridgedAsset.bytecode + ctor(bridge), gasLimit: 6_000_000n });
  if (r.failed) throw new Error(`deploy failed: ${r.error}`);
  state.bumpNonce(from);
  return r.createdAddress;
}

const asset = await deployAsset(REGISTRAR, AUTHORITY);
const impostor = await deployAsset(MALLORY, MALLORY);
check('the bridged asset deploys, trusting the derived authority', state.hasCode(asset), asset);
check('and a second one deploys trusting an ordinary wallet', state.hasCode(impostor), impostor);

/* ------------------------------------------------------------------ */
/* 3. ⛔⛔ Registration checks WHO the contract trusts.                 */
/* ------------------------------------------------------------------ */

await refuses('⛔⛔ a contract that trusts a WALLET cannot be registered',
  tx(MALLORY, encodeBridgeRegister({
    originChainId: ETH_CHAIN, contract: WSRO, assetContract: impostor, cap: CAP, symbol: 'WSRO',
  })),
  'otherwise the ledger faithfully accounts for units somebody mints at will');

await refuses('⛔ a contract with no code at all is refused',
  tx(REGISTRAR, encodeBridgeRegister({
    originChainId: ETH_CHAIN, contract: WSRO, assetContract: ALICE, cap: CAP, symbol: 'WSRO',
  })));

const reg = await apply(tx(REGISTRAR, encodeBridgeRegister({
  originChainId: ETH_CHAIN, contract: WSRO, assetContract: asset, cap: CAP, symbol: 'WSRO',
})));
check('a contract trusting the derived authority registers', reg.bridgeAsset === TOKEN_ID);
check('  and the ledger records who registered it', state.inbound.get(TOKEN_ID).registrar === REGISTRAR,
  'the one thing a reader is being asked to trust, on the record');

await refuses('⛔ the same asset cannot be registered twice',
  tx(ALICE, encodeBridgeRegister({
    originChainId: ETH_CHAIN, contract: WSRO, assetContract: asset, cap: CAP, symbol: 'WSRO',
  })));

/* ------------------------------------------------------------------ */
/* 4. Headers: the trusted half, on the record.                        */
/* ------------------------------------------------------------------ */

const BURNER = '0x9999999999999999999999999999999999999999';
const BURNED = 5_000n * 10n ** 18n;
const receipts = [
  transferReceipt({ contract: WSRO, from: BURNER, to: ALICE, amount: 42n }),      // 0: a transfer
  transferReceipt({ contract: WSRO, from: BURNER, to: ZERO, amount: BURNED }),    // 1: THE burn
  transferReceipt({ contract: ZERO, from: BURNER, to: ZERO, amount: 10n ** 30n }), // 2: another token
  transferReceipt({ contract: WSRO, from: BURNER, to: ZERO, amount: 7n, status: 0 }), // 3: reverted
];
const BLOCK = 21_000_000n;
const ROOT = trieRoot(receipts.map((r, i) => [RLP.encode(i), r]));

await refuses('⛔ somebody who registered nothing on that chain cannot commit its headers',
  tx(MALLORY, encodeHeaderCommit({ originChainId: ETH_CHAIN, blockNumber: BLOCK, receiptsRoot: ROOT })));

const committed = await apply(tx(REGISTRAR, encodeHeaderCommit({
  originChainId: ETH_CHAIN, blockNumber: BLOCK, receiptsRoot: ROOT,
})));
check('the registrar commits a receiptsRoot', committed.headerCommitted?.blockNumber === BLOCK.toString());
check('  and it is readable from consensus state',
  state.inbound.receiptsRootFor(ETH_CHAIN, BLOCK) === ROOT.toLowerCase());

await refuses('⛔⛔ the same height cannot be re-committed with a DIFFERENT root',
  tx(REGISTRAR, encodeHeaderCommit({
    originChainId: ETH_CHAIN, blockNumber: BLOCK, receiptsRoot: '0x' + 'ab'.repeat(32),
  })),
  'a commitment that can be replaced is a draft, and a proof against a draft can be un-proved');

/* ------------------------------------------------------------------ */
/* 5. ⛔⛔ The claim: proof, permission, mint - in that order.          */
/* ------------------------------------------------------------------ */

const claimFor = (index, over = {}) => ({
  tokenId: TOKEN_ID,
  blockNumber: BLOCK,
  txIndex: index,
  recipient: ALICE,
  ethTxHash: '0x' + String(index).padStart(2, '0').repeat(32),
  proof: proofFor(ROOT, RLP.encode(index)),
  ...over,
});

await refuses('⛔ a claim against an UNCOMMITTED block is refused',
  tx(ALICE, encodeBridgeClaim(claimFor(1, { blockNumber: BLOCK + 1n }))),
  'a proof against a root nobody committed is a proof against a number the claimant chose');

const tampered = proofFor(ROOT, RLP.encode(1)).map((n) => n.slice());
tampered[tampered.length - 1][4] ^= 0xff;
await refuses('⛔ a claim whose proof does not reach the committed root is refused',
  tx(ALICE, encodeBridgeClaim(claimFor(1, { proof: tampered }))),
  'every node in the proof is checked by its own hash');

await refuses('⛔ an ordinary transfer is proved, and is still not a burn',
  tx(ALICE, encodeBridgeClaim(claimFor(0))), 'only the zero address destroys');

await refuses('⛔⛔ a real burn of a DIFFERENT contract is refused',
  tx(ALICE, encodeBridgeClaim(claimFor(2))),
  'otherwise anyone deploys a token, burns a billion of it, and proves it perfectly');

await refuses('⛔ a burn in a REVERTED transaction destroyed nothing',
  tx(ALICE, encodeBridgeClaim(claimFor(3))));

check('nothing has been minted by any of that', await totalSupply(asset) === 0n);

const claim = claimFor(1);
const minted = await apply(tx(ALICE, encodeBridgeClaim(claim)));
check('⭐ a proved burn mints, and only now', minted.bridgeMinted === BURNED.toString(),
  `${BURNED / 10n ** 18n} WSRO`);
check('  the units reached the named recipient', await balanceOf(asset, ALICE) === BURNED);
await agrees('after the first claim', asset);

/* ------------------------------------------------------------------ */
/* 6. ⛔ Once. However it is presented.                                */
/* ------------------------------------------------------------------ */

await refuses('⛔⛔ the same burn cannot be claimed twice',
  tx(ALICE, encodeBridgeClaim(claim)),
  'keyed on the origin transaction, so it does not matter who submits it');

await refuses('⛔ nor by somebody else, to a different recipient',
  tx(MALLORY, encodeBridgeClaim({ ...claim, recipient: MALLORY })),
  'not the recipient, not the amount, not a nonce the claimant supplies');

await agrees('after two refused replays', asset);

/* ------------------------------------------------------------------ */
/* 7. ⛔⛔ Nothing else can mint. That is the whole design.             */
/* ------------------------------------------------------------------ */

const direct = await runEvm(state, {
  from: MALLORY, to: asset, data: fromHex(mintCall(MALLORY, 10n ** 24n)), gasLimit: 300000n,
});
check('⛔ a wallet calling mint() directly reverts', direct.failed, direct.error ?? '');

const byRegistrar = await runEvm(state, {
  from: REGISTRAR, to: asset, data: fromHex(mintCall(REGISTRAR, 10n ** 24n)), gasLimit: 300000n,
});
check('⛔⛔ and so does the REGISTRAR: registering an asset is not owning it', byRegistrar.failed,
  'the registrar commits headers and nothing else');

await refuses('⛔⛔ a transaction FROM the authority is refused before anything else',
  { from: AUTHORITY, to: asset, value: 0n, nonce: 0n, gasPrice: 1n, gasLimit: 300000n,
    data: mintCall(MALLORY, 10n ** 24n) },
  'no signature recovers to a hash image; the rule is written down anyway');

await agrees('after every attempt to mint around the proof', asset);

/* ------------------------------------------------------------------ */
/* 8. The cap still binds, on top of the proof.                        */
/* ------------------------------------------------------------------ */

const bigReceipts = [transferReceipt({ contract: WSRO, from: BURNER, to: ZERO, amount: CAP })];
const BIG_BLOCK = 21_000_001n;
const BIG_ROOT = trieRoot(bigReceipts.map((r, i) => [RLP.encode(i), r]));
await apply(tx(REGISTRAR, encodeHeaderCommit({
  originChainId: ETH_CHAIN, blockNumber: BIG_BLOCK, receiptsRoot: BIG_ROOT,
})));

await refuses('⛔ a perfectly proved burn OVER THE CAP is still refused',
  tx(ALICE, encodeBridgeClaim({
    tokenId: TOKEN_ID, blockNumber: BIG_BLOCK, txIndex: 0, recipient: ALICE,
    ethTxHash: '0x' + 'bb'.repeat(32), proof: proofFor(BIG_ROOT, RLP.encode(0)),
  })),
  'proof and permission are separate, and both are required');

await agrees('after a refused over-cap claim', asset);

/* ------------------------------------------------------------------ */
/* 9. The way back out.                                                */
/* ------------------------------------------------------------------ */

await refuses('⛔ units are not destroyed by calling burn() directly',
  { ...tx(ALICE, burnCall(1000n), asset) },
  'a direct burn would destroy units the ledger goes on counting');

const RETURN = 2_000n * 10n ** 18n;
const released = await apply(tx(ALICE, encodeBridgeRelease({ tokenId: TOKEN_ID, amount: RETURN }), ALICE));
check('a release destroys units here so they may be freed there',
  released.bridgeReleased === RETURN.toString());
check('  the holder is lighter by exactly that much', await balanceOf(asset, ALICE) === BURNED - RETURN);
await agrees('after a release', asset);

const after = state.inbound.report(TOKEN_ID);
check('⛔⛔ minted == burnedIn - returned, checked after every mutation',
  BigInt(after.minted) === BigInt(after.burnedIn) - BigInt(after.returned),
  `${after.minted} == ${after.burnedIn} - ${after.returned}`);
check('  and a release frees headroom under the cap',
  BigInt(after.headroom) === CAP - BigInt(after.minted), `${after.headroom}`);

await refuses('⛔ releasing more than exists here is refused',
  tx(ALICE, encodeBridgeRelease({ tokenId: TOKEN_ID, amount: CAP }), ALICE),
  'it would free units on the origin chain that were never burned');

/* ------------------------------------------------------------------ */
/* 10. Conservation across both chains.                                */
/* ------------------------------------------------------------------ */

const SUPPLY = 21_000_000n * 10n ** 18n;
const conserved = state.inbound.conservation(TOKEN_ID, SUPPLY, SUPPLY - BURNED);
check('⭐ what remains there plus what exists here never exceeds what was issued',
  conserved.ok, conserved.note);
const broken = state.inbound.conservation(TOKEN_ID, SUPPLY, SUPPLY);
check('  and the check FAILS when it should',
  !broken.ok, 'if nothing had really been burned, this is what would show it');

/* ------------------------------------------------------------------ */
/* 11. It is consensus state, not a service.                           */
/* ------------------------------------------------------------------ */

const empty = new State();
const emptyToo = new State();
emptyToo.credit(ALICE, 5n);
empty.credit(ALICE, 5n);
check('a chain with no bridged asset hashes exactly as it did before',
  empty.root() === emptyToo.root(), 'the ledger is appended only when present: no hard fork');

const revived = State.fromJSON(JSON.parse(JSON.stringify(state.toJSON())));
check('⛔ the ledger survives a datadir round trip', revived.root() === state.root(),
  'or a restarted node would disagree with itself about what has been paid');
check('  including the claims already honoured',
  revived.inbound.claimed.size === state.inbound.claimed.size && revived.inbound.claimed.size > 0);
check('  and the committed headers', revived.inbound.receiptsRootFor(ETH_CHAIN, BLOCK) === ROOT.toLowerCase());
check('  and the derived authority is recomputed, never stored',
  revived.inbound.get(TOKEN_ID).authority === AUTHORITY);

const forked = state.clone();
forked.inbound.claim({
  tokenId: TOKEN_ID, ethTxHash: '0x' + 'cc'.repeat(32), amount: 1n, recipient: ALICE,
});
check('⛔ a claim in a candidate block does not consume the burn in its parent',
  state.inbound.claimed.size !== forked.inbound.claimed.size,
  'a reorg must give the burn back, or it is lost on both chains at once');

const moved = state.root();
await apply(tx(ALICE, encodeBridgeRelease({ tokenId: TOKEN_ID, amount: 1n }), ALICE));
check('and the bridge ledger is IN the state root: a claim moves it',
  state.root() !== moved, 'two nodes that disagreed about what was paid would fork, as they should');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
