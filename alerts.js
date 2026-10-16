// Attention alerts and the routine check. No AI: plain rules over data we already have.
//   every minute  : meetings (from a cached calendar list), delivering alerts, escalating urgent ones
//   every 10 min  : scan messages (VIPs, urgent words, bursts), waiting-for-reply nudges, "allow AI?" suggestions
// An alert is a WhatsApp text from the bot to the owner. If it is urgent and unacknowledged for a few minutes, it escalates to a
// PHONE CALL when Twilio is configured (OpenWA cannot place calls; it can only reject incoming ones). Replying to the bot with anything
// acknowledges all open alerts. Quiet hours hold normal alerts and suppress calls. Everything is rate limited.
const db = require('./db');
const calendar = require('./calendar');
const inbox = require('./inbox');

const TZ = process.env.TZ || 'Asia/Colombo';
const INTERVAL_MS = Math.max(0.01, Number(process.env.WATCH_INTERVAL_MIN || 10)) * 60_000;
const ESCALATE_MIN = Number(process.env.ALERT_ESCALATE_MIN || 4);          // urgent + unacknowledged this long -> call
const maxTextsPerHour = () => Number(process.env.ALERT_MAX_PER_HOUR || 8);
const CALL_DAILY_LIMIT = Number(process.env.CALL_DAILY_LIMIT || 5);
const CALL_MIN_GAP_MIN = Number(process.env.CALL_MIN_GAP_MIN || 5);
const CALL_IN_QUIET = /^(1|true|on|yes)$/i.test(process.env.ALERT_CALL_IN_QUIET || '');
const SPEAK_DETAILS = /^(1|true|on|yes)$/i.test(process.env.CALL_SPEAK_DETAILS || '');   // off: the call says nothing identifying
const VIP_WAIT_MIN = Number(process.env.VIP_WAIT_MIN || 5);
const KEYWORDS = new RegExp(`\\b(${(process.env.ALERT_KEYWORDS
  || 'urgent,asap,emergency,immediately,right now,call me,pick up,answer me,where are you,hospital,accident,important').split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
const BASE = (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');
const digits = (s) => String(s || '').replace(/\D/g, '');

db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    akey TEXT UNIQUE NOT NULL,           -- dedupe key: the same event never alerts twice
    kind TEXT NOT NULL,                  -- meeting | message | call | pending | suggest
    text TEXT NOT NULL,
    spoken TEXT,                         -- what a phone call would say (generic unless CALL_SPEAK_DETAILS)
    urgent INTEGER NOT NULL DEFAULT 0,
    footer INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    texted_at INTEGER,
    called_at INTEGER,
    acked_at INTEGER,
    resolved_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS vips (phone TEXT PRIMARY KEY, name TEXT);
`);

let deps = { send: async () => {}, meetings: (...a) => calendar.upcomingOnline(...a), meetingsOn: () => calendar.enabled() };
const init = (d) => { deps = { ...deps, ...d }; };

// ---------- time helpers ----------
const minutesLocal = (d = new Date()) => { const [h, m] = d.toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }).split(':').map(Number); return h * 60 + m; };
function inRange(range, d = new Date()) {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(range).trim());
  if (!m) return false;
  const cur = minutesLocal(d), from = Number(m[1]) * 60 + Number(m[2]), to = Number(m[3]) * 60 + Number(m[4]);
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}
const quietRange = () => (process.env.ALERT_QUIET ?? '23:30-07:00').trim();
const isQuiet = (d) => inRange(quietRange(), d);

// ---------- phone calls (Twilio, optional) ----------
const callsEnabled = () => Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM && ownerPhone());
const ownerPhone = () => (process.env.OWNER_PHONE || (process.env.OWNER_NUMBERS || '').split(',')[0] || '').replace(/[^\d+]/g, '').replace(/^(\d)/, '+$1');
const esc = (s) => String(s).replace(/[<>&"']/g, ' ');

async function placeCall(spoken) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const res = await fetch(`${BASE}/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: ownerPhone(), From: process.env.TWILIO_FROM, Twiml: `<Response><Say voice="alice">${esc(spoken)}</Say><Pause length="1"/><Say voice="alice">${esc(spoken)}</Say></Response>` }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`call failed (${res.status}) ${String(j.message || '').slice(0, 100)}`);
  return j.sid || true;
}
const callsToday = () => db.prepare('SELECT COUNT(*) n FROM alerts WHERE called_at > ?').get(Date.now() - 86_400_000).n;
const lastCallAt = () => db.prepare('SELECT MAX(called_at) t FROM alerts').get().t || 0;

// ---------- raising and delivering ----------
// spoken: generic sentence for a call; detail: extra words only spoken when CALL_SPEAK_DETAILS is on.
function raise({ key, kind, text, urgent = false, spoken = 'You have an urgent alert on WhatsApp. Please check your messages.', detail = '', footer = true }) {
  const r = db.prepare('INSERT OR IGNORE INTO alerts (akey, kind, text, spoken, urgent, footer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(key, kind, text, SPEAK_DETAILS && detail ? `${spoken} ${detail}` : spoken, urgent ? 1 : 0, footer ? 1 : 0, Date.now());
  return r.changes > 0;
}

const ack = () => db.prepare('UPDATE alerts SET acked_at = ? WHERE acked_at IS NULL AND resolved_at IS NULL').run(Date.now()).changes;

async function deliver() {
  const now = Date.now();
  db.prepare('UPDATE alerts SET resolved_at = ? WHERE resolved_at IS NULL AND created_at < ?').run(now, now - 24 * 3_600_000); // stale after a day
  const open = db.prepare('SELECT * FROM alerts WHERE acked_at IS NULL AND resolved_at IS NULL ORDER BY id').all();
  const quiet = isQuiet();
  for (const a of open) {
    if (!a.texted_at) {
      if (quiet && !a.urgent) continue;                                           // normal alerts wait for the end of quiet hours
      const sentHour = db.prepare('SELECT COUNT(*) n FROM alerts WHERE texted_at > ?').get(now - 3_600_000).n;
      if (sentHour >= maxTextsPerHour()) {                                         // flood guard: one summary line, the rest wait for /alerts
        if (now - Number(db.getKv('alert_flood_notice') || 0) > 3_600_000) {
          db.setKv('alert_flood_notice', now);
          await deps.send(`⚠️ Several alerts are waiting (more than ${maxTextsPerHour()} this hour). Send /alerts to see them.`).catch(() => {});
        }
        continue;
      }
      await deps.send(`${a.urgent ? '🚨' : '🔔'} ${a.text}${a.footer ? '\n(reply anything to acknowledge)' : ''}`).then(() => {
        db.prepare('UPDATE alerts SET texted_at = ? WHERE id = ?').run(Date.now(), a.id);
      }).catch((e) => console.warn('[alerts] send failed:', e.message));
      continue;
    }
    // Urgent and still unacknowledged: escalate to a call (once per alert).
    if (a.urgent && !a.called_at && now - a.texted_at >= ESCALATE_MIN * 60_000) {
      if (!callsEnabled() || (quiet && !CALL_IN_QUIET) || callsToday() >= CALL_DAILY_LIMIT || now - lastCallAt() < CALL_MIN_GAP_MIN * 60_000) continue;
      db.prepare('UPDATE alerts SET called_at = ? WHERE id = ?').run(now, a.id);   // mark first: never retry-loop a failing call
      try {
        await placeCall(a.spoken || 'You have an urgent alert on WhatsApp.');
        await deps.send('📞 Calling you about the alert above.').catch(() => {});
      } catch (e) {
        console.warn('[alerts] call failed:', e.message);
        await deps.send(`📞 I tried to call you but it failed (${e.message.slice(0, 80)}).`).catch(() => {});
      }
    }
  }
}

// ---------- scanners ----------
const mins = (ms) => Math.max(1, Math.round(ms / 60_000));
const short = (t, n = 80) => String(t).replace(/\s+/g, ' ').slice(0, n);
const isVip = (phone, name) => {
  const p = digits(phone);
  return Boolean((p && db.prepare('SELECT 1 FROM vips WHERE phone = ? OR (length(?) >= 7 AND substr(phone, -9) = substr(?, -9))').get(p, p, p))
    || (name && db.prepare('SELECT 1 FROM vips WHERE lower(name) = lower(?)').get(name)));
};

function scanMessages() {
  const now = Date.now();
  const rows = db.prepare('SELECT chat_id, chat_name, phone, from_me, ts, text, source FROM inbox_messages WHERE is_group = 0 AND ts > ? ORDER BY ts').all(now - 6 * 3_600_000);
  const byChat = new Map();
  for (const r of rows) (byChat.get(r.chat_id) || byChat.set(r.chat_id, []).get(r.chat_id)).push(r);
  for (const list of byChat.values()) {
    const incoming = list.filter((r) => !r.from_me);
    const last = incoming[incoming.length - 1];
    if (!last) continue;
    if (list.some((r) => r.from_me && (r.source === 'personal' || r.source === 'bot-owner') && r.ts > last.ts)) continue;   // you answered (phone, or via the bot)
    const waited = now - last.ts;
    const burst = incoming.filter((r) => r.ts > last.ts - 10 * 60_000).length >= 3;
    const word = incoming.slice(-3).some((r) => KEYWORDS.test(r.text));
    const vip = isVip(last.phone, last.chat_name);
    const why = word ? 'urgent wording' : vip ? 'VIP' : burst ? 'several messages in a row' : '';
    if (!why) continue;
    if (!((word && waited >= 2 * 60_000) || (vip && waited >= VIP_WAIT_MIN * 60_000) || (burst && waited >= 60_000))) continue;
    raise({
      key: `msg:${last.chat_id}:${last.ts}`, kind: 'message', urgent: true,
      text: `*${last.chat_name}* is waiting for you (${mins(waited)} min, ${why}): "${short(last.text)}"`,
      spoken: 'You have an urgent message on WhatsApp.', detail: `It is from ${last.chat_name}.`,
    });
  }
}

// call.missed / call.received events from the personal session (Baileys reports missed calls reliably; whatsapp-web.js may not)
function recordCall(event) {
  const d = event.data || {};
  if (event.event !== 'call.missed') return false;
  const phone = digits(d.senderPhone) || digits(String(d.from || d.chatId || '').split('@')[0]);
  const name = db.prepare('SELECT chat_name FROM inbox_messages WHERE (phone = ? AND ? != \'\') OR chat_id = ? LIMIT 1').get(phone, phone, String(d.chatId || d.from || ''))?.chat_name
    || d.contact?.name || d.contact?.pushName || (phone ? `+${phone}` : 'someone');
  return raise({
    key: `call:${d.callId || d.id || phone}:${Math.floor(Date.now() / 60_000)}`, kind: 'call', urgent: true,
    text: `Missed ${d.isVideo || d.video ? 'video ' : ''}call from *${name}*`, spoken: 'You missed a call on WhatsApp.', detail: `It was from ${name}.`,
  });
}

let calCache = { at: 0, events: [] };
async function scanMeetings(forceRefresh) {
  if (!deps.meetingsOn()) return;
  if (forceRefresh || Date.now() - calCache.at > INTERVAL_MS) {
    try { calCache = { at: Date.now(), events: await deps.meetings(30, 3) }; } catch (e) { console.warn('[alerts] calendar:', e.message); return; }
  }
  const now = Date.now();
  for (const ev of calCache.events) {
    const to = (ev.startMs - now) / 60_000;
    const where = ev.link ? `\n${ev.link}` : '';
    if (to <= 10 && to > 2) raise({ key: `meet10:${ev.id}:${ev.startMs}`, kind: 'meeting', text: `📅 "${ev.title}" starts in ${Math.ceil(to)} min${where}`, spoken: 'You have a meeting starting soon.', detail: ev.title });
    if (to <= 2 && to > -3) raise({ key: `meet2:${ev.id}:${ev.startMs}`, kind: 'meeting', urgent: true, text: `"${ev.title}" is ${to > 0 ? `starting in ${Math.ceil(to)} min` : 'starting now'}! Join now.${where}`, spoken: 'Your meeting is starting now. Please join.', detail: ev.title });
  }
}

function nudgePending() {
  if (isQuiet() || !inRange(process.env.ALERT_NUDGE_WINDOW ?? '08:00-21:00')) return;
  if (Date.now() - Number(db.getKv('pending_nudge_at') || 0) < Number(process.env.ALERT_PENDING_EVERY_H || 4) * 3_600_000) return;
  const { items, sawOwnReplies } = inbox.pending(Number(process.env.PENDING_NUDGE_AFTER_MIN || 120));
  if (!items.length || !sawOwnReplies) return;
  db.setKv('pending_nudge_at', Date.now());
  raise({
    key: `pending:${Math.floor(Date.now() / 3_600_000)}`, kind: 'pending',
    text: `${items.length} chat${items.length === 1 ? ' is' : 's are'} waiting for your reply: ${items.slice(0, 4).map((i) => i.name).join(', ')}${items.length > 4 ? '...' : ''}. /pending`, footer: false,
  });
}

// ---------- the routine ----------
let running = false;
async function tick({ suggestions } = {}) {
  if (running) return;
  running = true;
  try {
    if (Date.now() - Number(db.getKv('watch_last_scan') || 0) >= INTERVAL_MS) {
      db.setKv('watch_last_scan', Date.now());
      await scanMeetings(true);
      scanMessages();
      nudgePending();
      if (suggestions) for (const s of suggestions()) raise({ ...s, kind: 'suggest', footer: false });
    } else await scanMeetings(false);
    await deliver();
  } catch (e) { console.error('[alerts]', e.message); } finally { running = false; }
}

// /watch now: run the full check immediately and report how many new alerts it raised.
async function scanNow(opts) {
  const before = db.prepare('SELECT COUNT(*) n FROM alerts').get().n;
  db.setKv('watch_last_scan', 0);
  running = false;
  await tick(opts);
  return db.prepare('SELECT COUNT(*) n FROM alerts').get().n - before;
}

// ---------- owner commands ----------
function list() {
  const open = db.prepare('SELECT * FROM alerts WHERE acked_at IS NULL AND resolved_at IS NULL ORDER BY id').all();
  const recent = db.prepare('SELECT * FROM alerts WHERE acked_at IS NOT NULL AND created_at > ? ORDER BY id DESC LIMIT 5').all(Date.now() - 24 * 3_600_000);
  const line = (a) => `- ${a.urgent ? '🚨' : '🔔'} ${a.text.split('\n')[0].slice(0, 110)}${a.called_at ? ' (called)' : a.texted_at ? '' : ' (waiting to send)'}`;
  return (open.length ? `*Open alerts* (${open.length})\n${open.map(line).join('\n')}\nReply anything (or /ack) to acknowledge.` : 'No open alerts.')
    + (recent.length ? `\n\n*Acknowledged recently*\n${recent.map(line).join('\n')}` : '');
}

function status() {
  const last = Number(db.getKv('watch_last_scan') || 0);
  const vips = db.prepare('SELECT COUNT(*) n FROM vips').get().n;
  return `*Watch*\nChecks every ${INTERVAL_MS / 60_000} min (last: ${last ? new Date(last).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : 'not yet'}).\n`
    + `Watching: online meetings${deps.meetingsOn() ? '' : ' (calendar not connected)'}, urgent wording, VIPs (${vips}), missed calls, repeated pings, chats waiting 2h+.\n`
    + `Quiet hours: ${quietRange() || 'none'} (normal alerts wait; calls are ${CALL_IN_QUIET ? 'allowed' : 'suppressed'}).\n`
    + `Phone calls: ${callsEnabled() ? `on, ${callsToday()}/${CALL_DAILY_LIMIT} today, escalate after ${ESCALATE_MIN} min unacknowledged${SPEAK_DETAILS ? '' : ', generic wording'}` : 'off (no Twilio credentials, so urgent alerts escalate by text only)'}.\n`
    + `/alerts /ack /vip /callme`;
}

async function callTest() {
  if (!callsEnabled()) return 'Phone calls are not set up. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM to .env (see README), then rebuild.';
  if (callsToday() >= CALL_DAILY_LIMIT) return `Call limit reached (${CALL_DAILY_LIMIT} per day).`;
  try { await placeCall('This is a test call from your assistant. Everything is working.'); return `📞 Calling ${ownerPhone().slice(0, 4)}•••${ownerPhone().slice(-3)} now.`; }
  catch (e) { return `The test call failed: ${e.message.slice(0, 120)}`; }
}

// /vip [list | add <name or number> | remove <name or number>]
function vip(arg) {
  const [cmd, ...rest] = arg.trim().split(/\s+/);
  const q = rest.join(' ').trim();
  if (!cmd || cmd === 'list') {
    const v = db.prepare('SELECT * FROM vips ORDER BY name').all();
    return v.length ? `*VIPs* (an unanswered message from them alerts you after ${VIP_WAIT_MIN} min)\n${v.map((x) => `- ${x.name || '+' + x.phone}`).join('\n')}\n/vip add <name or number> | /vip remove <name>` : 'No VIPs yet. /vip add <name or number>';
  }
  if (!['add', 'remove'].includes(cmd) || !q) return 'Use /vip add <name or number>, /vip remove <name or number> or /vip list.';
  if (cmd === 'remove') {
    const r = db.prepare('DELETE FROM vips WHERE lower(name) LIKE ? OR phone LIKE ?').run(`%${q.toLowerCase()}%`, `%${digits(q) || 'x'}`);
    return r.changes ? `Removed ${r.changes}.` : `No VIP matches "${q}".`;
  }
  let phone = digits(q).length >= 7 ? digits(q) : '';
  let name = phone ? '' : q;
  if (!phone) {
    const hits = db.prepare("SELECT DISTINCT phone, chat_name FROM inbox_messages WHERE is_group = 0 AND phone IS NOT NULL AND phone != '' AND lower(chat_name) LIKE ? LIMIT 6").all(`%${q.toLowerCase()}%`);
    const uniq = [...new Map(hits.map((h) => [h.phone, h])).values()];
    if (uniq.length > 1) return `Several people match "${q}" (${uniq.map((u) => u.chat_name).join(', ')}). Use the number, e.g. /vip add 0771234567.`;
    if (uniq.length === 1) { phone = uniq[0].phone; name = uniq[0].chat_name; }
  } else name = db.prepare('SELECT chat_name FROM inbox_messages WHERE phone = ? LIMIT 1').get(phone)?.chat_name || '';
  if (!phone && !name) return 'Tell me a name or number.';
  db.prepare('INSERT INTO vips (phone, name) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET name = excluded.name').run(phone || `name:${name.toLowerCase()}`, name);
  return `⭐ ${name || '+' + phone} is a VIP now.${phone ? '' : ' (matched by name only; a number is more reliable)'}`;
}

module.exports = { init, tick, scanNow, raise, ack, list, status, callTest, vip, recordCall, isQuiet, callsEnabled, placeCall, deliver, scanMessages, scanMeetings };
