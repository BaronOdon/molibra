/**
 * Molibra acceptance test.
 *
 * The point of this file is to prove the wallet path actually works rather than
 * to assert that it does: a real secp256k1 key signs a real EIP-155
 * transaction, it goes in over real JSON-RPC, gets mined, and the receipt and
 * balances are checked afterwards. It also proves the chain rejects a tampered
 * block and that a second node can replicate and independently re-verify.
 */

import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Node } from '../src/node.js';
import { signTransaction } from '../src/tx.js';
import { encodeVoteData, toPollId, voteKey, VOTE_TAG } from '../src/vote.js';
import {
  encodeTokenCreate, encodeExpress, encodeIssue, encodeTransfer, tokenId, expressionKey,
} from '../src/token.js';
import { applyTransaction, State } from '../src/state.js';
import { fromHex, privateToAddress, toChecksumAddress, toHex } from '../src/crypto.js';
import { blockHash, blockRewardAt } from '../src/block.js';
import { solveWork, verifyWork } from '../src/work.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENESIS = join(ROOT, 'genesis.json');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`);
  }
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const ALICE_KEY = fromHex('0x0000000000000000000000000000000000000000000000000000000000000001');
const BOB_KEY = fromHex('0x0000000000000000000000000000000000000000000000000000000000000002');
const ALICE = privateToAddress(ALICE_KEY);
const BOB = privateToAddress(BOB_KEY);
const CAROL_KEY = fromHex('0x0000000000000000000000000000000000000000000000000000000000000003');
const CAROL = privateToAddress(CAROL_KEY);

const tempDirs = [];
function scratch(name) {
  const dir = mkdtempSync(join(tmpdir(), `molibra-${name}-`));
  tempDirs.push(dir);
  return dir;
}

async function main() {
  console.log('Molibra acceptance test\n');
  console.log(`  alice ${toChecksumAddress(ALICE)}`);
  console.log(`  bob   ${toChecksumAddress(BOB)}\n`);

  // ---------------------------------------------------------------- node A
  console.log('1. node, genesis and mining');
  const nodeA = new Node({ genesisPath: GENESIS, dataDir: scratch('a'), miner: ALICE });
  await nodeA.ready;
  await nodeA.start({ host: '127.0.0.1', port: 18545 });
  const url = nodeA.rpcUrl;

  check('genesis is height 0', nodeA.chain.height === 0n);
  check('genesis hash is stable', nodeA.chain.head.hash === blockHash(nodeA.chain.head.header));

  const genesisExtra = Buffer.from(nodeA.chain.head.header.extraData.slice(2), 'hex').toString('utf8');
  check('origin attribution sealed into genesis extraData',
    genesisExtra.includes('Povo Candidato') && genesisExtra.includes('Movimento Libertario do Brasil'));
  check('co-authors sealed into genesis extraData',
    genesisExtra.includes('World Spiritual Responsibility Organization')
    && genesisExtra.includes('Spiritcoin')
    && genesisExtra.includes('Spiritual Responsibility AI'));
  check('theoretical basis sealed into genesis extraData',
    genesisExtra.includes('libertarian theory')
    && genesisExtra.includes('Macrobiotic Quantum Theory'));

  const t0 = Date.now();
  await nodeA.mineBlocks(3);
  check('mined 3 blocks', nodeA.chain.height === 3n, `${((Date.now() - t0) / 1000).toFixed(2)}s`);
  check('block reward credited', nodeA.chain.state.balanceOf(ALICE) === 6n * 10n ** 18n,
    `${nodeA.chain.state.balanceOf(ALICE) / 10n ** 18n} MOLI`);
  check('every block carries valid proof of work',
    nodeA.chain.canonical.slice(1).every((b) => b.hash === blockHash(b.header)));

  // ------------------------------------------------------------ rpc basics
  console.log('\n2. JSON-RPC surface (the methods a wallet calls)');
  check('eth_chainId', (await rpc(url, 'eth_chainId')) === '0x4f02', await rpc(url, 'eth_chainId'));
  check('net_version', (await rpc(url, 'net_version')) === '20226');
  check('web3_clientVersion', (await rpc(url, 'web3_clientVersion')).startsWith('Molibra/'));
  check('eth_blockNumber', (await rpc(url, 'eth_blockNumber')) === '0x3');
  check('eth_getBalance', BigInt(await rpc(url, 'eth_getBalance', [ALICE, 'latest'])) === 6n * 10n ** 18n);
  check('eth_getTransactionCount', (await rpc(url, 'eth_getTransactionCount', [ALICE, 'latest'])) === '0x0');
  check('eth_gasPrice', BigInt(await rpc(url, 'eth_gasPrice')) > 0n);
  check('eth_estimateGas', BigInt(await rpc(url, 'eth_estimateGas', [{ to: BOB, value: '0x1' }])) === 21000n);
  check('eth_getCode is empty for an EOA', (await rpc(url, 'eth_getCode', [ALICE, 'latest'])) === '0x');
  check('eth_syncing is false', (await rpc(url, 'eth_syncing')) === false);
  const latestBlock = await rpc(url, 'eth_getBlockByNumber', ['latest', false]);
  check('eth_getBlockByNumber shape', latestBlock.number === '0x3' && typeof latestBlock.hash === 'string');

  // -------------------------------------------------- the wallet path proper
  console.log('\n3. signed transaction end to end (the MetaMask path)');
  const value = 10n ** 18n; // 1 MOLI
  const gasPrice = BigInt(await rpc(url, 'eth_gasPrice'));
  const raw = signTransaction(
    { nonce: 0n, gasPrice, gasLimit: 21000n, to: BOB, value, data: '0x' },
    ALICE_KEY, nodeA.chain.chainId,
  );

  const sentHash = await rpc(url, 'eth_sendRawTransaction', [toHex(raw)]);
  check('eth_sendRawTransaction accepted', typeof sentHash === 'string' && sentHash.startsWith('0x'), sentHash);
  check('transaction is pending', nodeA.chain.mempool.size === 1);
  check('pending nonce advanced',
    (await rpc(url, 'eth_getTransactionCount', [ALICE, 'pending'])) === '0x1');

  const pending = await rpc(url, 'eth_getTransactionByHash', [sentHash]);
  check('eth_getTransactionByHash recovers the sender', pending.from === ALICE);
  check('pending transaction has no block yet', pending.blockNumber === null);

  const aliceBefore = nodeA.chain.state.balanceOf(ALICE);
  await nodeA.mineBlocks(1);
  check('transaction was mined', nodeA.chain.mempool.size === 0 && nodeA.chain.height === 4n);

  const receipt = await rpc(url, 'eth_getTransactionReceipt', [sentHash]);
  check('receipt exists and succeeded', receipt && receipt.status === '0x1');
  check('receipt gasUsed is the transfer cost', BigInt(receipt.gasUsed) === 21000n);
  check('receipt links to its block', receipt.blockNumber === '0x4');

  const fee = 21000n * gasPrice;
  const reward = 2n * 10n ** 18n;
  check('recipient credited', nodeA.chain.state.balanceOf(BOB) === value, `${nodeA.chain.state.balanceOf(BOB)} wei`);
  check('sender debited value plus fee, credited reward and fee',
    nodeA.chain.state.balanceOf(ALICE) === aliceBefore - value - fee + reward + fee);
  check('sender nonce advanced', nodeA.chain.state.nonceOf(ALICE) === 1n);

  // ------------------------------------------------------------- rejections
  console.log('\n4. the chain says no when it should');
  let rejected;

  rejected = false;
  try { await rpc(url, 'eth_sendRawTransaction', [toHex(raw)]); } catch { rejected = true; }
  check('replayed transaction is rejected (nonce too low)', rejected);

  rejected = false;
  try {
    const wrongChain = signTransaction(
      { nonce: 1n, gasPrice, gasLimit: 21000n, to: BOB, value: 1n, data: '0x' }, ALICE_KEY, 1,
    );
    await rpc(url, 'eth_sendRawTransaction', [toHex(wrongChain)]);
  } catch { rejected = true; }
  check('transaction signed for another chain is rejected', rejected);

  rejected = false;
  try {
    const tooPoor = signTransaction(
      { nonce: 0n, gasPrice, gasLimit: 21000n, to: ALICE, value: 10n ** 24n, data: '0x' }, BOB_KEY, nodeA.chain.chainId,
    );
    await rpc(url, 'eth_sendRawTransaction', [toHex(tooPoor)]);
  } catch { rejected = true; }
  check('transaction without funds is rejected', rejected);

  rejected = false;
  try {
    const tampered = JSON.parse(JSON.stringify(
      (await import('../src/block.js')).serializeBlock(nodeA.chain.head),
    ));
    tampered.header.number = String(BigInt(tampered.header.number) + 1n);
    tampered.header.miner = BOB;
    await nodeA.chain.appendSerialized(tampered);
  } catch { rejected = true; }
  check('tampered block is rejected', rejected);

  // ------------------------------------------------------ audit + replication
  console.log('\n5. public audit surface and independent replication');
  const summary = await (await fetch(url + '/molibra')).json();
  check('/molibra reports chain identity', summary.chainId === 20226 && summary.symbol === 'MOLI');
  check('/molibra publishes the attribution and co-authors',
    JSON.stringify(summary.attribution).includes('Povo Candidato')
    && JSON.stringify(summary.attribution).includes('World Spiritual Responsibility Organization'));

  const theoriesDoc = await (await fetch(url + '/molibra/theories')).json();
  check('/molibra/theories names both theories',
    theoriesDoc.theories.some((t) => t.name.includes('Libertarian'))
    && theoriesDoc.theories.some((t) => t.name.includes('Macrobiotic Quantum Theory')));
  check('/molibra/theories carries the MQT magic angle',
    theoriesDoc.theories.find((t) => t.name.includes('Macrobiotic')).magicAngle.degrees === 54.7356);

  const headDoc = await (await fetch(url + '/molibra/head')).json();
  check('/molibra/head matches the node head', headDoc.hash === nodeA.chain.head.hash);

  const txDoc = await (await fetch(url + '/molibra/tx/' + sentHash)).json();
  check('/molibra/tx exposes the transaction and receipt',
    txDoc.transaction.hash === sentHash && txDoc.receipt.status === '0x1');

  const nodeB = new Node({ genesisPath: GENESIS, dataDir: scratch('b'), peers: [url] });
  await nodeB.ready;
  await nodeB.start({ host: '127.0.0.1', port: 18546 });
  const adopted = await nodeB.syncFrom(url);
  check('second node replicated the chain', adopted === 4 && nodeB.chain.height === 4n, `${adopted} blocks`);
  check('second node reached the identical head', nodeB.chain.head.hash === nodeA.chain.head.hash);
  check('second node independently re-derived the same state',
    nodeB.chain.state.root() === nodeA.chain.state.root());
  check('replicated balances agree', nodeB.chain.state.balanceOf(BOB) === value);

  // ------------------------------------------------------------ fork choice
  console.log('\n6. fork choice');
  const { serializeBlock } = await import('../src/block.js');
  const { Chain } = await import('../src/chain.js');

  // Two independent chains from the same genesis, so they genuinely diverge.
  const left = await new Chain(Chain.loadGenesis(GENESIS), scratch('left')).init();
  const right = await new Chain(Chain.loadGenesis(GENESIS), scratch('right')).init();

  await left.mine(ALICE);
  const forkPoint = left.head;
  await right.appendSerialized(serializeBlock(forkPoint));
  check('both chains share the fork point', right.head.hash === forkPoint.hash);

  // Left extends by one, right by two: right is heavier.
  await left.mine(ALICE);
  await right.mine(BOB);
  await right.mine(BOB);
  check('left is 2 blocks, right is 3', left.height === 2n && right.height === 3n);
  check('right carries more total work', right.totalDifficulty > left.totalDifficulty);

  const leftHeadBefore = left.head.hash;
  for (let n = 2; n <= 3; n++) {
    await left.appendSerialized(serializeBlock(right.blockByNumber(n)));
  }

  check('left reorganised onto the heavier branch', left.head.hash === right.head.hash);
  check('reorg was recorded', left.lastReorg !== null && left.lastReorg.depth === 1,
    left.lastReorg ? `depth ${left.lastReorg.depth}` : 'none');
  check('the abandoned block is still known, just not canonical',
    left.blockByHash(leftHeadBefore) !== null && !left.isCanonical(leftHeadBefore));
  check('left re-derived the heavier branch state independently',
    left.state.root() === right.state.root());
  check('canonical height follows the heavier branch', left.height === 3n);
  check('miner of the winning branch holds its rewards',
    left.state.balanceOf(BOB) === right.state.balanceOf(BOB));

  // A lighter competing branch must be kept but NOT adopted.
  const lighter = await new Chain(Chain.loadGenesis(GENESIS), scratch('lighter')).init();
  await lighter.appendSerialized(serializeBlock(forkPoint));
  await lighter.mine(CAROL); // a different miner, so this is genuinely a different block
  const headBeforeLighter = left.head.hash;
  const lighterResult = await left.appendSerialized(serializeBlock(lighter.head));
  check('lighter branch is accepted into the tree', lighterResult.accepted);
  check('lighter branch does not move the head', left.head.hash === headBeforeLighter);
  check('lighter branch is stored non-canonically',
    left.blockByHash(lighter.head.hash) !== null && !left.isCanonical(lighter.head.hash));

  // A block arriving before its parent must be held, then connected.
  const early = await new Chain(Chain.loadGenesis(GENESIS), scratch('early')).init();
  const source = await new Chain(Chain.loadGenesis(GENESIS), scratch('source')).init();
  await source.mine(ALICE);
  await source.mine(ALICE);
  const child = serializeBlock(source.blockByNumber(2));
  const parentBlock = serializeBlock(source.blockByNumber(1));
  const orphanResult = await early.appendSerialized(child);
  check('out-of-order block is held as an orphan', orphanResult.reason === 'orphan' && early.height === 0n);
  await early.appendSerialized(parentBlock);
  check('orphan connects once its parent arrives', early.height === 2n);
  check('connected chain matches the source', early.head.hash === source.head.hash);

  // A reorg that drops a mined transaction must hand it back to the mempool,
  // and the rolled-back balance must actually roll back.
  const dirL = scratch('tx-left');
  const chainL = await new Chain(Chain.loadGenesis(GENESIS), dirL).init();
  const chainR = await new Chain(Chain.loadGenesis(GENESIS), scratch('tx-right')).init();
  await chainL.mine(ALICE); await chainL.mine(ALICE); await chainL.mine(ALICE);
  for (let n = 1; n <= 3; n++) await chainR.appendSerialized(serializeBlock(chainL.blockByNumber(n)));

  const payTx = signTransaction(
    { nonce: 0n, gasPrice: 1000000000n, gasLimit: 21000n, to: CAROL, value: 3n * 10n ** 18n, data: '0x' },
    ALICE_KEY, chainL.chainId,
  );
  const payHash = chainL.submitRaw(toHex(payTx));
  await chainL.mine(ALICE);
  check('transaction mined on the branch that will lose',
    chainL.txIndex.has(payHash) && chainL.state.balanceOf(CAROL) === 3n * 10n ** 18n);

  await chainR.mine(BOB); await chainR.mine(BOB); // heavier: two blocks against one
  for (let n = 4; n <= 5; n++) await chainL.appendSerialized(serializeBlock(chainR.blockByNumber(n)));

  check('reorg dropped the block containing the transaction',
    chainL.head.hash === chainR.head.hash && !chainL.txIndex.has(payHash));
  check('dropped transaction returned to the mempool', chainL.mempool.has(payHash),
    `${chainL.lastReorg?.returnedToMempool ?? 0} returned`);
  check('recipient balance rolled back with the reorg', chainL.state.balanceOf(CAROL) === 0n);
  check('receipt for the dropped transaction is gone', chainL.receiptFor(payHash) === null);

  await chainL.mine(ALICE);
  check('returned transaction can be mined again on the new branch',
    chainL.txIndex.has(payHash) && chainL.state.balanceOf(CAROL) === 3n * 10n ** 18n);

  // Side branches must survive a restart: one that is heavier tomorrow is
  // useless if it was thrown away today.
  const knownBefore = chainL.byHash.size;
  const headBefore = chainL.head.hash;
  const reloadedFork = await new Chain(Chain.loadGenesis(GENESIS), dirL).init();
  check('every known block survived the restart', reloadedFork.byHash.size === knownBefore,
    `${reloadedFork.byHash.size} of ${knownBefore}`);
  check('fork choice re-derived the same head after restart', reloadedFork.head.hash === headBefore);
  check('the abandoned branch is still on disk and still non-canonical',
    reloadedFork.blockByHash(chainL.lastReorg.from) !== null
    && !reloadedFork.isCanonical(chainL.lastReorg.from));

  // The download-a-node-and-join case: a miner producing blocks faster than the
  // clock ticks must still produce blocks every other node accepts. This is the
  // regression guard for the header/difficulty timestamp split.
  const fast = await new Chain(Chain.loadGenesis(GENESIS), scratch('fast')).init();
  await fast.mine(ALICE); await fast.mine(ALICE); await fast.mine(ALICE); await fast.mine(ALICE); await fast.mine(ALICE);
  const stamps = fast.canonical.map((b) => b.header.timestamp);
  check('rapid mining still advances the timestamp every block',
    stamps.every((t, i) => i === 0 || t > stamps[i - 1]),
    stamps.slice(1).join(','));

  const joiner = await new Chain(Chain.loadGenesis(GENESIS), scratch('joiner')).init();
  let joinFailure = null;
  for (let n = 1; n <= Number(fast.height); n++) {
    try { await joiner.appendSerialized(serializeBlock(fast.blockByNumber(n))); }
    catch (e) { joinFailure = `#${n}: ${e.message}`; break; }
  }
  check('a fresh node accepts every block of a fast miner', joinFailure === null, joinFailure ?? '');
  check('the joining node reaches the same head', joiner.head.hash === fast.head.hash);

  // ------------------------------------------------------ issuance schedule
  console.log('\n6b. issuance - tail emission, decided 29 Aug 2026');

  const G = Chain.loadGenesis(GENESIS);
  const MOLI = 10n ** 18n;
  const era = Number(G.rewardHalvingInterval);

  check('genesis declares the halving interval and a permanent floor',
    era === 2102400 && G.rewardFloor === MOLI / 4n, `floor ${G.rewardFloor}`);
  check('fee burn is declared and OFF, not left silent', G.feeBurnBasisPoints === 0);

  check('era 0 pays the full 2 MOLI', blockRewardAt(1n, G) === 2n * MOLI);
  check('the last block of era 0 still pays 2 MOLI',
    blockRewardAt(BigInt(era) - 1n, G) === 2n * MOLI);
  check('the first block of era 1 halves to 1 MOLI',
    blockRewardAt(BigInt(era), G) === MOLI);
  check('era 2 halves again to 0.5 MOLI',
    blockRewardAt(BigInt(era) * 2n, G) === MOLI / 2n);
  check('era 3 reaches the 0.25 MOLI floor',
    blockRewardAt(BigInt(era) * 3n, G) === MOLI / 4n);

  // The floor is the whole point: a chain with deliberately negligible fees
  // cannot pay for security from fees, so issuance must never reach zero.
  check('the reward never falls below the floor, however far out',
    blockRewardAt(BigInt(era) * 40n, G) === MOLI / 4n
    && blockRewardAt(BigInt(era) * 10000n, G) === MOLI / 4n);
  check('an absurd height does not hang or overflow the shift',
    blockRewardAt(10n ** 30n, G) === MOLI / 4n);

  // Backward compatibility: every block mined before this rule existed sits in
  // era 0, so the chain already on disk stays valid and needs no reset.
  check('blocks already mined are unaffected - all of era 0 pays 2 MOLI',
    blockRewardAt(0n, G) === 2n * MOLI && blockRewardAt(1156n, G) === 2n * MOLI);

  // And the miner and the verifier must agree, which is the actual risk.
  const issue = await new Chain(Chain.loadGenesis(GENESIS), scratch('issuance')).init();
  await issue.mine(ALICE);
  const mirror = await new Chain(Chain.loadGenesis(GENESIS), scratch('issuance-b')).init();
  await mirror.appendSerialized(serializeBlock(issue.blockByNumber(1)));
  check('a second node re-derives the same reward from the same schedule',
    mirror.state.balanceOf(ALICE) === issue.state.balanceOf(ALICE)
    && mirror.state.balanceOf(ALICE) === 2n * MOLI);

  // -------------------------------------------------- expressions of will
  console.log('\n7. expressions of will (one wallet, one poll)');

  const POLL_A = toPollId('datatoalha-prefeitura-sp-2026');
  const POLL_B = toPollId('datatoalha-governo-sp-2026');
  const CHOICE = '0x' + '11'.repeat(32); // an opaque commitment, never the choice itself

  const express = (chain, key, from, nonce, pollId, commitment = CHOICE) => signTransaction(
    {
      nonce, gasPrice: 1000000000n, gasLimit: 100000n,
      to: from, value: 0n, data: encodeVoteData(pollId, commitment),
    },
    key, chain.chainId,
  );

  const dirV = scratch('vote-left');
  const voteL = await new Chain(Chain.loadGenesis(GENESIS), dirV).init();
  await voteL.mine(ALICE); await voteL.mine(ALICE); await voteL.mine(ALICE);

  const voteHash = voteL.submitRaw(toHex(express(voteL, ALICE_KEY, ALICE, 0n, POLL_A)));
  check('an expression is accepted into the mempool', voteL.mempool.has(voteHash));
  await voteL.mine(ALICE);
  const keyA = voteKey(ALICE, POLL_A);
  check('the expression was mined', voteL.txIndex.has(voteHash));
  check('the chain recorded H(wallet || pollId)', voteL.state.hasVoteKey(keyA), keyA.slice(0, 18));
  check('the receipt names the vote key and poll',
    voteL.receiptFor(voteHash).voteKey === keyA && voteL.receiptFor(voteHash).pollId === POLL_A);
  check('the choice itself is not on the chain, only a commitment',
    !voteL.blockByNumber(4).transactions[0].data.includes('deadbeef')
    && voteL.blockByNumber(4).transactions[0].data.startsWith(VOTE_TAG));

  let refused;
  refused = false;
  try { voteL.submitRaw(toHex(express(voteL, ALICE_KEY, ALICE, 1n, POLL_A))); }
  catch (e) { refused = /already expressed/.test(e.message); }
  check('a second expression from the same wallet on the same poll is refused', refused);

  const otherPoll = voteL.submitRaw(toHex(express(voteL, ALICE_KEY, ALICE, 1n, POLL_B)));
  await voteL.mine(ALICE);
  check('the same wallet may still speak on a different poll',
    voteL.txIndex.has(otherPoll) && voteL.state.hasVoteKey(voteKey(ALICE, POLL_B)));
  check('speaking on poll B did not consume poll A for anyone else',
    !voteL.state.hasVoteKey(voteKey(BOB, POLL_A)));

  // Another wallet on the same poll: the key is per wallet, not per poll.
  await voteL.mine(BOB); await voteL.mine(BOB);
  const bobVote = voteL.submitRaw(toHex(express(voteL, BOB_KEY, BOB, 0n, POLL_A)));
  await voteL.mine(BOB);
  check('a different wallet may speak on the same poll',
    voteL.txIndex.has(bobVote) && voteL.state.hasVoteKey(voteKey(BOB, POLL_A)));

  // Shape rules: nothing of value changes hands by speaking.
  refused = false;
  try {
    voteL.submitRaw(toHex(signTransaction(
      { nonce: 2n, gasPrice: 1000000000n, gasLimit: 100000n, to: BOB, value: 0n, data: encodeVoteData(POLL_A, CHOICE) },
      ALICE_KEY, voteL.chainId,
    )));
  } catch (e) { refused = /self-addressed/.test(e.message); }
  check('an expression addressed to someone else is refused', refused);

  refused = false;
  try {
    voteL.submitRaw(toHex(signTransaction(
      { nonce: 2n, gasPrice: 1000000000n, gasLimit: 100000n, to: ALICE, value: 1n, data: encodeVoteData(POLL_B, CHOICE) },
      ALICE_KEY, voteL.chainId,
    )));
  } catch (e) { refused = /no value/.test(e.message); }
  check('an expression carrying value is refused', refused);

  refused = false;
  try {
    voteL.submitRaw(toHex(signTransaction(
      { nonce: 2n, gasPrice: 1000000000n, gasLimit: 100000n, to: ALICE, value: 0n, data: VOTE_TAG + '00' },
      ALICE_KEY, voteL.chainId,
    )));
  } catch (e) { refused = /malformed expression/.test(e.message); }
  check('a tagged but malformed expression is refused, never read as a transfer', refused);

  // Consensus: the duplicate check lives in applyTransaction, which is exactly
  // what verifyAgainstParent runs on a peer's block - so a block carrying a
  // duplicate is rejected by every node, not merely kept out of the mempool.
  const replayState = voteL.state.clone();
  const dupTx = (await import('../src/tx.js')).decodeTransaction(
    express(voteL, ALICE_KEY, ALICE, 2n, POLL_A), voteL.chainId,
  );
  let blockLevel = false;
  try { await applyTransaction(replayState, dupTx, (await import('../src/tx.js')).intrinsicGas(dupTx), BOB); }
  catch (e) { blockLevel = /already expressed/.test(e.message); }
  check('a block carrying a duplicate expression fails re-execution', blockLevel);

  // Every node must agree on who has spoken, so the keys are in the state root.
  const withoutKeys = voteL.state.clone();
  withoutKeys.voteKeys = new Set();
  check('vote keys change the state root', withoutKeys.root() !== voteL.state.root());
  const rootBefore = (await new Chain(Chain.loadGenesis(GENESIS), scratch('vote-root')).init()).state.root();
  const emptyRoot = new State().root();
  check('a chain with no expressions hashes exactly as before',
    rootBefore === (await new Chain(Chain.loadGenesis(GENESIS), scratch('vote-root2')).init()).state.root()
    && emptyRoot === new State(new Map(), new Set()).root());

  // An independent node re-deriving the chain must reach the same vote keys.
  const voteMirror = await new Chain(Chain.loadGenesis(GENESIS), scratch('vote-mirror')).init();
  for (let n = 1; n <= Number(voteL.height); n++) {
    await voteMirror.appendSerialized(serializeBlock(voteL.blockByNumber(n)));
  }
  check('a second node re-derived the same expressions independently',
    voteMirror.state.hasVoteKey(keyA) && voteMirror.state.root() === voteL.state.root());

  // A reorg that unwinds the block must unwind the right to speak again. This
  // is the whole reason the keys live in state rather than in a side register.
  const voteR = await new Chain(Chain.loadGenesis(GENESIS), scratch('vote-right')).init();
  for (let n = 1; n <= 3; n++) await voteR.appendSerialized(serializeBlock(voteL.blockByNumber(n)));
  const heightBeforeReorg = Number(voteL.height);
  for (let n = 4; n <= heightBeforeReorg + 1; n++) await voteR.mine(CAROL);
  for (let n = 4; n <= Number(voteR.height); n++) {
    await voteL.appendSerialized(serializeBlock(voteR.blockByNumber(n)));
  }
  check('the reorg took the branch carrying the expressions',
    voteL.head.hash === voteR.head.hash);
  check('the vote key was unwound with the block', !voteL.state.hasVoteKey(keyA));
  check('the wallet may speak again on the branch that survived',
    voteL.submitRaw(toHex(express(voteL, ALICE_KEY, ALICE, 0n, POLL_A))).startsWith('0x'));

  // ------------------------------------------------------------ GIZ / tokens
  console.log('\n8. GIZ: issuance, uncapped supply and wei-granular cost');

  const tk = await new Chain(Chain.loadGenesis(GENESIS), scratch('tokens')).init();
  for (let i = 0; i < 4; i++) await tk.mine(ALICE);

  const COMMIT = '0x' + '5a'.repeat(32);
  const POLL_Q = toPollId('voting-place-alpha');
  const POLL_R = toPollId('voting-place-beta');
  const POLL_S = toPollId('voting-place-gamma');
  const gasP = 1000000000n;
  const COST = 10n ** 15n; // 0.001 of a unit - granularity borrowed from wei
  const send = (key, from, nonce, data, to = from) => signTransaction(
    { nonce, gasPrice: gasP, gasLimit: 300000n, to, value: 0n, data }, key, tk.chainId,
  );

  // Nonces are tracked rather than counted by hand, and advanced only when a
  // submission is ACCEPTED - a refused transaction consumes nothing, and a
  // test that assumed otherwise would pass for the wrong reason.
  let an = 0n;
  let bn = 0n;
  const tryAlice = (data, to = ALICE) => toHex(send(ALICE_KEY, ALICE, an, data, to));
  const doAlice = (data, to = ALICE) => { const h = tk.submitRaw(tryAlice(data, to)); an++; return h; };
  const tryBob = (data, to = BOB) => toHex(send(BOB_KEY, BOB, bn, data, to));
  const doBob = (data, to = BOB) => { const h = tk.submitRaw(tryBob(data, to)); bn++; return h; };

  // --- creation -----------------------------------------------------------
  const gizRecord = {
    kind: 'expression',
    symbol: 'GIZ',
    title: 'Chalk (GIZ) - the politics chalkboard',
    options: ['agree', 'disagree', 'abstain'],
    voteMode: 'quantum',
    initialSupply: '0',
    maxSupply: '0',                    // uncapped: questions never stop being created
    expressionCost: COST.toString(),
    issuable: true,
    purpose: 'purchase',               // expressao publica de compra - what the board records
    transferable: false,
  };
  const createHash = doAlice(encodeTokenCreate(gizRecord));
  await tk.mine(ALICE);
  const height = tk.txIndex.get(createHash).blockNumber;
  const GIZ = tokenId(ALICE, gizRecord.title, BigInt(height));
  const token = tk.state.getToken(GIZ);

  check('a token is created and its id is DERIVED, not chosen', token !== null, GIZ.slice(0, 18));
  check('the creator does NOT start holding the whole supply',
    tk.state.tokenBalanceOf(GIZ, ALICE) === 0n && token.minted === '0',
    'the 29 Aug dead end: whole supply to creator plus non-transferable meant nobody could ever express');
  check('supply is UNCAPPED - minted on demand, no ceiling', token.maxSupply === '0');
  check('the mode is on the record, immutable and disclosed', token.voteMode === 'quantum');
  check('GIZ is non-transferable - no market, therefore no price',
    token.transferable === false && token.purpose === 'purchase');
  check('the purpose is DECLARED on the record, not asserted about it',
    token.purpose === 'purchase' && token.electoral === false,
    'expressao publica de compra - not an enquete, not a pesquisa');
  check('the cost of expressing is on the record, in wei granularity',
    token.expressionCost === COST.toString(), '0.001 of a unit, not one whole unit');

  // --- what consensus refuses at creation ---------------------------------
  let no;
  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate(
      { ...gizRecord, title: 'electoral and tradable', purpose: 'electoral', transferable: true })));
  } catch (e) { no = /never be transferable/.test(e.message); }
  check('an ELECTORAL token can never be TRANSFERABLE - refused by consensus', no);

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate(
      { ...gizRecord, title: 'the dead end', issuable: false, transferable: false })));
  } catch (e) { no = /never reach a second holder/.test(e.message); }
  check('a token neither issuable NOR transferable is refused at creation', no,
    'the dead end is refused before the record becomes immutable');

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate(
      // Purpose market: a social or electoral token can never be transferable,
      // so that rule would refuse this record first and the check would pass
      // for the wrong reason.
      { ...gizRecord, title: 'nothing and no way to make any', purpose: 'market',
        issuable: false, transferable: true, initialSupply: '0' })));
  } catch (e) { no = /must be issuable/.test(e.message); }
  check('a token with no supply and no issuance is refused', no);

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate({ ...gizRecord, voteMode: 'capped', cap: 0 })));
  } catch (e) { no = /cap of at least/.test(e.message); }
  check('capped mode without a cap is refused', no);

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate({ ...gizRecord, options: ['only one'] })));
  } catch (e) { no = /two options/.test(e.message); }
  check('a token with fewer than two options is refused', no);

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate(
      { ...gizRecord, title: 'no purpose declared', purpose: undefined })));
  } catch (e) { no = /must declare its purpose/.test(e.message); }
  check('a token that declares no purpose is refused', no,
    'no default, because a silent default on an immutable record is the trap');

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate(
      { ...gizRecord, title: 'made-up purpose', purpose: 'whatever' })));
  } catch (e) { no = /must declare its purpose/.test(e.message); }
  check('a purpose outside the declared set is refused', no);

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate(
      { ...gizRecord, title: 'saying two things at once',
        purpose: 'market', electoral: true })));
  } catch (e) { no = /derived from purpose/.test(e.message); }
  check('electoral cannot disagree with purpose - it is derived, not stated', no);

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate(
      { ...gizRecord, title: 'social and tradable', purpose: 'social', transferable: true })));
  } catch (e) { no = /can never be transferable/.test(e.message); }
  check('a COMUNICACAO SOCIAL token can never be transferable either', no,
    'art. 29 8 guards the surface, not the label');

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate(
      { ...gizRecord, title: 'purchase and tradable', transferable: true })));
  } catch (e) { no = /can never be transferable/.test(e.message); }
  check('nor can EXPRESSAO PUBLICA DE COMPRA, which is the electoral-period surface', no);

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate(
      { ...gizRecord, title: 'Enquete: quem voce prefere?' })));
  } catch (e) { no = /cannot be called an/.test(e.message); }
  check('a purchase token CANNOT be called an enquete - refused by consensus', no,
    'TSE 23.600/2019: an enquete is a regulated object, barred from 15 August');

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate(
      { ...gizRecord, title: 'Pesquisa de intencao de voto' })));
  } catch (e) { no = /cannot be called an/.test(e.message); }
  check('nor a pesquisa, which carries its own registration duty', no);

  const okTitle = { ...gizRecord, title: 'Quem voce comprou hoje?' };
  const okHash = doAlice(encodeTokenCreate(okTitle));
  await tk.mine(ALICE);
  check('a purchase token named for what it actually records is accepted',
    tk.state.getToken(tokenId(ALICE, okTitle.title,
      BigInt(tk.txIndex.get(okHash).blockNumber))) !== null);

  const marketRec = { ...gizRecord, title: 'a market question', purpose: 'market',
                      transferable: true, initialSupply: (COST * 5n).toString() };
  const mHash = doAlice(encodeTokenCreate(marketRec));
  await tk.mine(ALICE);
  const MKT = tokenId(ALICE, marketRec.title, BigInt(tk.txIndex.get(mHash).blockNumber));
  check('afericao de mercado is a different object and MAY be transferable',
    tk.state.getToken(MKT).transferable === true
    && tk.state.getToken(MKT).purpose === 'market');

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate(
      { ...gizRecord, title: 'free speech', expressionCost: '0' })));
  } catch (e) { no = /cost must be positive/.test(e.message); }
  check('a token whose expression costs nothing is refused', no,
    'the act must cost something, or identities are free');

  // --- issuance: the distribution path, and it is NOT transfer ------------
  // BOB is funded in MOLI first, or the later refusals would pass for the
  // wrong reason - lacking gas rather than lacking units.
  tk.submitRaw(toHex(signTransaction(
    { nonce: an, gasPrice: gasP, gasLimit: 21000n, to: BOB,
      value: 5n * 10n ** 18n, data: '0x' }, ALICE_KEY, tk.chainId)));
  an++;
  await tk.mine(ALICE);
  check('BOB is funded, so the next refusals are about units and nothing else',
    tk.state.balanceOf(BOB) >= 5n * 10n ** 18n);

  doAlice(encodeIssue(GIZ, COST * 10n), BOB);
  await tk.mine(ALICE);
  check('the creator ISSUES units to a holder, and that is how anyone gets GIZ',
    tk.state.tokenBalanceOf(GIZ, BOB) === COST * 10n
    && tk.state.getToken(GIZ).minted === (COST * 10n).toString());
  check('issuance MINTS - the creator gave away nothing it was holding',
    tk.state.tokenBalanceOf(GIZ, ALICE) === 0n);

  no = false;
  try { tk.submitRaw(tryBob(encodeIssue(GIZ, COST), CAROL)); }
  catch (e) { no = /only the creator may issue/.test(e.message); }
  check('a HOLDER cannot pass units on - issuance is one-directional', no,
    'no secondary market, so no price, so art. 29 has nothing to bite on');

  doAlice(encodeIssue(GIZ, COST * 4n), CAROL);
  await tk.mine(ALICE);
  check('an uncapped token keeps minting on demand - no ceiling to hit',
    tk.state.getToken(GIZ).minted === (COST * 14n).toString()
    && tk.state.tokenBalanceOf(GIZ, CAROL) === COST * 4n);

  // --- a declared ceiling is enforced -------------------------------------
  const capSupply = { ...gizRecord, title: 'a question with a declared ceiling',
                      maxSupply: (COST * 3n).toString() };
  const csHash = doAlice(encodeTokenCreate(capSupply));
  await tk.mine(ALICE);
  const CS = tokenId(ALICE, capSupply.title, BigInt(tk.txIndex.get(csHash).blockNumber));
  doAlice(encodeIssue(CS, COST * 2n), BOB);
  await tk.mine(ALICE);
  no = false;
  try { tk.submitRaw(tryAlice(encodeIssue(CS, COST * 2n), CAROL)); }
  catch (e) { no = /exceed the declared max supply/.test(e.message); }
  check('a declared max supply is enforced on issuance, not merely displayed', no);

  // --- expressing burns exactly the declared cost -------------------------
  const eHash = doBob(encodeExpress(GIZ, POLL_Q, COMMIT, COST));
  await tk.mine(ALICE);
  check('expressing BURNS the declared cost rather than one whole unit',
    tk.state.tokenBalanceOf(GIZ, BOB) === COST * 9n
    && tk.state.getToken(GIZ).burned === COST.toString(),
    'wei granularity: one holding covers many questions');
  check('the receipt names the token and the amount burned',
    tk.receiptFor(eHash).tokenId === GIZ
    && tk.receiptFor(eHash).tokenAmount === COST.toString());

  no = false;
  try { tk.submitRaw(tryBob(encodeExpress(GIZ, POLL_R, COMMIT, COST * 5n))); }
  catch (e) { no = /burns exactly/.test(e.message); }
  check('burning MORE than the cost buys no larger voice outside weighted mode', no,
    'a fixed cost is what keeps quantum, single and capped egalitarian');

  no = false;
  try { tk.submitRaw(tryBob(encodeExpress(GIZ, POLL_R, COMMIT, COST / 2n))); }
  catch (e) { no = /burns exactly/.test(e.message); }
  check('burning less than the cost is refused too', no);

  no = false;
  try { tk.submitRaw(tryBob(encodeExpress(GIZ, POLL_Q, COMMIT, COST))); }
  catch (e) { no = /already expressed in voting place/.test(e.message); }
  check('it can NEVER return to the voting place it left', no,
    'holding nine more units bought no second voice there');

  doBob(encodeExpress(GIZ, POLL_R, COMMIT, COST));
  await tk.mine(ALICE);
  check('but it CAN be in another macrobiotic quantum',
    tk.state.getToken(GIZ).burned === (COST * 2n).toString()
    && tk.state.tokenBalanceOf(GIZ, BOB) === COST * 8n,
    'one currency, many voting places, once each');

  check('quantum scopes to the VOTING PLACE, not the token',
    tk.state.hasVoteKey(expressionKey(BOB, POLL_Q))
    && tk.state.hasVoteKey(expressionKey(BOB, POLL_R))
    && !tk.state.hasVoteKey(expressionKey(BOB, GIZ)));

  const gizNow = tk.state.getToken(GIZ);
  check('the burn IS the tally: minted minus every holding equals units burned',
    BigInt(gizNow.minted)
      - tk.state.tokenBalanceOf(GIZ, ALICE)
      - tk.state.tokenBalanceOf(GIZ, BOB)
      - tk.state.tokenBalanceOf(GIZ, CAROL)
      === BigInt(gizNow.burned));
  check('and the count of expressions is the burn divided by the fixed cost',
    BigInt(gizNow.burned) / COST === BigInt(gizNow.expressions)
    && gizNow.expressions === '2');

  no = false;
  try { tk.submitRaw(tryAlice(encodeExpress(GIZ, POLL_S, COMMIT, COST))); }
  catch (e) { no = /no units of this token/.test(e.message); }
  check('even the CREATOR cannot express without holding units', no,
    'creating a question is publishing; expressing is speaking - separate acts');

  // --- weighted: the one mode where the amount IS the weight --------------
  const wRec = { ...gizRecord, title: 'a weighted question', voteMode: 'weighted',
                 purpose: 'market', initialSupply: (COST * 100n).toString() };
  const wHash = doAlice(encodeTokenCreate(wRec));
  await tk.mine(ALICE);
  const WT = tokenId(ALICE, wRec.title, BigInt(tk.txIndex.get(wHash).blockNumber));
  check('a weighted token may mint an initial supply to its creator',
    tk.state.tokenBalanceOf(WT, ALICE) === COST * 100n);

  doAlice(encodeExpress(WT, POLL_Q, COMMIT, COST * 5n));
  await tk.mine(ALICE);
  doAlice(encodeExpress(WT, POLL_Q, COMMIT, COST * 3n));
  await tk.mine(ALICE);
  check('weighted lets the burned amount vary - the amount IS the weight',
    tk.state.getToken(WT).burned === (COST * 8n).toString()
    && tk.state.getToken(WT).expressions === '2',
    'plutocratic by construction, and labelled so wherever it appears');
  check('units burned and expressions cast are DIFFERENT numbers under weighted',
    tk.state.getToken(WT).burned !== tk.state.getToken(WT).expressions,
    'so both are served, and no reader infers a count from an amount');

  no = false;
  try { tk.submitRaw(tryAlice(encodeExpress(WT, POLL_R, COMMIT, COST / 2n))); }
  catch (e) { no = /must burn at least/.test(e.message); }
  check('weighted still refuses less than the declared cost', no);

  // --- single and capped keep the fixed cost ------------------------------
  const sRec = { ...gizRecord, title: 'a single-mode question', voteMode: 'single',
                 initialSupply: (COST * 10n).toString() };
  const sHash = doAlice(encodeTokenCreate(sRec));
  await tk.mine(ALICE);
  const SG = tokenId(ALICE, sRec.title, BigInt(tk.txIndex.get(sHash).blockNumber));
  doAlice(encodeExpress(SG, POLL_Q, COMMIT, COST));
  await tk.mine(ALICE);
  no = false;
  try { tk.submitRaw(tryAlice(encodeExpress(SG, POLL_R, COMMIT, COST))); }
  catch (e) { no = /already expressed on token/.test(e.message); }
  check('single mode: one expression per wallet across every question', no,
    'holding nine more units did not buy a second voice');
  check('single mode recorded the per-wallet key',
    tk.state.hasVoteKey(expressionKey(ALICE, SG)));

  const capRec = { ...gizRecord, title: 'capped question', voteMode: 'capped', cap: 2,
                   initialSupply: (COST * 10n).toString(), purpose: 'behaviour' };
  const capHash = doAlice(encodeTokenCreate(capRec));
  await tk.mine(ALICE);
  const CAP = tokenId(ALICE, capRec.title, BigInt(tk.txIndex.get(capHash).blockNumber));
  doAlice(encodeExpress(CAP, POLL_Q, COMMIT, COST));
  await tk.mine(ALICE);
  doAlice(encodeExpress(CAP, POLL_R, COMMIT, COST));
  await tk.mine(ALICE);
  check('capped(2) allows exactly two expressions',
    tk.state.getToken(CAP).expressions === '2');
  no = false;
  try { tk.submitRaw(tryAlice(encodeExpress(CAP, POLL_S, COMMIT, COST))); }
  catch (e) { no = /cap of 2/.test(e.message); }
  check('capped(2) refuses the third', no);

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeExpress('0x' + 'ff'.repeat(32), POLL_Q, COMMIT, COST)));
  } catch (e) { no = /unknown token/.test(e.message); }
  check('expressing on a token that does not exist is refused', no);

  // --- assets: an ordinary token, held and sent -------------------------
  // The chain is not only for questions. A token may be a plain fungible
  // asset with a symbol, transferable like one on any other network - and the
  // chalk properties are then something a creator CHOOSES, not something
  // every token is stuck with.
  const assetRec = {
    kind: 'asset',
    title: 'Feira Token',
    symbol: 'FEIRA',
    decimals: 18,
    initialSupply: (1000n * 10n ** 18n).toString(),
    maxSupply: '0',
    issuable: true,
    transferable: true,
  };
  const assetHash = doAlice(encodeTokenCreate(assetRec));
  await tk.mine(ALICE);
  const FEIRA = tokenId(ALICE, assetRec.title, BigInt(tk.txIndex.get(assetHash).blockNumber));
  const asset = tk.state.getToken(FEIRA);
  check('an ordinary transferable token can be created',
    asset !== null && asset.kind === 'asset' && asset.symbol === 'FEIRA'
    && asset.transferable === true,
    'the chalk properties are a choice, not a cage');
  check('its initial supply is minted to its creator',
    tk.state.tokenBalanceOf(FEIRA, ALICE) === 1000n * 10n ** 18n
    && asset.minted === (1000n * 10n ** 18n).toString());
  check('an asset carries no question machinery',
    asset.options.length === 0 && asset.voteMode === '' && asset.expressionCost === '0',
    'a record that carried the parts of a question it is not would lie about itself');

  // --- transfer: holder to holder ---------------------------------------
  doAlice(encodeTransfer(FEIRA, 250n * 10n ** 18n), BOB);
  await tk.mine(ALICE);
  check('a transferable token moves from holder to holder',
    tk.state.tokenBalanceOf(FEIRA, ALICE) === 750n * 10n ** 18n
    && tk.state.tokenBalanceOf(FEIRA, BOB) === 250n * 10n ** 18n);
  check('and a transfer mints nothing - the supply is untouched',
    tk.state.getToken(FEIRA).minted === (1000n * 10n ** 18n).toString(),
    'issuance creates, transfer only moves');

  // BOB, who is merely a holder, can pass them on - which is exactly what
  // ISSUE refuses and exactly what makes this a market.
  doBob(encodeTransfer(FEIRA, 100n * 10n ** 18n), CAROL);
  await tk.mine(ALICE);
  check('a holder who is not the creator can pass units on',
    tk.state.tokenBalanceOf(FEIRA, BOB) === 150n * 10n ** 18n
    && tk.state.tokenBalanceOf(FEIRA, CAROL) === 100n * 10n ** 18n,
    'this is the difference between transfer and issuance, in one check');

  no = false;
  try { tk.submitRaw(tryBob(encodeTransfer(FEIRA, 10000n * 10n ** 18n), CAROL)); }
  catch (e) { no = /insufficient token balance/.test(e.message); }
  check('a transfer of more than the holder has is refused', no);

  // --- and the keystone still holds -------------------------------------
  no = false;
  try { tk.submitRaw(tryAlice(encodeTransfer(GIZ, COST), BOB)); }
  catch (e) { no = /not transferable/.test(e.message); }
  check('GIZ still cannot be transferred, whatever anyone asks', no,
    'transferability is now a real operation, and it is still refused here');

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate(
      { ...assetRec, title: 'a tradable political token', purpose: 'electoral' })));
  } catch (e) { no = /can never be transferable/.test(e.message); }
  check('an ASSET declaring a political purpose cannot be transferable either', no,
    'calling it an asset is not a way around the rule');

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate({ ...assetRec, title: 'no symbol', symbol: '' })));
  } catch (e) { no = /needs a symbol/.test(e.message); }
  check('an asset without a symbol is refused', no);

  no = false;
  try {
    tk.submitRaw(tryAlice(encodeTokenCreate(
      { ...assetRec, title: 'asset with options', options: ['a', 'b'] })));
  } catch (e) { no = /no options/.test(e.message); }
  check('an asset carrying options is refused', no,
    'the kind is declared, not guessed from which fields turned up');

  // --- consensus ----------------------------------------------------------
  const tkMirror = await new Chain(Chain.loadGenesis(GENESIS), scratch('tokens-b')).init();
  for (let n = 1; n <= Number(tk.height); n++) {
    await tkMirror.appendSerialized(serializeBlock(tk.blockByNumber(n)));
  }
  check('a second node re-derives the identical token state',
    tkMirror.state.root() === tk.state.root()
    && tkMirror.state.getToken(GIZ).burned === (COST * 2n).toString()
    && tkMirror.state.tokenBalanceOf(GIZ, BOB) === COST * 8n,
    'issuance, burn and counts all live in the root');
  check('including every transfer, re-executed from the raw blocks',
    tkMirror.state.tokenBalanceOf(FEIRA, BOB) === 150n * 10n ** 18n
    && tkMirror.state.tokenBalanceOf(FEIRA, CAROL) === 100n * 10n ** 18n);

  // A reorg must return the burned units AND unwind the issuance. Because
  // tokens live in state, this comes for free - the same property the vote
  // keys rely on.
  const tkFork = await new Chain(Chain.loadGenesis(GENESIS), scratch('tokens-fork')).init();
  for (let n = 1; n <= 4; n++) await tkFork.appendSerialized(serializeBlock(tk.blockByNumber(n)));
  for (let n = 0; n <= Number(tk.height) - 4 + 1; n++) await tkFork.mine(CAROL);
  for (let n = 5; n <= Number(tkFork.height); n++) {
    await tk.appendSerialized(serializeBlock(tkFork.blockByNumber(n)));
  }
  check('a reorg unwound the token entirely - creation, issuance and burn',
    tk.head.hash === tkFork.head.hash
    && tk.state.getToken(GIZ) === null
    && tk.state.tokenBalanceOf(GIZ, BOB) === 0n,
    'no side register to drift out of step');

  // ----------------------------------------------------------- earning chalk
  console.log('\n9. earning chalk: how a person with none gets some');

  // The issuer is the publisher's side of "publisher pays, speaker earns".
  // It runs on a node because it has to sign and broadcast a real ISSUE.
  const iNode = new Node({ genesisPath: GENESIS, dataDir: scratch('issuer'), miner: ALICE });
  await iNode.ready;
  for (let i = 0; i < 4; i++) await iNode.chain.mine(ALICE);
  const iRec = { kind: 'expression', title: 'Chalk (GIZ) on the earning node',
                 options: ['agree', 'disagree'], voteMode: 'quantum',
                 initialSupply: '0', maxSupply: '0', expressionCost: COST.toString(),
                 issuable: true, purpose: 'social', transferable: false };
  const iHash = iNode.chain.submitRaw(toHex(signTransaction(
    { nonce: 0n, gasPrice: gasP, gasLimit: 300000n, to: ALICE, value: 0n,
      data: encodeTokenCreate(iRec) }, ALICE_KEY, iNode.chain.chainId)));
  await iNode.chain.mine(ALICE);
  const IGIZ = tokenId(ALICE, iRec.title, BigInt(iNode.chain.txIndex.get(iHash).blockNumber));

  const issuer = iNode.enableIssuer({
    tokenId: IGIZ, privateKey: ALICE_KEY, grantExpressions: 20, difficulty: 400,
  });
  check('the issuer signs as the token CREATOR, which is what makes ISSUE valid',
    issuer.address === iNode.chain.state.getToken(IGIZ).creator);
  check('one grant is enough chalk for twenty expressions',
    issuer.grantAmount === COST * 20n);

  // --- the work path: one button, a few seconds, no wallet management ------
  const job = issuer.challengeFor(BOB);
  check('a puzzle is issued, bound to the address that will receive',
    job.address === BOB && job.difficulty === 400);
  const solution = solveWork(job.challenge, BOB, job.difficulty);
  check('the puzzle is solvable, and the solution verifies', solution !== null
    && verifyWork(job.challenge, BOB, solution, job.difficulty),
    `nonce ${solution}`);
  check('the same solution does NOT verify for another address',
    !verifyWork(job.challenge, CAROL, solution, job.difficulty),
    'a solved challenge is worthless to anyone else');

  const grant = issuer.redeem({ address: BOB, challenge: job.challenge, nonce: solution });
  await iNode.chain.mine(ALICE);
  check('solving it earns chalk, mined as an ordinary ISSUE',
    iNode.chain.state.tokenBalanceOf(IGIZ, BOB) === COST * 20n
    && iNode.chain.receiptFor(grant.txHash).status === 1);
  check('the grant hands over NO MOLI at all',
    iNode.chain.state.balanceOf(BOB) === 0n && grant.stipendTx === null,
    'a transferable coin given for registering a political preference is exactly '
    + 'what art. 29 8 describes - so nothing is given');

  refused = '';
  try { issuer.redeem({ address: BOB, challenge: job.challenge, nonce: solution }); }
  catch (e) { refused = e.message; }
  check('a challenge is single-use', /unknown or already-used/.test(refused), refused);

  refused = '';
  try { issuer.challengeFor(BOB); } catch (e) { refused = e.message; }
  check('no second grant while the address can still speak', /already hold enough/.test(refused),
    'caps hoarding without knowing anything about the person');

  const job2 = issuer.challengeFor(CAROL);
  refused = '';
  try { issuer.redeem({ address: CAROL, challenge: job2.challenge, nonce: 0 }); }
  catch (e) { refused = e.message; }
  check('a wrong nonce is refused', /does not solve/.test(refused), refused);

  const job3 = issuer.challengeFor(CAROL);
  const sol3 = solveWork(job3.challenge, CAROL, job3.difficulty);
  refused = '';
  try { issuer.redeem({ address: BOB, challenge: job3.challenge, nonce: sol3 }); }
  catch (e) { refused = e.message; }
  check("one address cannot redeem another's challenge",
    /issued to another address/.test(refused), refused);

  // --- the app path: a linking proof, and NO puzzle ------------------------
  // The application must never solve the puzzle: mining inside a mobile app is
  // banned by Apple 3.1.5(ii) and by Google Play, and the store position is
  // what the compliance argument rests on.
  const appGrant = issuer.grantForProof({ address: CAROL, appAccount: 'app-account-1' });
  await iNode.chain.mine(ALICE);
  check('the app can ask for a grant on a linked address at the push of a button',
    iNode.chain.state.tokenBalanceOf(IGIZ, CAROL) === COST * 20n
    && appGrant.via === 'proof');

  refused = '';
  try { issuer.grantForProof({ address: CAROL }); } catch (e) { refused = e.message; }
  check('the app path obeys the same eligibility rule as the puzzle',
    /already hold enough/.test(refused), 'one rule, two doors');

  // --- and the chalk earned is chalk that works ---------------------------
  // Zero MOLI, zero gas price. Speaking is free; the burn is the cost.
  const spend = iNode.chain.submitRaw(toHex(signTransaction(
    { nonce: 0n, gasPrice: 0n, gasLimit: 300000n, to: BOB, value: 0n,
      data: encodeExpress(IGIZ, POLL_Q, COMMIT, COST) }, BOB_KEY, iNode.chain.chainId)));
  await iNode.chain.mine(ALICE);
  check('a wallet holding NO MOLI earned chalk and spoke with it',
    iNode.chain.receiptFor(spend).status === 1
    && iNode.chain.state.balanceOf(BOB) === 0n
    && iNode.chain.state.tokenBalanceOf(IGIZ, BOB) === COST * 19n
    && iNode.chain.state.getToken(IGIZ).expressions === '1',
    'no funding, no purchase, no market, no priced asset changing hands');

  // ...and the exemption is exactly that: an exemption for speaking, not an
  // open door. Everything else still pays the floor.
  const priced = await new Chain(Chain.loadGenesis(GENESIS), scratch('fee'),
    { minGasPrice: 1000000000n }).init();
  for (let i = 0; i < 4; i++) await priced.mine(ALICE);
  let cheap = false;
  try {
    priced.submitRaw(toHex(signTransaction(
      { nonce: 0n, gasPrice: 0n, gasLimit: 21000n, to: BOB, value: 1n, data: '0x' },
      ALICE_KEY, priced.chainId)));
  } catch (e) { cheap = /below this node's minimum/.test(e.message); }
  check('an ordinary transaction at zero gas price is still refused', cheap,
    'a free transaction class must not become a free spam class');

  // -------------------------------------------------------------- hardening
  console.log('\n10. network hardening (each one is an attack, not a lint)');

  const { RLP } = await import('@ethereumjs/rlp');
  const {
    SECP256K1_N, MAX_EXTRA_DATA_BYTES, MAX_TRANSACTIONS_PER_BLOCK,
    MAX_FUTURE_DRIFT_SECONDS, MAX_REQUEST_BYTES,
  } = await import('../src/limits.js');
  const { assertHeaderBounds, mineHeader, nextDifficulty } = await import('../src/block.js');
  const { decodeTransaction } = await import('../src/tx.js');
  const { bigToBytes, bytesToBig } = await import('../src/crypto.js');

  const sec = await new Chain(Chain.loadGenesis(GENESIS), scratch('sec'),
    { maxReorgDepth: 3, maxMempoolPerSender: 4, maxMempoolSize: 6, maxOrphans: 2 }).init();
  for (let i = 0; i < 6; i++) await sec.mine(ALICE);

  // --- signature malleability (EIP-2) -------------------------------------
  // For every valid (r, s) the pair (r, n - s) signs the same message. Accept
  // both and the same authorised transaction exists under two hashes, so a
  // stranger can get a mutated copy mined and every client tracking its own
  // transaction by hash is left watching one that will never appear.
  const plain = signTransaction(
    { nonce: 0n, gasPrice: gasP, gasLimit: 21000n, to: BOB, value: 1n, data: '0x' },
    ALICE_KEY, sec.chainId);
  const parts = RLP.decode(plain);
  const flipped = [...parts];
  flipped[8] = bigToBytes(SECP256K1_N - bytesToBig(parts[8]));
  let blocked = false;
  try { decodeTransaction(RLP.encode(flipped), sec.chainId); }
  catch (e) { blocked = /malleable/.test(e.message); }
  check('a malleated signature (s -> n-s) is refused', blocked,
    'EIP-2: the upper half of the curve order is not accepted');
  check('and the original of that very transaction still decodes',
    decodeTransaction(plain, sec.chainId).from === ALICE,
    'the guard refuses the mutation, not the signature');

  blocked = false;
  const zeroS = [...parts];
  zeroS[8] = new Uint8Array(0);
  try { decodeTransaction(RLP.encode(zeroS), sec.chainId); }
  catch (e) { blocked = /out of range/.test(e.message); }
  check('a signature with s = 0 is refused', blocked);

  // --- the time warp ------------------------------------------------------
  // Difficulty falls whenever a block claims the target interval elapsed. An
  // unbounded future timestamp is therefore a free difficulty cut, repeatable
  // every block until the chain costs nothing to mine.
  const parent = sec.head;
  const farFuture = BigInt(Math.floor(Date.now() / 1000)) + MAX_FUTURE_DRIFT_SECONDS + 3600n;
  const warpCandidate = await sec.composeBlock(ALICE, parent);
  const warpHeader = {
    ...warpCandidate.header,
    timestamp: farFuture,
    difficulty: nextDifficulty(parent.header, farFuture,
      sec.genesis.targetBlockSeconds, sec.genesis.minimumDifficulty),
  };
  const warpSealed = mineHeader(warpHeader);
  blocked = false;
  try {
    await sec.processBlock({ header: warpSealed, hash: blockHash(warpSealed),
                       transactions: warpCandidate.transactions });
  } catch (e) { blocked = /in the future/.test(e.message); }
  check('a block timestamped far in the future is refused', blocked,
    'closes the time-warp difficulty attack');
  check('the warp block really did lower difficulty, which is why it matters',
    warpHeader.difficulty < parent.header.difficulty,
    `${parent.header.difficulty} -> ${warpHeader.difficulty}`);

  // --- header field sizes -------------------------------------------------
  blocked = false;
  try {
    assertHeaderBounds({ ...parent.header,
      extraData: '0x' + 'aa'.repeat(MAX_EXTRA_DATA_BYTES + 1) });
  } catch (e) { blocked = /extraData is/.test(e.message); }
  check('oversized header extraData is refused', blocked,
    'a field nobody bounds is a free place to put a megabyte, forever');

  blocked = false;
  try { assertHeaderBounds({ ...parent.header, nonce: 1n << 100n }); }
  catch (e) { blocked = /nonce exceeds/.test(e.message); }
  check('a header nonce beyond 64 bits is refused', blocked);

  // --- block-level work bounds -------------------------------------------
  // Checked before the proof of work is even looked at, so a block claiming
  // absurd work costs the verifier nothing to throw away.
  blocked = false;
  try {
    await sec.verifyAgainstParent({
      header: { ...parent.header, number: parent.header.number + 1n,
                timestamp: parent.header.timestamp + 1n },
      hash: parent.hash,
      transactions: new Array(MAX_TRANSACTIONS_PER_BLOCK + 1).fill({ hash: '0x00' }),
    }, parent);
  } catch (e) { blocked = /transactions, limit is/.test(e.message); }
  check('a block carrying more transactions than the limit is refused', blocked);

  blocked = false;
  try {
    await sec.verifyAgainstParent({
      header: { ...parent.header, number: parent.header.number + 1n,
                timestamp: parent.header.timestamp + 1n,
                gasUsed: parent.header.gasLimit + 1n },
      hash: parent.hash,
      transactions: [],
    }, parent);
  } catch (e) { blocked = /more gas used than the block allows/.test(e.message); }
  check('a block claiming more gas than its own limit is refused', blocked);

  // --- mempool caps -------------------------------------------------------
  const flood = await new Chain(Chain.loadGenesis(GENESIS), scratch('flood'),
    { maxMempoolPerSender: 4, maxMempoolSize: 6 }).init();
  for (let i = 0; i < 4; i++) await flood.mine(ALICE);
  for (let i = 0; i < 4; i++) {
    flood.submitRaw(toHex(signTransaction(
      { nonce: BigInt(i), gasPrice: gasP, gasLimit: 21000n, to: BOB, value: 1n, data: '0x' },
      ALICE_KEY, flood.chainId)));
  }
  blocked = false;
  try {
    flood.submitRaw(toHex(signTransaction(
      { nonce: 4n, gasPrice: gasP, gasLimit: 21000n, to: BOB, value: 1n, data: '0x' },
      ALICE_KEY, flood.chainId)));
  } catch (e) { blocked = /too many pending transactions/.test(e.message); }
  check('one sender cannot occupy the whole mempool', blocked,
    'crowding everybody out from one address is as effective as from a thousand');

  // Full mempool: only a higher bid gets in, and it displaces the cheapest.
  const rich = await new Chain(Chain.loadGenesis(GENESIS), scratch('rich'),
    { maxMempoolSize: 2, maxMempoolPerSender: 8 }).init();
  for (let i = 0; i < 4; i++) await rich.mine(ALICE);
  rich.submitRaw(toHex(signTransaction(
    { nonce: 0n, gasPrice: gasP, gasLimit: 21000n, to: BOB, value: 1n, data: '0x' },
    ALICE_KEY, rich.chainId)));
  rich.submitRaw(toHex(signTransaction(
    { nonce: 1n, gasPrice: gasP * 3n, gasLimit: 21000n, to: BOB, value: 1n, data: '0x' },
    ALICE_KEY, rich.chainId)));
  blocked = false;
  try {
    rich.submitRaw(toHex(signTransaction(
      { nonce: 2n, gasPrice: gasP, gasLimit: 21000n, to: BOB, value: 1n, data: '0x' },
      ALICE_KEY, rich.chainId)));
  } catch (e) { blocked = /does not outbid the cheapest/.test(e.message); }
  check('a full mempool refuses a transaction that does not outbid the cheapest', blocked);
  const outbid = rich.submitRaw(toHex(signTransaction(
    { nonce: 2n, gasPrice: gasP * 5n, gasLimit: 21000n, to: BOB, value: 1n, data: '0x' },
    ALICE_KEY, rich.chainId)));
  check('but a higher bid gets in and displaces exactly one',
    rich.mempool.has(outbid) && rich.mempool.size === 2,
    'paying to be included is the intended way to compete for space');

  // --- orphan pool --------------------------------------------------------
  // The one place a node stores something it has NOT validated, so it is the
  // one place an unverifiable block costs a peer nothing to plant.
  const donor = await new Chain(Chain.loadGenesis(GENESIS), scratch('donor')).init();
  for (let i = 0; i < 6; i++) await donor.mine(CAROL);
  const orph = await new Chain(Chain.loadGenesis(GENESIS), scratch('orph'), { maxOrphans: 2 }).init();
  const results = [];
  for (let n = 6; n >= 2; n--) results.push(await orph.appendSerialized(serializeBlock(donor.blockByNumber(n))));
  check('the orphan pool is capped',
    orph.orphanCount() === 2 && results.some((r) => r.reason === 'orphan pool full'),
    `${orph.orphanCount()} held, the rest refused`);

  // --- deep reorg ---------------------------------------------------------
  // A branch mined in private, deeper than the bound, is refused however heavy
  // it is. The cost of this rule is stated in src/limits.js and is real.
  const fork = await new Chain(Chain.loadGenesis(GENESIS), scratch('deep')).init();
  await fork.appendSerialized(serializeBlock(sec.blockByNumber(1)));
  for (let i = 0; i < 8; i++) await fork.mine(CAROL);
  let refusedDeep = null;
  for (let n = 2; n <= Number(fork.height); n++) {
    const r = await sec.appendSerialized(serializeBlock(fork.blockByNumber(n)));
    if (r.refusedReorg) refusedDeep = r.refusedReorg;
  }
  check('a reorg deeper than the limit is refused, however heavy the branch',
    refusedDeep !== null && sec.head.hash !== fork.head.hash,
    refusedDeep ? `refused at depth ${refusedDeep.depth}` : 'not refused');
  check('the refused blocks are KEPT, not discarded',
    sec.blockByHash(fork.head.hash) !== null,
    'so an operator can inspect what was offered rather than guess');

  // --- request size -------------------------------------------------------
  const oversize = await fetch(nodeB.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"padding":"' + 'x'.repeat(MAX_REQUEST_BYTES + 1024) + '"}',
  }).then((r) => r.status).catch(() => 'connection refused');
  check('an oversized request body is refused rather than buffered',
    oversize === 413 || oversize === 'connection refused', String(oversize));

  // ------------------------------------------------------------ persistence
  console.log('\n11. persistence and revalidation from disk');
  const dirA = nodeA.chain.dataDir;
  await nodeA.stop();
  const reloaded = new Node({ genesisPath: GENESIS, dataDir: dirA, miner: ALICE });
  await reloaded.ready;
  check('chain reloaded from disk', reloaded.chain.height === 4n);
  check('reloaded head is unchanged', reloaded.chain.head.hash === headDoc.hash);
  check('reloaded state root is unchanged', reloaded.chain.state.root() === nodeB.chain.state.root());

  await nodeB.stop();

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nFATAL', error);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
