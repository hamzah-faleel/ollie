// Daily purge of append-only bookkeeping tables (90 days). Does not touch inbox_messages (memory.js/inbox.js own that), kv or messages.
const db = require('./db');

const DAYS = Number(process.env.RETENTION_DAYS || 90);
const FINISHED = "status IN ('sent','cancelled','expired','failed')";
// [table, time column, extra condition]; times are epoch ms
const RULES = [
  ['alerts', 'created_at', ''],
  ['triage', 'at', ''],
  ['reply_check', 'at', ''],
  ['ai_usage', 'ts', ''],
  ['outbox', 'created_at', FINISHED],
  ['email_outbox', 'created_at', FINISHED],
  ['intake_invites', 'created_at', FINISHED],
];

function purge(now = Date.now()) {
  const cutoff = now - Math.max(DAYS, 90) * 86_400_000; // never less than 90 days (/usage needs ~62)
  const out = {};
  for (const [table, col, extra] of RULES) {
    try { out[table] = Number(db.prepare(`DELETE FROM ${table} WHERE ${col} < ? ${extra ? 'AND ' + extra : ''}`).run(cutoff).changes); }
    catch (e) { if (!/no such table/.test(e.message)) console.error(`[retention] ${table}:`, e.message); }
  }
  return out;
}

// Once a day (kv guard); safe to call often.
function tick(now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (db.getKv('last_retention') === day) return null;
  const r = purge(now);
  db.setKv('last_retention', day);
  const n = Object.values(r).reduce((a, b) => a + b, 0);
  if (n) console.log(`[retention] purged ${n} old rows`);
  return r;
}

module.exports = { purge, tick };
