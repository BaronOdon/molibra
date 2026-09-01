/**
 * Loading is a read.
 *
 * On 1 Sep 2026 the public node came back from a restart 645 blocks short and
 * mined a fork against its own peer. Nothing was corrupt and nothing crashed:
 * `appendSerialized` did not forward its options, so the replay inside `load()`
 * ran with `persist` at its default of true and rewrote the whole chain file
 * once per block. The write is atomic, so at every instant during a boot the
 * file on disk held a complete, valid, SHORT chain. Interrupting a boot
 * therefore did not tear the file - it durably truncated the history, to a
 * depth no reorg is allowed to cross.
 *
 * The invariant these checks pin is one sentence: a load writes nothing.
 */

import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chain } from '../src/chain.js';

const GENESIS = join(dirname(fileURLToPath(import.meta.url)), '..', 'genesis.json');
const fresh = (dir) => new Chain(Chain.loadGenesis(GENESIS), dir);

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('persistence across a restart\n');

const MINER = '0x9999999999999999999999999999999999999999';
const HEIGHT = 12;

const dir = mkdtempSync(join(tmpdir(), 'molibra-persist-'));
try {
  /* ------------------------------------------------- a chain worth reloading */

  const source = await fresh(dir).init();
  for (let i = 0; i < HEIGHT; i++) await source.mine(MINER);
  source.persist();

  const onDisk = readFileSync(source.chainFile, 'utf8');
  const storedHeight = Number(source.head.header.number);
  check('a chain was written to disk', storedHeight === HEIGHT, `height ${storedHeight}`);

  /* ------------------------------------- ⛔⛔ the invariant: a load writes nothing */

  const reloaded = fresh(dir);
  let writes = 0;
  const realPersist = reloaded.persist.bind(reloaded);
  reloaded.persist = () => { writes++; return realPersist(); };

  const before = statSync(reloaded.chainFile).mtimeMs;
  await reloaded.init();

  check('⛔⛔ load() called persist() ZERO times', writes === 0,
    writes === 0 ? '' : `called ${writes} times - a replay is rewriting the file it is reading`);
  check('the file was not touched at all', statSync(reloaded.chainFile).mtimeMs === before);
  check('and its bytes are identical', readFileSync(reloaded.chainFile, 'utf8') === onDisk);

  /* ----------------------------------------------- the load itself still works */

  check('every block came back', Number(reloaded.head.header.number) === HEIGHT,
    `height ${Number(reloaded.head.header.number)}`);
  check('the head is the stored head', reloaded.head.hash === source.head.hash);

  /* ------------------------------- ⛔ an INTERRUPTED load leaves the file whole */

  // The real failure was not a clean load - it was a boot that never finished.
  // Simulate it: abandon the replay part-way and assert the file still holds
  // the FULL history rather than the prefix that had been read.
  const interrupted = fresh(dir);
  const stopAfter = 4;
  let seen = 0;
  const realAppend = interrupted.appendSerialized.bind(interrupted);
  interrupted.appendSerialized = async (s, o) => {
    if (++seen > stopAfter) throw new Error('boot interrupted');
    return realAppend(s, o);
  };
  await interrupted.init().catch(() => {});

  const after = readFileSync(interrupted.chainFile, 'utf8');
  const blocksLeft = JSON.parse(after).blocks.length;
  check('⛔ an interrupted boot left the full history on disk', blocksLeft === HEIGHT,
    `${blocksLeft} of ${HEIGHT} blocks survive` + (blocksLeft === HEIGHT ? '' : ' - THIS IS THE 645-BLOCK LOSS'));
  check('the interrupted boot really did stop part-way', seen === stopAfter + 1,
    `read ${seen - 1} of ${HEIGHT}`);

  /* ------------------------------------------- and a fresh node still recovers */

  const recovered = await fresh(dir).init();
  check('a later boot recovers the whole chain', Number(recovered.head.header.number) === HEIGHT,
    `height ${Number(recovered.head.header.number)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
