/**
 * bridgedmoli.html against the contract it deploys.
 *
 * A page carries three things that are silently wrong when they drift: the
 * deploy bytecode, the function selectors, and the custom-error selectors. None
 * of them fails loudly. A stale bytecode deploys something nobody has read; a
 * plausible-but-wrong selector builds a transaction that calls nothing; a wrong
 * error selector makes the pre-flight report the wrong reason, which is worse
 * than reporting none, because the operator acts on it.
 *
 * ⛔ This is not hypothetical. settle.html shipped with a `release` selector
 * that had been computed by hand and was not remotely the right number - it did
 * not break, it lied quietly. Every value below is checked against keccak256 of
 * its signature, and the bytecode against the artifact it claims to come from.
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { keccak256, toHex } from '../src/crypto.js';
import { MOLI_BURN_TAG } from '../src/moliburn.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(ROOT, 'src/web/bridgedmoli.html'), 'utf8');
const artifact = JSON.parse(readFileSync(join(ROOT, 'bridge/artifacts/BridgedMoli.json'), 'utf8'));

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

console.log('bridgedmoli.html vs bridge/BridgedMoli.sol\n');

const sel = (s) => toHex(keccak256(new TextEncoder().encode(s))).slice(0, 10);

/* ------------------------------------------------------------ bytecode */

const embedded = page.match(/const BRIDGEDMOLI_BYTECODE = '(0x[0-9a-fA-F]*)'/);
check('the page embeds deploy bytecode', Boolean(embedded));
check('⛔ and it is EXACTLY the built artifact',
  embedded && embedded[1] === artifact.bytecode,
  embedded ? `${(embedded[1].length - 2) / 2} bytes` : 'no bytecode found');
check('  no placeholder survived the build',
  !page.includes('__BYTECODE__'));

/* ----------------------------------------------------------- selectors */

const SIGS = {
  claim: 'claim(uint256,bytes,bytes,bytes32[],bool[])',
  totalSupply: 'totalSupply()',
  balanceOf: 'balanceOf(address)',
  claimed: 'claimed(bytes32)',
  challengeBlk: 'challengeBlocks()',
  tipHeight: 'tipHeight()',
};

const selBlock = page.match(/const SEL = \{[\s\S]*?\n\};/);
check('the page has a selector table', Boolean(selBlock));
for (const [key, sig] of Object.entries(SIGS)) {
  const m = selBlock && selBlock[0].match(new RegExp(`${key}:\\s*'(0x[0-9a-f]{8})'`));
  check(`${key} is keccak of ${sig}`, Boolean(m) && m[1] === sel(sig),
    m ? `${m[1]} vs ${sel(sig)}` : 'not in the table');
}

/* ------------------------------------------------------- error selectors */

const errors = artifact.abi.filter((e) => e.type === 'error');
check('the contract declares custom errors', errors.length > 0, `${errors.length}`);

const errBlock = page.match(/const ERROR_SIGS = \{[\s\S]*?\n\};/);
check('the page has an error table', Boolean(errBlock));
for (const e of errors) {
  const sig = `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;
  const m = errBlock && errBlock[0].match(new RegExp(`${e.name}:\\s*'(0x[0-9a-f]{8})'`));
  check(`  ${e.name} decodes to itself`, Boolean(m) && m[1] === sel(sig),
    m ? `${m[1]} vs ${sel(sig)}` : 'MISSING from the page');
}
check('  and nothing is left over from a hand-written table',
  !page.includes('const ERRORS = {'),
  'a placeholder that only existed to be removed');

/* ----------------------------------------------------------- the payload */

check('the burn tag is the one src/moliburn.js computes',
  page.includes(`const MOLI_BURN_TAG = '${MOLI_BURN_TAG}'`), MOLI_BURN_TAG);
check('⛔ and the page never mentions the bridgeOut tag as something it can mint',
  !page.includes('0x9854175f'),
  'a bridgeOut destroys nothing; offering it here would be the whole bug');

/* -------------------------------------------------------- what it claims */

// ⛔ The honesty statements are load-bearing: a reader decides whether to
// accept this token based on them, so their absence is a defect, not a
// cosmetic one.
for (const [label, needle] of [
  ['says it is one-way', 'ONE-WAY'],
  ['says backing is the bonded anchor, not proof-of-work', 'bonded anchor'],
  ['says the challenge window is immutable', 'mmutable'],
  ['warns that a single false anchor is not slashable', 'single'],
  ['explains the MetaMask calldata refusal', 'External transactions to internal accounts'],
]) {
  check(`the page ${label}`, page.includes(needle));
}

// The deploy must not quietly default to a window of zero.
check('⛔ the challenge field is not zero by default',
  /id="challenge" value="(\d+)"/.test(page)
  && Number(page.match(/id="challenge" value="(\d+)"/)[1]) > 0,
  page.match(/id="challenge" value="(\d+)"/)?.[1]);

/* ------------------------------------------------------------- routing */

const rpc = readFileSync(join(ROOT, 'src/rpc.js'), 'utf8');
check('the page is served by a route',
  rpc.includes("'web', 'bridgedmoli.html'"),
  'an unrouted page is a file nobody can open');
check('and the node publishes the burn total the page reads',
  rpc.includes('outbound') && rpc.includes('burned'),
  'the conservation panel checks totalSupply against this');
/* ------------------------------------------- the flag day the page must obey */

// Below MOLI_BURN_ACTIVATION a moliBurn payload is NOT decoded as a burn:
// state.js takes the ordinary path, the value is zero, and nothing is
// destroyed. The page used to render "This destroys 1 MOLI" and enable the
// button anyway - false at the one moment somebody acts on it. These checks
// exist because a page that offers to destroy money must be able to say when
// it cannot.

check('the node publishes its activation heights',
  rpc.includes('activations') && rpc.includes('MOLI_BURN_ACTIVATION'),
  'a flag day nobody can read is one every page has to hardcode');
check('and whether the gate is open, not just the number',
  rpc.includes('active:') && rpc.includes('blocksAway'),
  'a reader should not have to fetch the height and do the comparison');
check('the page reads the gate from the node rather than hardcoding it',
  page.includes('activations?.moliBurn') && !/const\s+MOLI_BURN_ACTIVATION/.test(page),
  'a constant copied into a page drifts the moment the chain changes it');
check('the page disables the burn button when the gate is shut',
  /\$\('burn'\)\.disabled = true/.test(page));
check('and refuses on click too, re-reading the node',
  page.includes('burning is not active until height')
  && page.includes('live.activations?.moliBurn'),
  'the preview is advisory; the click is the gate');
check('it refuses rather than guessing when a node publishes no activations',
  page.includes('Refusing rather than guessing'),
  'an old node that cannot answer is not evidence the gate is open');
check('the gate is shown in the status panel, not only at the button',
  page.includes('stBurnGate'));

check('and the gate is checked BEFORE the field validation, not after',
  page.indexOf('burnActivation && !burnActivation.active') < page.indexOf('const b = buildBurn();\n  $'),
  'an empty recipient must not hide the gate, nor leave the button live');


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
