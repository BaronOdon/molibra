/**
 * Regression: one fake anchor must not freeze an anchor-following node.
 *
 * MolibraAnchor is permissionless behind a 20k WSRO bond. Before the fix a
 * single anchor at a height above the tip raised the finalized floor above
 * the head; every extension of the head then "forked below the floor" and was
 * refused - the whole network halted. This test reproduces that freeze with the
 * old rule (no allowlist, no local-chain check) and proves the fixed store
 * ignores the same anchor and keeps mining.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node } from '../src/node.js';
import { AnchorStore, DEFAULT_ANCHOR_PUBLISHERS, parsePublishers } from '../src/anchor.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENESIS = join(ROOT, 'genesis.json');
const MINER = '0x3333333333333333333333333333333333333333';
const ATTACKER = '0x' + 'ee'.repeat(20);
const PUB = DEFAULT_ANCHOR_PUBLISHERS[0];

let passed = 0; let failed = 0;
const check = (name, ok, note = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}${note ? '  ' + note : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${note ? '  ' + note : ''}`); }
};

/** The pre-fix rule: believes every publisher and never looks at the local chain. */
class OldRuleStore extends AnchorStore {
  constructor() { super({ publishers: null }); }
  attachChain() { return this; }
}

const fake = (publisher, height = 1000, hash = '0x' + 'ab'.repeat(32)) => ({
  height, blockHash: hash, cumulativeWork: (10n ** 30n).toString(), ethBlock: 100, publisher,
});

async function withNode(store, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-freeze-'));
  // Silence the intentional loud warnings so the test output stays readable.
  const warn = console.warn; const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const node = new Node({ genesisPath: GENESIS, dataDir: join(dir, 'n'), limits: { anchors: store } });
    await node.ready;
    for (let i = 0; i < 5; i++) await node.chain.mine(MINER);
    await fn(node, warnings);
    await node.stop?.();
  } finally {
    console.warn = warn;
    rmSync(dir, { recursive: true, force: true });
  }
}

const mineThree = async (node) => {
  const before = node.chain.height;
  for (let i = 0; i < 3; i++) {
    try { await node.chain.mine(MINER); } catch { /* counted below */ }
  }
  return node.chain.height - before;
};

console.log('anchor freeze regression\n');

// --- BEFORE: the old rule freezes ------------------------------------------
await withNode(new OldRuleStore(), async (node) => {
  const store = node.chain.anchors;
  store.add(fake(ATTACKER));
  store.setEthereumHead(100 + 96);
  check('old rule: the fake anchor raises the floor above the tip',
    store.finalizedHeight() === 1000n && node.chain.height < 1000n);
  const grown = await mineThree(node);
  check('old rule: the node FREEZES (no block adopted)', grown === 0n, `grew ${grown}`);
});

// --- AFTER: a non-allowlisted publisher is ignored -------------------------
await withNode(new AnchorStore({}), async (node, warnings) => {
  const store = node.chain.anchors;
  const r = store.add(fake(ATTACKER));
  store.setEthereumHead(100 + 96);
  check('an outsider\'s anchor is not added', r.added === false && !!r.ignored);
  check('and is logged loudly', warnings.some((w) => w.includes('ANCHOR IGNORED')));
  check('the floor stays unset', store.finalizedHeight() === -1n);
  const grown = await mineThree(node);
  check('the node keeps mining', grown === 3n, `grew ${grown}`);
});

// --- AFTER: even an allowlisted anchor above the tip does not bind ---------
await withNode(new AnchorStore({}), async (node, warnings) => {
  const store = node.chain.anchors;
  check('an allowlisted anchor is accepted into the store', store.add(fake(PUB)).added === true);
  store.setEthereumHead(100 + 96);
  check('but above the tip it does not raise the floor', store.finalizedHeight() === -1n);
  check('and says why', warnings.some((w) => w.includes('above the local tip')));
  const grown = await mineThree(node);
  check('the node keeps mining', grown === 3n, `grew ${grown}`);
});

// --- AFTER: an allowlisted anchor with the wrong hash does not bind --------
await withNode(new AnchorStore({}), async (node, warnings) => {
  const store = node.chain.anchors;
  store.add(fake(PUB, 3, '0x' + 'cd'.repeat(32)));
  store.setEthereumHead(100 + 96);
  check('a hash that is not the local block does not raise the floor', store.finalizedHeight() === -1n);
  check('it is reported as a disagreement',
    store.disagreements((h) => node.chain.blockByNumber(h)?.hash ?? null).length === 1);
  check('and logged', warnings.some((w) => w.includes('ANCHOR NOT BINDING')));
  const grown = await mineThree(node);
  check('the node keeps mining', grown === 3n, `grew ${grown}`);
});

// --- AFTER: a genuine anchor still binds, and still allows extension -------
await withNode(new AnchorStore({}), async (node) => {
  const store = node.chain.anchors;
  const b3 = node.chain.blockByNumber(3);
  store.add({ height: 3, blockHash: b3.hash, cumulativeWork: b3.totalDifficulty.toString(), ethBlock: 100, publisher: PUB });
  store.setEthereumHead(100 + 96);
  check('a matching allowlisted anchor binds the floor', store.finalizedHeight() === 3n);
  check('a reorg forking below it is refused', store.permitsReorgFrom(2).ok === false);
  const grown = await mineThree(node);
  check('and the head still extends', grown === 3n, `grew ${grown}`);
});

// --- publisher list parsing -------------------------------------------------
{
  const bad = (v) => { try { parsePublishers(v); return false; } catch { return true; } };
  check('an empty allowlist is refused', bad('') && bad(' , '));
  check('a non-address is refused', bad('0x1234'));
  check('addresses are lower-cased', parsePublishers('0x8D1F2713EB83E4D55FBEDA47B26FD08EC9170E14')[0] === PUB);
  check('the defaults are the two operator publishers',
    DEFAULT_ANCHOR_PUBLISHERS.length === 2
    && DEFAULT_ANCHOR_PUBLISHERS.includes('0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
