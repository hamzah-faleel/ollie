// Prints one JSON object with aggregate bot status for the server dashboard (run via `docker exec wa-bot node status.js`).
// Privacy: counts, timestamps, costs, model names and booleans only. NEVER names, phone numbers, message text or note contents.
// Opens bot.db read-only, so it cannot change anything.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const TZ = process.env.TZ || 'Asia/Colombo';
const DB_PATH = process.env.DB_PATH || '/data/bot.db';
const VAULT = path.resolve(process.env.VAULT_DIR || '/data/vault');
const out = { generated: Date.now(), tz: TZ };
const db = new DatabaseSync(DB_PATH, { readOnly: true });

const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) || {}; } catch { return {}; } };
const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch { return []; } };
const kv = (k) => one('SELECT value FROM kv WHERE key = ?', k).value ?? null;
const section = (name, fn) => { try { out[name] = fn(); } catch (e) { out[name] = { error: String(e.message).slice(0, 120) }; } };

const dayOf = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
const today = dayOf(Date.now());
const monthStart = `${today.slice(0, 7)}-01`;
const weekStart = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();

section('ai', () => {
  const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
  const main = kv('model_main') || process.env.OPENROUTER_MODEL || 'openai/gpt-6-luna';
  const limit = Number(process.env.DAILY_SPEND_LIMIT_USD ?? 0.5);
  const rows = all('SELECT ts, turn, model, input_tokens i, output_tokens o, cached_tokens c, cost FROM ai_usage WHERE ts >= ?', Date.now() - 62 * 86_400_000);
  const bucket = (from) => {
    const r = rows.filter((x) => dayOf(x.ts) >= from);
    return { messages: new Set(r.map((x) => x.turn).filter(Boolean)).size, calls: r.length, tokens: r.reduce((s, x) => s + (x.i || 0) + (x.o || 0), 0), cached: r.reduce((s, x) => s + (x.c || 0), 0), cost: r.reduce((s, x) => s + (x.cost || 0), 0) };
  };
  const models = {};
  for (const r of rows.filter((x) => dayOf(x.ts) >= monthStart)) { const m = models[r.model] || (models[r.model] = { calls: 0, cost: 0 }); m.calls++; m.cost += r.cost || 0; }
  const spent = bucket(today).cost;
  return {
    provider, main: provider === 'openrouter' ? main : (process.env.GEMINI_MODEL || 'gemini'), overridden: Boolean(kv('model_main')),
    fallback: provider === 'openrouter' ? (process.env.OPENROUTER_FALLBACK_MODEL || 'google/gemini-3.1-flash-lite') : (process.env.GEMINI_FALLBACK_MODEL || null),
    dailyLimit: limit, spentToday: spent, guardActive: limit > 0 && spent >= limit,
    today: bucket(today), week: bucket(weekStart), month: bucket(monthStart),
    models: Object.entries(models).map(([model, v]) => ({ model, ...v })).sort((a, b) => b.calls - a.calls).slice(0, 8),
    lastCallAt: rows.length ? rows[rows.length - 1].ts : null,
    creditWarningAt: Number(kv('last_credit_warning') || 0) || null,
  };
});

section('activity', () => ({ lastOwnerMessageAt: Number(kv('last_owner_msg_at') || 0) || null, lastBriefingDay: kv('last_briefing') }));

section('inbox', () => {
  const s = one('SELECT COUNT(*) n, COUNT(DISTINCT chat_id) chats, SUM(seen = 0 AND from_me = 0) unseen, MIN(ts) oldest, MAX(ts) newest, MAX(stored_at) lastStored, SUM(stored_at > ?) last24h FROM inbox_messages', Date.now() - 86_400_000);
  return {
    configured: Boolean(process.env.PERSONAL_SESSION_ID), stored: s.n || 0, chats: s.chats || 0, unsummarized: s.unseen || 0,
    oldestAt: s.oldest || null, newestAt: s.newest || null, lastReceivedAt: s.lastStored || null, last24h: s.last24h || 0,
    retentionDays: Number(process.env.INBOX_RETENTION_DAYS || 30),
  };
});

section('memory', () => {
  const last = JSON.parse(kv('memory_last_run') || 'null');
  const chats = Object.fromEntries(all('SELECT status, COUNT(*) n FROM memory_chats GROUP BY status').map((r) => [r.status, r.n]));
  let notes = 0, newest = 0;
  try {
    const dir = path.join(VAULT, 'Private', 'People');
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) { notes++; newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs); }
  } catch { /* no notes yet */ }
  const waiting = one('SELECT COUNT(*) n FROM inbox_messages WHERE consolidated = 0 AND is_group = 0').n || 0;
  return {
    time: (process.env.MEMORY_TIME ?? '03:00').trim() || null, personalKeySet: Boolean(process.env.OPENWA_PERSONAL_KEY),
    waitingMessages: waiting, backfill: { done: chats.done || 0, pending: chats.pending || 0, skipped: chats.skip || 0 },
    privateNotes: notes, newestNoteAt: newest || null, lastRunDay: kv('last_memory_day'),
    lastRun: last && { at: last.at, created: last.created, updated: last.updated, rows: last.rows, backfilled: last.backfilled, errors: last.errors, rejected: last.rejected,
      budgetStop: last.budgetStop, limitStop: last.limitStop, creditStop: last.creditStop, left: last.left, pending: last.pending,
      historyError: last.backfillError ? String(last.backfillError).slice(0, 140) : null },
  };
});

section('other', () => {
  const rem = one("SELECT COUNT(*) n, MIN(due_at) next FROM reminders WHERE status = 'pending'");
  const o = one("SELECT SUM(status = 'sent' AND sent_at > ?) sent24h, SUM(status = 'draft') drafts FROM outbox", Date.now() - 86_400_000);
  const e = one('SELECT COUNT(*) chunks FROM note_chunks');
  const ix = one('SELECT COUNT(*) notes FROM note_index');
  let vaultNotes = 0;
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (f.name.startsWith('.') || (d === VAULT && f.name === 'Private')) continue; const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.md')) vaultNotes++; } };
  try { walk(VAULT); } catch { /* empty vault */ }
  return {
    remindersPending: rem.n || 0, nextReminderAt: rem.next || null, sentLast24h: o.sent24h || 0, draftsWaiting: o.drafts || 0,
    sendLimit: Number(process.env.SEND_DAILY_LIMIT || 10), vaultNotes, embeddedNotes: ix.notes || 0, embeddingChunks: e.chunks || 0,
    gitSync: Boolean(process.env.VAULT_GIT_REMOTE),
  };
});

process.stdout.write(JSON.stringify(out));
