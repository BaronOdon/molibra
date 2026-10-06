#!/usr/bin/env node
/**
 * Molibra bridge-bot watchdog - tells the operator on Telegram when the bot
 * needs a person. Holds no key and sends nothing on any chain.
 *
 *   node bots/watchdog.mjs --data-dir C:\Users\Administrator\molibra-bots
 *        [--token-source C:\path\send_to_bot.py] [--test]
 *
 * Run every 5 minutes by its own scheduled task. Each condition alerts ONCE
 * when it starts and once more ("cleared") when it ends; the conditions seen
 * are kept in <data-dir>/watchdog-state.json.
 *
 *   dead      heartbeat.json older than 15 minutes (bot dead or hung)
 *   stopped   STOP present (the whole bot exits) / STOP-FAST or fast-state paused
 *   pending   new items in pending-operator.json (each item alerted once)
 *   gas       relayer ETH < 0.001 on Ethereum, or a bot address < 1 MOLI
 *   errors    3+ error lines in the last 200 log lines
 *
 * ⛔ The Telegram token is read at run time from the operator's send_to_bot.py
 *    (TELEGRAM_TOKEN / TELEGRAM_CHAT_ID). It is never copied into this repo.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) =>
  a.startsWith('--') ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : []));
const DATA = args['data-dir'] || 'C:\\Users\\Administrator\\molibra-bots';
const TOKEN_SOURCE = args['token-source'] || 'C:\\Users\\Administrator\\.claude\\skills\\bot-send-pdf\\send_to_bot.py';

export const LIMITS = {
  heartbeatStaleMs: 15 * 60 * 1000,
  relayerMinEth: 0.001,
  botMinMoli: 1,
  errorLines: 3,
  logTail: 200,
};
const RELAYER = '0xdd06138ffab66742e066d694d6bcf3e217653d20';
const HEADER_BOT = '0xd30cb4d5bd928313d0b50908b1f6dc3bfbe61dcf';
const ETH_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'];
const MOLIBRA = 'https://molibra.org/molibra';

const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

async function rpc(urls, method, params) {
  for (const u of urls) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
    } catch { /* next endpoint */ }
  }
  return null;
}

function telegramCreds() {
  const src = readFileSync(TOKEN_SOURCE, 'utf8');
  const token = (src.match(/TELEGRAM_TOKEN\s*=\s*["']([^"']+)["']/) || [])[1];
  const chat = (src.match(/TELEGRAM_CHAT_ID\s*=\s*["']([^"']+)["']/) || [])[1];
  if (!token || !chat) throw new Error('no TELEGRAM_TOKEN / TELEGRAM_CHAT_ID in ' + TOKEN_SOURCE);
  return { token, chat };
}

async function send(text) {
  const { token, chat } = telegramCreds();
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: '🛰 Molibra bridge: ' + text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('telegram: ' + (j.description || r.status));
  return j.result.message_id;
}

/** The conditions that hold now: { key: message }. Pure apart from the reads. */
export async function conditions(dataDir, now = Date.now()) {
  const out = {};
  const hb = readJson(join(dataDir, 'heartbeat.json'));
  const at = hb && Date.parse(hb.at);
  if (!at || now - at > LIMITS.heartbeatStaleMs) {
    out.dead = `heartbeat is ${at ? Math.round((now - at) / 60000) + ' min' : 'missing'} old: the bot is dead or hung.`;
  }
  if (existsSync(join(dataDir, 'STOP'))) out.stop = 'STOP file present: the whole bot is stopping/stopped.';
  if (existsSync(join(dataDir, 'STOP-FAST'))) out['stop-fast'] = 'STOP-FAST present: the fast (inventory) route is paused.';
  const fs = readJson(join(dataDir, 'fast-state.json'));
  if (fs && fs.paused) out['fast-paused'] = 'fast route AUTO-PAUSED: ' + (typeof fs.paused === 'object' ? JSON.stringify(fs.paused).slice(0, 200) : String(fs.paused));

  const pend = readJson(join(dataDir, 'pending-operator.json'), {});
  const items = Array.isArray(pend) ? pend : Array.isArray(pend.items) ? pend.items : Object.values(pend || {});
  for (const it of items) {
    const id = (it && ((it.leg ? it.leg + ':' : '') + (it.molibraTx || it.ethTx || it.tx || it.id || it.key || '')))
      || JSON.stringify(it).slice(0, 80);
    out['pending:' + id] = 'needs you: ' + JSON.stringify(it).slice(0, 300);
  }

  const relayerEth = await rpc(ETH_RPCS, 'eth_getBalance', [RELAYER, 'latest']);
  if (relayerEth !== null && Number(BigInt(relayerEth)) / 1e18 < LIMITS.relayerMinEth) {
    out['gas:relayer'] = `relayer ${RELAYER} has ${(Number(BigInt(relayerEth)) / 1e18).toFixed(5)} ETH (< ${LIMITS.relayerMinEth}); claims will stall.`;
  }
  for (const [name, a] of [['relayer', RELAYER], ['header bot', HEADER_BOT]]) {
    const b = await rpc([MOLIBRA], 'eth_getBalance', [a, 'latest']);
    if (b !== null && Number(BigInt(b)) / 1e18 < LIMITS.botMinMoli) {
      out['gas:molibra:' + a] = `${name} ${a} has ${(Number(BigInt(b)) / 1e18).toFixed(4)} MOLI (< ${LIMITS.botMinMoli}).`;
    }
  }

  try {
    const lines = readFileSync(join(dataDir, 'bridge-bot.log'), 'utf8').trim().split('\n').slice(-LIMITS.logTail);
    const errs = lines.filter((l) => /"level":"error"/.test(l));
    if (errs.length >= LIMITS.errorLines) out.errors = `${errs.length} error lines in the last ${LIMITS.logTail}; latest: ` + errs[errs.length - 1].slice(0, 240);
  } catch { /* no log yet */ }
  return out;
}

async function main() {
  const stateFile = join(DATA, 'watchdog-state.json');
  const prev = readJson(stateFile, { active: {} });
  if (args.test) { const id = await send('watchdog online (test message).'); console.log('sent test', id); return; }
  const now = await conditions(DATA);
  const sent = [];
  for (const [k, msg] of Object.entries(now)) {
    if (!prev.active[k]) { await send('⚠ ' + msg); sent.push(k); }
  }
  for (const k of Object.keys(prev.active)) {
    if (!now[k] && !k.startsWith('pending:')) { await send('✅ cleared: ' + prev.active[k]); sent.push('cleared:' + k); }
  }
  const next = { at: new Date().toISOString(), active: now };
  writeFileSync(stateFile + '.tmp', JSON.stringify(next, null, 1));
  renameSync(stateFile + '.tmp', stateFile);
  console.log(JSON.stringify({ at: next.at, active: Object.keys(now), sent }));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('watchdog.mjs')) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
