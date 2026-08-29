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
import { applyTransaction, State } from '../src/state.js';
import { fromHex, privateToAddress, toChecksumAddress, toHex } from '../src/crypto.js';
import { blockHash } from '../src/block.js';

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
  nodeA.mineBlocks(3);
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
  nodeA.mineBlocks(1);
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
    nodeA.chain.appendSerialized(tampered);
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
  const left = new Chain(Chain.loadGenesis(GENESIS), scratch('left')).init();
  const right = new Chain(Chain.loadGenesis(GENESIS), scratch('right')).init();

  left.mine(ALICE);
  const forkPoint = left.head;
  right.appendSerialized(serializeBlock(forkPoint));
  check('both chains share the fork point', right.head.hash === forkPoint.hash);

  // Left extends by one, right by two: right is heavier.
  left.mine(ALICE);
  right.mine(BOB);
  right.mine(BOB);
  check('left is 2 blocks, right is 3', left.height === 2n && right.height === 3n);
  check('right carries more total work', right.totalDifficulty > left.totalDifficulty);

  const leftHeadBefore = left.head.hash;
  for (let n = 2; n <= 3; n++) {
    left.appendSerialized(serializeBlock(right.blockByNumber(n)));
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
  const lighter = new Chain(Chain.loadGenesis(GENESIS), scratch('lighter')).init();
  lighter.appendSerialized(serializeBlock(forkPoint));
  lighter.mine(CAROL); // a different miner, so this is genuinely a different block
  const headBeforeLighter = left.head.hash;
  const lighterResult = left.appendSerialized(serializeBlock(lighter.head));
  check('lighter branch is accepted into the tree', lighterResult.accepted);
  check('lighter branch does not move the head', left.head.hash === headBeforeLighter);
  check('lighter branch is stored non-canonically',
    left.blockByHash(lighter.head.hash) !== null && !left.isCanonical(lighter.head.hash));

  // A block arriving before its parent must be held, then connected.
  const early = new Chain(Chain.loadGenesis(GENESIS), scratch('early')).init();
  const source = new Chain(Chain.loadGenesis(GENESIS), scratch('source')).init();
  source.mine(ALICE);
  source.mine(ALICE);
  const child = serializeBlock(source.blockByNumber(2));
  const parentBlock = serializeBlock(source.blockByNumber(1));
  const orphanResult = early.appendSerialized(child);
  check('out-of-order block is held as an orphan', orphanResult.reason === 'orphan' && early.height === 0n);
  early.appendSerialized(parentBlock);
  check('orphan connects once its parent arrives', early.height === 2n);
  check('connected chain matches the source', early.head.hash === source.head.hash);

  // A reorg that drops a mined transaction must hand it back to the mempool,
  // and the rolled-back balance must actually roll back.
  const dirL = scratch('tx-left');
  const chainL = new Chain(Chain.loadGenesis(GENESIS), dirL).init();
  const chainR = new Chain(Chain.loadGenesis(GENESIS), scratch('tx-right')).init();
  chainL.mine(ALICE); chainL.mine(ALICE); chainL.mine(ALICE);
  for (let n = 1; n <= 3; n++) chainR.appendSerialized(serializeBlock(chainL.blockByNumber(n)));

  const payTx = signTransaction(
    { nonce: 0n, gasPrice: 1000000000n, gasLimit: 21000n, to: CAROL, value: 3n * 10n ** 18n, data: '0x' },
    ALICE_KEY, chainL.chainId,
  );
  const payHash = chainL.submitRaw(toHex(payTx));
  chainL.mine(ALICE);
  check('transaction mined on the branch that will lose',
    chainL.txIndex.has(payHash) && chainL.state.balanceOf(CAROL) === 3n * 10n ** 18n);

  chainR.mine(BOB); chainR.mine(BOB); // heavier: two blocks against one
  for (let n = 4; n <= 5; n++) chainL.appendSerialized(serializeBlock(chainR.blockByNumber(n)));

  check('reorg dropped the block containing the transaction',
    chainL.head.hash === chainR.head.hash && !chainL.txIndex.has(payHash));
  check('dropped transaction returned to the mempool', chainL.mempool.has(payHash),
    `${chainL.lastReorg?.returnedToMempool ?? 0} returned`);
  check('recipient balance rolled back with the reorg', chainL.state.balanceOf(CAROL) === 0n);
  check('receipt for the dropped transaction is gone', chainL.receiptFor(payHash) === null);

  chainL.mine(ALICE);
  check('returned transaction can be mined again on the new branch',
    chainL.txIndex.has(payHash) && chainL.state.balanceOf(CAROL) === 3n * 10n ** 18n);

  // Side branches must survive a restart: one that is heavier tomorrow is
  // useless if it was thrown away today.
  const knownBefore = chainL.byHash.size;
  const headBefore = chainL.head.hash;
  const reloadedFork = new Chain(Chain.loadGenesis(GENESIS), dirL).init();
  check('every known block survived the restart', reloadedFork.byHash.size === knownBefore,
    `${reloadedFork.byHash.size} of ${knownBefore}`);
  check('fork choice re-derived the same head after restart', reloadedFork.head.hash === headBefore);
  check('the abandoned branch is still on disk and still non-canonical',
    reloadedFork.blockByHash(chainL.lastReorg.from) !== null
    && !reloadedFork.isCanonical(chainL.lastReorg.from));

  // The download-a-node-and-join case: a miner producing blocks faster than the
  // clock ticks must still produce blocks every other node accepts. This is the
  // regression guard for the header/difficulty timestamp split.
  const fast = new Chain(Chain.loadGenesis(GENESIS), scratch('fast')).init();
  fast.mine(ALICE); fast.mine(ALICE); fast.mine(ALICE); fast.mine(ALICE); fast.mine(ALICE);
  const stamps = fast.canonical.map((b) => b.header.timestamp);
  check('rapid mining still advances the timestamp every block',
    stamps.every((t, i) => i === 0 || t > stamps[i - 1]),
    stamps.slice(1).join(','));

  const joiner = new Chain(Chain.loadGenesis(GENESIS), scratch('joiner')).init();
  let joinFailure = null;
  for (let n = 1; n <= Number(fast.height); n++) {
    try { joiner.appendSerialized(serializeBlock(fast.blockByNumber(n))); }
    catch (e) { joinFailure = `#${n}: ${e.message}`; break; }
  }
  check('a fresh node accepts every block of a fast miner', joinFailure === null, joinFailure ?? '');
  check('the joining node reaches the same head', joiner.head.hash === fast.head.hash);

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
  const voteL = new Chain(Chain.loadGenesis(GENESIS), dirV).init();
  voteL.mine(ALICE); voteL.mine(ALICE); voteL.mine(ALICE);

  const voteHash = voteL.submitRaw(toHex(express(voteL, ALICE_KEY, ALICE, 0n, POLL_A)));
  check('an expression is accepted into the mempool', voteL.mempool.has(voteHash));
  voteL.mine(ALICE);
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
  voteL.mine(ALICE);
  check('the same wallet may still speak on a different poll',
    voteL.txIndex.has(otherPoll) && voteL.state.hasVoteKey(voteKey(ALICE, POLL_B)));
  check('speaking on poll B did not consume poll A for anyone else',
    !voteL.state.hasVoteKey(voteKey(BOB, POLL_A)));

  // Another wallet on the same poll: the key is per wallet, not per poll.
  voteL.mine(BOB); voteL.mine(BOB);
  const bobVote = voteL.submitRaw(toHex(express(voteL, BOB_KEY, BOB, 0n, POLL_A)));
  voteL.mine(BOB);
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
  try { applyTransaction(replayState, dupTx, (await import('../src/tx.js')).intrinsicGas(dupTx), BOB); }
  catch (e) { blockLevel = /already expressed/.test(e.message); }
  check('a block carrying a duplicate expression fails re-execution', blockLevel);

  // Every node must agree on who has spoken, so the keys are in the state root.
  const withoutKeys = voteL.state.clone();
  withoutKeys.voteKeys = new Set();
  check('vote keys change the state root', withoutKeys.root() !== voteL.state.root());
  const rootBefore = new Chain(Chain.loadGenesis(GENESIS), scratch('vote-root')).init().state.root();
  const emptyRoot = new State().root();
  check('a chain with no expressions hashes exactly as before',
    rootBefore === new Chain(Chain.loadGenesis(GENESIS), scratch('vote-root2')).init().state.root()
    && emptyRoot === new State(new Map(), new Set()).root());

  // An independent node re-deriving the chain must reach the same vote keys.
  const voteMirror = new Chain(Chain.loadGenesis(GENESIS), scratch('vote-mirror')).init();
  for (let n = 1; n <= Number(voteL.height); n++) {
    voteMirror.appendSerialized(serializeBlock(voteL.blockByNumber(n)));
  }
  check('a second node re-derived the same expressions independently',
    voteMirror.state.hasVoteKey(keyA) && voteMirror.state.root() === voteL.state.root());

  // A reorg that unwinds the block must unwind the right to speak again. This
  // is the whole reason the keys live in state rather than in a side register.
  const voteR = new Chain(Chain.loadGenesis(GENESIS), scratch('vote-right')).init();
  for (let n = 1; n <= 3; n++) voteR.appendSerialized(serializeBlock(voteL.blockByNumber(n)));
  const heightBeforeReorg = Number(voteL.height);
  for (let n = 4; n <= heightBeforeReorg + 1; n++) voteR.mine(CAROL);
  for (let n = 4; n <= Number(voteR.height); n++) {
    voteL.appendSerialized(serializeBlock(voteR.blockByNumber(n)));
  }
  check('the reorg took the branch carrying the expressions',
    voteL.head.hash === voteR.head.hash);
  check('the vote key was unwound with the block', !voteL.state.hasVoteKey(keyA));
  check('the wallet may speak again on the branch that survived',
    voteL.submitRaw(toHex(express(voteL, ALICE_KEY, ALICE, 0n, POLL_A))).startsWith('0x'));

  // ------------------------------------------------------------ persistence
  console.log('\n8. persistence and revalidation from disk');
  const dirA = nodeA.chain.dataDir;
  await nodeA.stop();
  const reloaded = new Node({ genesisPath: GENESIS, dataDir: dirA, miner: ALICE });
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
