/**
 * Inject the built bytecode and the real error selectors into bridgedmoli.html.
 *
 * ⛔ The page must never carry a hand-pasted selector or a hand-pasted 5KB of
 * bytecode. Both come from the artifact, computed here, and
 * bridge/bridgedmoli-page-e2e.mjs fails if they ever drift apart again.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { keccak256, toHex } from '../src/crypto.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const artifact = JSON.parse(readFileSync(join(HERE, 'artifacts', 'BridgedMoli.json'), 'utf8'));
const sel = (s) => toHex(keccak256(new TextEncoder().encode(s))).slice(0, 10);

/** Custom errors, with their argument types, straight out of the ABI. */
const errors = artifact.abi.filter((e) => e.type === 'error');
const sigs = {};
for (const e of errors) {
  sigs[e.name] = sel(`${e.name}(${e.inputs.map((i) => i.type).join(',')})`);
}

const page = join(ROOT, 'src', 'web', 'bridgedmoli.html');
let html = readFileSync(page, 'utf8');

html = html.replace("'__BYTECODE__'", `'${artifact.bytecode}'`);

const table = 'const ERROR_SIGS = {\n'
  + Object.entries(sigs).map(([n, s]) => `  ${n}: '${s}',`).join('\n')
  + '\n};';
html = html.replace(/const ERROR_SIGS = \{[\s\S]*?\n\};/, table);

// The placeholder object that existed only to be removed.
html = html.replace(/const ERRORS = \{[\s\S]*?\n\};\n/, '');

writeFileSync(page, html, 'utf8');

console.log('bytecode injected:', (artifact.bytecode.length - 2) / 2, 'bytes');
console.log('error selectors:');
for (const [n, s] of Object.entries(sigs)) console.log(' ', s, n);
