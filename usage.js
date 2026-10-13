// AI usage log (SQLite) and reports for /usage and the daily spend guard.
const db = require('./db');

const TZ = process.env.TZ || 'Asia/Colombo';
const DAILY_LIMIT = Number(process.env.DAILY_SPEND_LIMIT_USD ?? 0.5); // 0 disables the guard

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,           -- epoch ms
    turn TEXT,                     -- groups the calls made for one owner message
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_tokens INTEGER,
    cost REAL                      -- USD, from OpenRouter usage data; NULL when unknown
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_ts ON ai_usage(ts);
`);

const ins = db.prepare('INSERT INTO ai_usage (ts, turn, provider, model, input_tokens, output_tokens, cached_tokens, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const since = db.prepare('SELECT * FROM ai_usage WHERE ts >= ? ORDER BY ts');

const record = ({ turn, provider, model, input, output, cached, cost }) =>
  ins.run(Date.now(), turn ?? null, provider, model, input ?? null, output ?? null, cached ?? null, cost ?? null);

const dayOf = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD in local time
const today = () => dayOf(Date.now());

function spentToday() {
  const t = today();
  return since.all(Date.now() - 36 * 3_600_000).filter((r) => dayOf(r.ts) === t).reduce((s, r) => s + (r.cost || 0), 0);
}
const limit = () => DAILY_LIMIT;
const overLimit = () => DAILY_LIMIT > 0 && spentToday() >= DAILY_LIMIT;

function weekStart() { // Monday of the current local week, YYYY-MM-DD
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const usd = (n) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

function summarize(rows) {
  const turns = new Set(rows.map((r) => r.turn).filter(Boolean));
  const tokens = rows.reduce((s, r) => s + (r.input_tokens || 0) + (r.output_tokens || 0), 0);
  const cost = rows.reduce((s, r) => s + (r.cost || 0), 0);
  const unknown = rows.some((r) => r.cost == null);
  return `${turns.size || rows.length} message${(turns.size || rows.length) === 1 ? '' : 's'} · ${k(tokens)} tokens · ${usd(cost)}${unknown ? '+' : ''}`;
}

function report() {
  const t = today();
  const monthStart = `${t.slice(0, 7)}-01`;
  const rows = since.all(Date.now() - 62 * 86_400_000).filter((r) => dayOf(r.ts) >= monthStart || dayOf(r.ts) >= weekStart());
  const inRange = (from) => rows.filter((r) => dayOf(r.ts) >= from);
  const month = inRange(monthStart);
  const byModel = new Map();
  for (const r of month) {
    const m = byModel.get(r.model) || { calls: 0, cost: 0 };
    m.calls++; m.cost += r.cost || 0;
    byModel.set(r.model, m);
  }
  const lines = ['*AI usage*',
    `Today: ${summarize(inRange(t))}`,
    `This week: ${summarize(inRange(weekStart()))}`,
    `This month: ${summarize(month)}`];
  if (byModel.size) lines.push('', '*Models this month*', ...[...byModel].sort((a, b) => b[1].calls - a[1].calls).map(([m, v]) => `- ${m}: ${v.calls} call${v.calls === 1 ? '' : 's'}, ${usd(v.cost)}`));
  if (DAILY_LIMIT > 0) lines.push('', `Daily limit ${usd(DAILY_LIMIT)}: ${usd(spentToday())} used today.`);
  if (rows.some((r) => r.cost == null)) lines.push('(+ means some calls had no cost data, e.g. direct Gemini.)');
  return lines.join('\n');
}

module.exports = { record, spentToday, overLimit, limit, report, today };
