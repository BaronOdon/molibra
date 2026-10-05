#!/usr/bin/env node
/**
 * Render every src/web/tokens/<symbol>.svg to PNG at 256, 200 and 32 px with
 * headless Chrome, on a transparent background.
 *
 *   node tools/render-token-logos.mjs [--chrome <path>] [--preview <dir>]
 *
 * Writes src/web/tokens/<symbol>.png (256), <symbol>-200.png (CoinGecko),
 * <symbol>-64.png (Etherscan) and <symbol>-32.png. --preview also writes a contact sheet (preview.html + .png)
 * showing every logo at 1x on light and dark, and the 32 px one magnified with
 * nearest-neighbour so a human can check it actually reads at that size.
 *
 * ⛔ Chrome is used rather than an SVG library so the PNG is what a browser
 * draws; no npm dependency is added for a build-time step.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'src/web/tokens');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const CHROME = opt('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PREVIEW = opt('--preview', null);
const work = join(tmpdir(), 'molibra-logo-render');
mkdirSync(work, { recursive: true });

function shoot(htmlFile, out, w, h) {
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--force-device-scale-factor=1', '--default-background-color=00000000',
    `--user-data-dir=${join(work, 'profile')}`,
    `--window-size=${w},${h}`, `--screenshot=${out}`, pathToFileURL(htmlFile).href,
  ], { stdio: 'ignore', timeout: 60000 });
  if (!existsSync(out) || statSync(out).size < 100) throw new Error(`no screenshot: ${out}`);
}

const page = (body, w, h) => `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;width:${w}px;height:${h}px;overflow:hidden}img{display:block}</style>${body}`;

const symbols = readdirSync(DIR).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)).sort();
for (const s of symbols) {
  const svg = pathToFileURL(join(DIR, s + '.svg')).href;
  // 256: wallets, token list, Trust Wallet · 200: CoinGecko · 64: Etherscan · 32: lists
  for (const [size, name] of [[256, `${s}.png`], [200, `${s}-200.png`], [64, `${s}-64.png`], [32, `${s}-32.png`]]) {
    const html = join(work, `${s}-${size}.html`);
    writeFileSync(html, page(`<img src="${svg}" width="${size}" height="${size}">`, size, size));
    shoot(html, join(DIR, name), size, size);
  }
  console.log(`rendered ${s}`);
}

if (PREVIEW) {
  mkdirSync(PREVIEW, { recursive: true });
  const cell = (s) => {
    const p = (n) => pathToFileURL(join(DIR, n)).href;
    return `<div class="c"><b>${s}</b>
      <div class="row"><img src="${p(s + '.png')}" width="128"><span class="l"><img src="${p(s + '-32.png')}"></span><span class="d"><img src="${p(s + '-32.png')}"></span>
      <img class="px" src="${p(s + '-32.png')}" width="128"></div></div>`;
  };
  const w = 600, h = 40 + 172 * symbols.length;
  const html = join(PREVIEW, 'preview.html');
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:16px;background:#888;font:14px sans-serif;width:${w - 32}px;display:flex;flex-wrap:wrap;gap:12px}
    .c{background:#eee;padding:8px;width:520px} .row{display:flex;align-items:center;gap:12px}
    .l{background:#fff;padding:8px} .d{background:#111;padding:8px}
    .px{image-rendering:pixelated}</style>${symbols.map(cell).join('')}`);
  shoot(html, join(PREVIEW, 'preview.png'), w, h);
  console.log(`preview: ${join(PREVIEW, 'preview.png')}`);
}
