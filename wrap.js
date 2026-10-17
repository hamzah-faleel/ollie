// Evening wrap-up at WRAP_TIME (default 21:00) and birthday-eve reminders. Rule-based: no AI, no outside-people text.
// The birthday reminder only SUGGESTS drafting a message; sending always goes through outbox.js and a typed yes.
const db = require('./db');
const { files } = require('./vault');
const calendar = require('./calendar');
const weather = require('./weather');
const tasks = require('./tasks');
const contacts = require('./contacts');
const inbox = require('./inbox');
const alerts = require('./alerts');

const TZ = process.env.TZ || 'Asia/Colombo';
const wrapTime = () => (process.env.WRAP_TIME ?? '21:00').trim();          // HH:MM, empty disables
const birthdayTime = () => (process.env.BIRTHDAY_TIME ?? '21:00').trim();  // only used when the wrap-up is disabled
const parseHM = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const hm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const localDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const minutesNow = (d = new Date()) => { const [h, m] = d.toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }).split(':').map(Number); return h * 60 + m; };

// Pure: is a once-a-day job due? Sent from the due time up to 3h late, never twice a day.
function isDue(nowMin, dueMin, lastDay, today) {
  if (dueMin === null) return false;
  const since = nowMin - dueMin;
  return since >= 0 && since <= 180 && lastDay !== today;
}

async function section(title, fn) {
  try {
    const lines = await fn();
    return lines ? `\n\n*${title}*\n${lines}` : '';
  } catch (e) {
    return `\n\n*${title}*\n- Error: ${e.message}`;
  }
}

const bdayKey = (b) => `bday_eve:${b.name}:${b.year}`;
function birthdayLines(list) {
  return list.map((b) => `- ${b.name}${b.turning ? ` turns ${b.turning}` : ''} has a birthday tomorrow 🎂 - say "message ${b.name.split(' ')[0]} happy birthday" and I'll draft it (nothing is sent until you say yes)`).join('\n');
}
const newBirthdays = (list) => list.filter((b) => db.getKv(bdayKey(b)) === null);

// Notes whose frontmatter says "created: <today>" (Private/ is skipped by files.walk).
async function notesCreatedToday(day) {
  const fs = require('fs/promises');
  const out = [];
  for (const f of await files.walk()) {
    const head = (await fs.readFile(f, 'utf8').catch(() => '')).slice(0, 300);
    if (new RegExp(`^created:\\s*${day}`, 'm').test(head)) out.push(files.rel(f));
  }
  return out;
}

// scheduled: skip birthdays already announced; the caller marks them after a successful send.
async function build(chatId, { scheduled = false } = {}) {
  const today = localDay();
  const t0 = calendar.startOfDay(1), t1 = calendar.startOfDay(2);
  let bdays = [];
  const parts = await Promise.all([
    section('Done today', async () => { const d = await tasks.doneOn(today); return d.length ? d.slice(0, 8).map((x) => `- ✅ ${x}`).join('\n') + (d.length > 8 ? `\n- ...and ${d.length - 8} more` : '') : null; }),
    section('Still open', async () => {
      const open = await tasks.openTasks();
      return open.length ? open.slice(0, 5).map((t) => `- ${t.text}${t.due ? ` (${t.due < today ? 'overdue, ' : ''}due ${t.due === today ? 'today' : t.due})` : ''}`).join('\n') + (open.length > 5 ? `\n- ...and ${open.length - 5} more (/tasks)` : '') : null;
    }),
    section('Tomorrow', async () => {
      const lines = [];
      if (calendar.enabled()) {
        const { events } = await calendar.listEvents({ from: t0.toISOString(), to: t1.toISOString() });
        lines.push(...(events.length ? events.map((e) => `- ${e.all_day ? 'All day' : `${hm(e.start)}-${hm(e.end)}`} ${e.title}${e.location ? ` (${e.location})` : ''}`) : ['- Nothing on the calendar']));
      }
      const rs = db.pendingReminders(chatId).filter((r) => r.due_at >= t0.getTime() && r.due_at < t1.getTime());
      lines.push(...rs.map((r) => `- ⏰ ${hm(r.due_at)} ${r.text}`));
      try {
        const d = (await weather.forecast({ days: 2 })).days[1];
        if (d) lines.push(`- Weather: ${d.conditions}, ${d.low_c}-${d.high_c}°C, ${d.rain_chance_pct}% rain${d.rain_chance_pct >= 50 ? ' - take an umbrella ☔' : ''}`);
      } catch (e) { lines.push(`- Weather unavailable: ${e.message}`); }
      return lines.length ? lines.join('\n') : null;
    }),
    section('Birthdays tomorrow', async () => {
      const all = await contacts.birthdaysTomorrow();
      bdays = scheduled ? newBirthdays(all) : all;
      return bdays.length ? birthdayLines(bdays) : null;
    }),
    process.env.PERSONAL_SESSION_ID ? section('Waiting for your reply', async () => {
      const { items } = inbox.pending();
      return items.length ? items.slice(0, 5).map((i) => `- ${i.name}${i.count > 1 ? ` (${i.count})` : ''}`).join('\n') + (items.length > 5 ? `\n- ...and ${items.length - 5} more (/pending)` : '') : null;
    }) : '',
    section('Notes today', async () => { const n = await notesCreatedToday(today); return n.length ? n.slice(0, 6).map((x) => `- ${x}`).join('\n') : null; }),
  ]);
  return { text: `Evening wrap-up 🌙${parts.join('')}`, bdays };
}

const markBirthdays = (list) => { for (const b of list) db.setKv(bdayKey(b), localDay()); };

// Called every minute. send(text, chatId) throws on failure so the job is retried on the next tick.
async function tick(send, { target } = {}) {
  try {
  const tg = target || JSON.parse(db.getKv('owner_target') || 'null');
  if (!tg) return;
  const now = new Date(), today = localDay(now), nowMin = minutesNow(now);
  if (alerts.isQuiet(now)) return;
  const wrapOn = parseHM(wrapTime()) !== null;
    if (wrapOn) {
      if (!isDue(nowMin, parseHM(wrapTime()), db.getKv('last_wrap'), today)) return;
      const { text, bdays } = await build(tg.chatId, { scheduled: true });
      await send(text, tg);
      db.setKv('last_wrap', today); markBirthdays(bdays);
      console.log('[wrap] sent');
    } else if (isDue(nowMin, parseHM(birthdayTime()), db.getKv('last_bday_eve'), today)) { // standalone, only when there is no wrap-up
      const list = newBirthdays(await contacts.birthdaysTomorrow());
      if (list.length) { await send(`*Birthdays tomorrow* 🎂\n${birthdayLines(list)}`, tg); markBirthdays(list); }
      db.setKv('last_bday_eve', today);
      if (list.length) console.log('[wrap] birthday reminder sent');
    }
  } catch (e) {
    console.error('[wrap] failed, will retry:', e.message);
  }
}

module.exports = { build, tick, isDue, birthdayLines, notesCreatedToday };
