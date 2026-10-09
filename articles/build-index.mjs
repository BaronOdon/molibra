#!/usr/bin/env node
/**
 * Builds the articles catalogue the /articles page reads.
 *
 *   node articles/build-index.mjs
 *
 * For every articles/<slug>/meta.json it hashes each listed PDF, writes
 * articles/<slug>/MANIFEST.txt (sha256sum format, so `sha256sum -c` checks a
 * download), and writes articles/index.json with the sizes and hashes.
 *
 * ⛔ The MANIFEST is what goes on chain. One record in the DocumentRegistry
 * authenticates every language at once, the way record #1 (the e-mail to the
 * United Nations) authenticates the seven PDFs it carried. So once a manifest
 * is registered, its PDFs and its text are frozen: a re-rendered PDF has
 * different bytes, a different hash, and would no longer match the record. A
 * changed article is a new slug and a new record, never an edit.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const articles = [];
for (const slug of readdirSync(DIR).sort()) {
  const metaFile = join(DIR, slug, 'meta.json');
  if (!existsSync(metaFile)) continue;
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`bad slug ${slug}`);
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const languages = meta.languages.map((l) => {
    if (!/^[a-z]{2}$/.test(l.code)) throw new Error(`bad language code ${l.code}`);
    const file = `${l.code}.pdf`;
    const buf = readFileSync(join(DIR, slug, file));
    return { ...l, file, bytes: buf.length, sha256: sha(buf) };
  });
  const lines = [
    `# ${meta.manifestTitle}`,
    `# ${meta.author} - ${meta.date}`,
    `# Molibra DocumentRegistry ${meta.registry} (chain 20226): the SHA-256 of THIS file is the record.`,
    `# Check a download with:  sha256sum -c MANIFEST.txt`,
    ...languages.map((l) => `${l.sha256}  ${l.file}`),
    '',
  ];
  const manifest = lines.join('\n');
  // ⛔ Never rewrite a manifest that is already the registered one.
  const mPath = join(DIR, slug, 'MANIFEST.txt');
  if (existsSync(mPath) && meta.frozen) {
    if (readFileSync(mPath, 'utf8') !== manifest) {
      throw new Error(`${slug}: frozen manifest would change - a changed article is a new slug`);
    }
  } else {
    writeFileSync(mPath, manifest);
  }
  const manifestSha = sha(readFileSync(mPath));
  // An edition after the first is its own slug (its own manifest and record)
  // that names the article it updates in `of`; the page shows them together.
  if (meta.of && !existsSync(join(DIR, meta.of, 'meta.json'))) throw new Error(`${slug}: of=${meta.of} does not exist`);
  articles.push({
    slug, date: meta.date, author: meta.author, registry: meta.registry,
    edition: meta.edition ?? 1, ...(meta.of ? { of: meta.of } : {}),
    manifest: { file: 'MANIFEST.txt', sha256: manifestSha, bytes: statSync(mPath).size },
    ...(meta.registration ? { registration: meta.registration } : {}),
    label: meta.label, original: meta.original, languages,
  });
  console.log(`${slug}: ${languages.length} languages, manifest 0x${manifestSha}`);
}
writeFileSync(join(DIR, 'index.json'), JSON.stringify({ articles }, null, 1) + '\n');
