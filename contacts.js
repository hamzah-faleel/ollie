// Contacts: one Markdown note per person in People/ (Obsidian-friendly, searchable like any note).
// Fields live in the frontmatter; free-form details go in the body. Also imports vCards (.vcf files or shared WhatsApp contacts).
const fs = require('fs/promises');
const path = require('path');
const { files } = require('./vault');

const TZ = process.env.TZ || 'Asia/Colombo';
const DIR = 'People';
const FIELDS = ['phone', 'email', 'relationship', 'company', 'birthday'];

// "1990-05-14", "19900514", "--05-14", "--0514" -> "1990-05-14" or "--05-14"; anything else -> null
function normBirthday(s) {
  const m = /^(?:(\d{4})-?|--)(\d{2})-?(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return y ? `${y}-${mo}-${d}` : `--${mo}-${d}`;
}

function parseNote(text) {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const fields = {};
  if (fm) for (const l of fm[1].split('\n')) { const i = l.indexOf(':'); if (i > 0) fields[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return { fields, body: fm ? text.slice(fm[0].length) : text };
}
// Known fields first, then any others already in the file (so hand-added frontmatter is never dropped).
const render = (name, fields, body) => {
  const keys = [...FIELDS, ...Object.keys(fields).filter((k) => !FIELDS.includes(k) && k !== 'type')];
  return `---\ntype: contact\n${keys.filter((k) => fields[k]).map((k) => `${k}: ${fields[k]}`).join('\n')}\n---\n${body.replace(/^\n+/, '')}`.replace(/\n*$/, '\n');
};

async function saveContact({ name, phone, email, relationship, company, birthday, notes }, { pull = true } = {}) {
  if (!name || !String(name).trim()) return { error: 'Need a name.' };
  if (birthday && !normBirthday(birthday)) return { error: 'birthday must be YYYY-MM-DD, or --MM-DD when the year is unknown.' };
  if (pull) await files.pull();
  const clean = files.slug(name);
  const file = files.safePath(path.join(DIR, `${clean}.md`));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const existing = await fs.readFile(file, 'utf8').catch(() => null);
  const { fields, body } = existing ? parseNote(existing) : { fields: {}, body: `# ${clean}\n` };
  const incoming = { phone, email, relationship, company, birthday: birthday && normBirthday(birthday) };
  for (const k of FIELDS) if (incoming[k]) fields[k] = String(incoming[k]).trim();
  const extra = notes ? `\n- ${files.today()}: ${String(notes).replace(/\s+/g, ' ').trim()}\n` : '';
  await fs.writeFile(file, render(clean, fields, body.replace(/\n*$/, '\n') + extra));
  files.schedulePush(`Contact: ${clean}`);
  return { status: existing ? 'updated' : 'created', name: clean };
}

async function allContacts() {
  const dir = files.safePath(DIR);
  const names = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.md'));
  return Promise.all(names.map(async (f) => {
    const { fields, body } = parseNote(await fs.readFile(path.join(dir, f), 'utf8'));
    return { name: f.slice(0, -3), ...fields, notes: body.replace(/^# .*\n+/, '').trim() };
  }));
}

// Digits without leading zeros, so a local "077…" query matches a stored "+9477…".
const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^0+/, '');

async function findContact({ query } = {}) {
  await files.pull();
  const all = await allContacts();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { total: all.length, names: all.map((c) => c.name).slice(0, 60) };
  const words = q.split(/\s+/);
  const score = (c) => {
    const hay = `${c.name} ${c.relationship || ''} ${c.company || ''} ${c.email || ''} ${c.notes}`.toLowerCase();
    const phone = digits(c.phone);
    return words.reduce((n, w) => n + (c.name.toLowerCase().includes(w) ? 3 : 0) + (hay.includes(w) ? 1 : 0)
      + (digits(w).length >= 4 && phone.includes(digits(w)) ? 3 : 0), 0);
  };
  const hits = all.map((c) => [score(c), c]).filter(([n]) => n > 0).sort((a, b) => b[0] - a[0]).slice(0, 5).map(([, c]) => ({ ...c, notes: c.notes.slice(0, 400) }));
  return hits.length ? { results: hits } : { results: [], note: `No contact matches "${query}".` };
}

// ---------- vCard import ----------
function parseVcards(text) {
  const unfolded = String(text).replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '');
  const cards = [];
  for (const block of unfolded.split(/BEGIN:VCARD/i).slice(1)) {
    const c = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).split(';')[0].replace(/^item\d+\./i, '').toUpperCase();
      const val = line.slice(i + 1).replace(/\\,/g, ',').replace(/\\n/gi, ' ').trim();
      if (!val) continue;
      if (key === 'FN') c.name = val;
      else if (key === 'N' && !c.name) c.name = val.split(';').filter(Boolean).reverse().join(' ');
      else if (key === 'TEL') c.phone ||= val.replace(/[^\d+]/g, '') || val; // first number wins
      else if (key === 'EMAIL') c.email ||= val;
      else if (key === 'ORG') c.company ||= val.replace(/;+/g, ' ').trim();
      else if (key === 'BDAY') c.birthday ||= normBirthday(val.slice(0, 10)) || normBirthday(val) || undefined;
      else if (key === 'NOTE') c.notes ||= val;
    }
    if (c.name) cards.push(c);
  }
  return cards;
}

async function importVcards(text) {
  const cards = parseVcards(text);
  if (!cards.length) return { imported: 0, names: [] };
  await files.pull();
  let n = 0;
  for (const c of cards) if (!(await saveContact(c, { pull: false })).error) n++;
  return { imported: n, names: cards.slice(0, 5).map((c) => c.name) };
}

// ---------- birthdays ----------
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
// When the birthday falls in year y as UTC ms. A Feb 29 birthday is kept on Feb 28 in non-leap years.
const celebrationUtc = (y, mo, d) => Date.UTC(y, mo - 1, mo === 2 && d === 29 && !isLeap(y) ? 28 : d);
const ymdUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
const todayParts = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ }).split('-').map(Number);

async function upcomingBirthdays(withinDays = 7) {
  const [y, m, d] = todayParts();
  const todayUtc = Date.UTC(y, m - 1, d);
  const out = [];
  for (const c of await allContacts()) {
    const b = /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(c.birthday || '');
    if (!b) continue;
    let next = celebrationUtc(y, Number(b[2]), Number(b[3]));
    if (next < todayUtc) next = celebrationUtc(y + 1, Number(b[2]), Number(b[3]));
    const inDays = Math.round((next - todayUtc) / 86_400_000);
    if (inDays <= withinDays) out.push({ name: c.name, inDays, turning: b[1] ? new Date(next).getUTCFullYear() - Number(b[1]) : null });
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}

// Pure: contacts (as from allContacts) whose birthday is celebrated on the given YYYY-MM-DD.
// Age is only given when the year is known and sensible; Feb 29 people are celebrated on Feb 28 in non-leap years.
function birthdaysOn(list, ymd) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const out = [];
  for (const c of list) {
    const b = /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(c.birthday || '');
    if (!b || ymdUtc(celebrationUtc(y, Number(b[2]), Number(b[3]))) !== ymd) continue;
    const age = b[1] ? y - Number(b[1]) : null;
    out.push({ name: c.name, turning: age && age > 0 && age < 130 ? age : null, year: y });
  }
  return out;
}

// Birthdays tomorrow (owner's timezone), for the evening-before reminder.
async function birthdaysTomorrow() {
  const [y, m, d] = todayParts();
  return birthdaysOn(await allContacts(), ymdUtc(Date.UTC(y, m - 1, d + 1)));
}

module.exports = { saveContact, findContact, allContacts, importVcards, upcomingBirthdays, birthdaysOn, birthdaysTomorrow };
