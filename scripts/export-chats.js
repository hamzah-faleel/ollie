#!/usr/bin/env node
// Read-only export of 1:1 WhatsApp chats from an OpenWA session into one Markdown transcript per person.
// Runs on YOUR machine (Node 22+, no dependencies) so chat content never touches the bot or any AI API on the server.
// Only issues GET requests, so a `viewer` API key is enough.
//
//   ssh -N -L 2785:127.0.0.1:2785 ubuntu@<server>        # in another terminal
//   OPENWA_API_KEY=<viewer key> node export-chats.js --session <session id>
//
// Options: --url http://127.0.0.1:2785  --out ./chat-export  --limit 2000 (messages per chat)  --min 3 (skip tiny chats)
//          --since 2025-01-01  --only "name part"  --groups (include groups)  --pause 1500 (ms between chats)
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);

const URL_ = opt('url', process.env.OPENWA_URL || 'http://127.0.0.1:2785').replace(/\/$/, '');
const KEY = process.env.OPENWA_API_KEY;
const SESSION = opt('session', process.env.OPENWA_SESSION);
const OUT = path.resolve(opt('out', './chat-export'));
const LIMIT = Math.min(Number(opt('limit', 2000)) || 2000, 2000);
const MIN = Number(opt('min', 3));
const SINCE = opt('since') ? Date.parse(opt('since')) / 1000 : 0;
const ONLY = (opt('only') || '').toLowerCase();
const PAUSE = Number(opt('pause', 1500));
const TZ = process.env.TZ || 'Asia/Colombo';

if (!KEY || !SESSION) {
  console.error('Need OPENWA_API_KEY (env) and --session <id>. Use a read-only (viewer) key.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(p, tries = 4) {
  for (let i = 0; ; i++) {
    const res = await fetch(`${URL_}/api${p}`, { headers: { 'X-API-Key': KEY } }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
    if (res.ok) return res.json();
    const retryable = [409, 503, 0].includes(res.status);
    if (!retryable || i >= tries) {
      const body = await res.text();
      if (res.status === 501) throw new Error('This engine cannot serve live history (needs whatsapp-web.js).');
      throw new Error(`GET ${p.split('?')[0]} -> ${res.status} ${body.slice(0, 120)}`);
    }
    await sleep(3000 * (i + 1));
  }
}

const stamp = (sec) => new Date(sec * 1000).toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16); // 2026-10-03 14:05
const safe = (s) => String(s).replace(/[\\/:*?"<>|\n\r]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Unknown';

function line(m, name) {
  const who = m.fromMe ? 'Me' : name;
  const tag = m.type === 'revoked' ? '[deleted message]' : m.type !== 'text' ? `[${m.type}]${m.body ? ' ' : ''}` : '';
  const body = m.type === 'revoked' ? '' : String(m.body || '').trim().replace(/\n/g, '\n    ');
  if (!tag && !body) return null;
  return `[${stamp(m.timestamp)}] ${who}: ${tag}${body}`;
}

async function phoneOf(chat) {
  const id = chat.id;
  if (/@(c\.us|s\.whatsapp\.net)$/.test(id)) return id.split('@')[0];
  try { // @lid: ask for the real number (best effort)
    const r = await get(`/sessions/${SESSION}/contacts/${encodeURIComponent(id)}/phone`, 0);
    const v = r.phone || r.number || r.phoneNumber || (typeof r === 'string' ? r : '');
    return String(v).replace(/\D/g, '');
  } catch { return ''; }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  const chats = (await get(`/sessions/${SESSION}/chats?limit=1000`))
    .filter((c) => (flag('groups') ? ['individual', 'group'].includes(c.kind) : c.kind === 'individual'))
    .filter((c) => !ONLY || String(c.name || '').toLowerCase().includes(ONLY));
  console.log(`${chats.length} chats to read (${flag('groups') ? 'incl. groups' : '1:1 only'}), up to ${LIMIT} messages each.`);

  const index = [];
  const used = new Set();
  let n = 0;
  for (const chat of chats) {
    n++;
    let msgs;
    try { msgs = await get(`/sessions/${SESSION}/messages/${encodeURIComponent(chat.id)}/history?deep=true&limit=${LIMIT}`); }
    catch (e) { console.warn(`  [${n}/${chats.length}] ${chat.name || chat.id}: ${e.message}`); continue; }
    msgs = msgs.filter((m) => m.timestamp >= SINCE && m.type !== 'call');
    if (msgs.length < MIN) { await sleep(PAUSE / 3); continue; }

    const name = chat.name || chat.id.split('@')[0];
    const phone = await phoneOf(chat);
    let file = safe(name);
    if (used.has(file.toLowerCase())) file += ` (${phone || chat.id.split('@')[0]})`;
    used.add(file.toLowerCase());

    const out = [`# Chat with ${name}`, '', `- phone: ${phone ? '+' + phone : 'unknown'}`,
      `- messages: ${msgs.length}${msgs.length >= LIMIT ? ` (most recent ${LIMIT}; older history exists)` : ''}`,
      `- span: ${stamp(msgs[0].timestamp).slice(0, 10)} to ${stamp(msgs[msgs.length - 1].timestamp).slice(0, 10)}`,
      `- exported: ${new Date().toISOString().slice(0, 10)}`];
    let month = '';
    for (const m of msgs) {
      const l = line(m, name);
      if (!l) continue;
      const mo = stamp(m.timestamp).slice(0, 7);
      if (mo !== month) { month = mo; out.push('', `## ${mo}`, ''); }
      out.push(l);
    }
    fs.writeFileSync(path.join(OUT, `${file}.md`), out.join('\n') + '\n', { mode: 0o600 });
    index.push({ name, phone, count: msgs.length, last: stamp(msgs[msgs.length - 1].timestamp).slice(0, 10), file: `${file}.md` });
    console.log(`  [${n}/${chats.length}] ${name}: ${msgs.length} messages`);
    await sleep(PAUSE); // be gentle: one chat at a time
  }

  index.sort((a, b) => b.last.localeCompare(a.last));
  fs.writeFileSync(path.join(OUT, '_index.md'), ['# Exported chats', '', '| Person | Phone | Messages | Last message | File |', '|---|---|---|---|---|',
    ...index.map((r) => `| ${r.name} | ${r.phone ? '+' + r.phone : ''} | ${r.count} | ${r.last} | ${r.file} |`)].join('\n') + '\n', { mode: 0o600 });
  console.log(`\nDone: ${index.length} transcripts in ${OUT}. Keep this folder out of git and delete it when you are finished.`);
})().catch((e) => { console.error('Export failed:', e.message); process.exit(1); });
