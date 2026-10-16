// Pseudonymization: personal data is replaced with placeholders before any text goes to an LLM, and put back afterwards.
// ai.js is the only caller: reply() (system prompt, history, text attachments, tool results; tool-call arguments and the final
// reply are restored), untrusted() and converse() (prompt in, answer restored).
//
// Placeholders are stable tokens ([PERSON_1], [PERSON_1_FIRST], [PHONE_2], [EMAIL_1], [ADDRESS_1], [ID_1]), not fake persona names:
// - restoring is exact: a token cannot collide with a real word or a real contact, while a fake "Nimal Silva" could be a real person
//   in the vault or appear in the text already, and models inflect or shorten fake names ("Nim", "Silvas") so they no longer map back;
// - the model sees that a value is hidden, so it does not invent facts about a made-up persona, and copies the token into tool args;
// - a first or last name alone gets a token tied to the full name ([PERSON_1_FIRST]), so the model knows they are the same person.
// The mapping lives only in the Session object of one AI request (one owner turn incl. its tool loop). It is never stored or logged.
// Numbering is by order of appearance, so the system prompt (processed first) gets the same tokens every time and stays cacheable.
//
// Not covered (documented): images and PDFs (sent as they are), names nobody saved anywhere (only known names are matched,
// plus every phone/email/ID pattern), and the direct Gemini embeddings/TTS calls (not chat completions).
// On/off: /pseudo on|off (kv 'pseudonymize'), default from env PSEUDONYMIZE (default on).
const fs = require('fs/promises');

const HINT = 'Privacy: personal details are replaced by placeholders like [PERSON_1], [PERSON_1_FIRST], [PHONE_1], [EMAIL_1], [ADDRESS_1], [ID_1]. Treat them as the real values: copy them exactly (also in tool arguments and in messages you draft), never guess what they stand for, never remove the brackets.';

// Words that are also given names (or titles/kinship words): never matched as a name part on their own, and a one-word
// contact with such a name only matches when written with a capital ("Will" yes, "will" no).
const COMMON = new Set(`will may june april august march mark bill hope joy grace faith rose lily ivy sunny summer autumn winter dawn eve art ray
sky star max pat rob jack frank earl chase hunter rich guy don dean drew gene glen lance miles norm page paige penny rod sue wade dash kit
angel crystal amber jade ruby pearl honey holly iris violet daisy heather ginger olive brook cliff dale forest river stone storm rain love
king prince young white black brown green gray grey long short little small hall wood hill bell price cook baker major
monday tuesday wednesday thursday friday saturday sunday january february september october november december
mr mrs ms miss dr prof sir madam rev the and of de da del van von bin al la le
test owner admin bot home work office team group family friend friends mum mom dad mother father sister brother son daughter
uncle aunty aunt akka aiya ayya malli nangi amma ammi thaththa appa achchi seeya machan bro sis baby babe dear me you unknown status`.split(/\s+/));

const L = '\\p{L}\\p{N}_';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const digits = (s) => String(s).replace(/\D/g, '');
const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

// ---------- pattern detectors (order matters: WhatsApp ids, emails, phones, ids, addresses, then names) ----------
const STREET = ['Road', 'Rd', 'Street', 'St', 'Lane', 'Ln', 'Mawatha', 'Mw', 'Avenue', 'Ave', 'Place', 'Pl', 'Drive', 'Gardens', 'Terrace',
  'Crescent', 'Way', 'Close', 'Boulevard', 'Blvd', 'Highway', 'Square', 'Court', 'Passage', 'Watta', 'Para', 'Veediya']
  .map((w) => `[${w[0]}${w[0].toLowerCase()}]${w.slice(1)}`).join('|');
const luhn = (n) => { let s = 0; for (let i = 0; i < n.length; i++) { let d = Number(n[n.length - 1 - i]); if (i % 2) { d *= 2; if (d > 9) d -= 9; } s += d; } return s % 10 === 0; };

const DETECTORS = [
  // WhatsApp chat ids: 94771234567@c.us / 1234567890@lid -> only the number part
  { kind: 'PHONE', re: /(?<![\w.+-])\d{8,15}(?=@(?:c\.us|s\.whatsapp\.net|lid)\b)/g, key: (m) => digits(m).slice(-9) },
  { kind: 'EMAIL', re: /(?<![\w.+-])[\w.+-]*\w@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, key: (m) => m.toLowerCase() },
  // +94 77 123 4567, +1 (555) 123-4567 (8-15 digits)
  { kind: 'PHONE', re: /(?<![\w+])\+\d[\d ().-]{6,20}\d(?![\w])/g, ok: (m) => { const n = digits(m).length; return n >= 8 && n <= 15; }, key: (m) => digits(m).slice(-9) },
  // 077 123 4567, 011-234-5678, 0771234567
  { kind: 'PHONE', re: /(?<![\w.:/+-])0\d{2}[ -]?\d{3}[ -]?\d{4}(?![\w])/g, key: (m) => digits(m).slice(-9) },
  // 94771234567 without the plus
  { kind: 'PHONE', re: /(?<![\w.+-])94\d{9}(?![\w])/g, key: (m) => digits(m).slice(-9) },
  // card numbers (grouped, or 15-16 digits passing Luhn)
  { kind: 'ID', re: /(?<![\w])(?:\d{4}[ -]){3}\d{4}(?![\w])|(?<![\w])[3-6]\d{14,15}(?![\w])/g, ok: (m) => luhn(digits(m)), key: digits },
  // Sri Lankan NIC (old 9 digits + V/X, new 12 digits), passports, IBANs
  { kind: 'ID', re: /(?<![\w])\d{9}[VvXx](?![\w])|(?<![\w])(?:19|20)\d{10}(?![\w])|(?<![\w])[A-Z]{1,2}\d{7,8}(?![\w])|(?<![\w])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?![\w])/g, key: (m) => m.replace(/\s/g, '').toUpperCase() },
  // "account no: 123-456789", "NIC 199012345678", "passport #N1234567": only the value is replaced
  { kind: 'ID', re: /(?<=\b(?:a\/c|acc(?:ount)?|nic|passport|licen[cs]e|policy|id|iban|customer|member)\.?\s*(?:no\.?|number|num|#)?\s*[:#-]?\s*)(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{4,24}(?![\w])/gi, key: (m) => m.toUpperCase() },
  // "No. 12/3, Flower Road, Colombo 7", "221B Baker Street"
  { kind: 'ADDRESS', re: new RegExp(`(?<![\\p{L}\\p{N}])(?:No\\.?\\s*)?\\d{1,5}[A-Za-z]?(?:\\/\\d{1,4}[A-Za-z]?)?,?\\s+(?:\\p{Lu}[\\p{L}'.-]*\\s+){0,4}(?:${STREET})(?![\\p{L}])\\.?(?:,\\s*\\p{Lu}[\\p{L}-]+(?: \\p{Lu}[\\p{L}-]+)?(?: \\d{1,5})?)?`, 'gu'), key: norm },
];

const TOKEN = /\[?\b(PERSON|PHONE|EMAIL|ADDRESS|ID)_(\d+)((?:_(?:FIRST|LAST|PART\d+))?)\b\]?/gi;

// ---------- the name registry (built from known names; pure, so it is testable without a vault) ----------
// names: array of strings ("Kamal Perera", "Amma"). Returns { re, entries: Map(lower surface -> entry) } or null.
function buildRegistry(names) {
  const people = [];
  const seen = new Set();
  for (const raw of names || []) {
    const full = String(raw || '').replace(/\s+/g, ' ').trim();
    if (full.length < 3 || /@|^\+?[\d\s().-]+$/.test(full) || /^\[/.test(full) || seen.has(full.toLowerCase())) continue;
    seen.add(full.toLowerCase());
    people.push(full);
  }
  const entries = new Map();
  const partOwners = new Map(); // lower part -> Set of person index
  people.forEach((full, pi) => {
    const parts = full.split(' ').filter((p) => /^\p{L}[\p{L}'.-]*$/u.test(p));
    const oneWord = full.split(' ').length === 1;
    entries.set(full.toLowerCase(), { kind: 'full', person: pi, canon: full, caseSensitive: oneWord && COMMON.has(full.toLowerCase()) });
    if (oneWord) return;
    parts.forEach((p, k) => {
      const lp = p.toLowerCase().replace(/[.']+$/, '');
      if (lp.length < 3 || COMMON.has(lp)) return;
      if (!partOwners.has(lp)) partOwners.set(lp, { set: new Set(), canon: p.replace(/[.']+$/, ''), suffix: new Map() });
      const o = partOwners.get(lp);
      o.set.add(pi);
      o.suffix.set(pi, k === 0 ? 'FIRST' : k === parts.length - 1 ? 'LAST' : `PART${k + 1}`);
    });
  });
  for (const [lp, o] of partOwners) {
    if (entries.has(lp)) continue; // a one-word contact with that name wins
    entries.set(lp, o.set.size === 1
      ? { kind: 'part', person: [...o.set][0], suffix: o.suffix.get([...o.set][0]), canon: o.canon }
      : { kind: 'shared', canon: o.canon });
  }
  if (!entries.size) return { re: null, entries, people };
  const alts = [...entries.keys()].sort((a, b) => b.length - a.length).map((s) => s.split(' ').map(esc).join('\\s+'));
  return { re: new RegExp(`(?<![${L}])(?:${alts.join('|')})(?![${L}])`, 'giu'), entries, people };
}

const capitalized = (s) => /^\p{Lu}/u.test(s);

class Session {
  constructor(registry) {
    this.reg = registry || buildRegistry([]);
    this.byKey = new Map();     // `${kind}:${key}` -> token
    this.back = new Map();      // token (uppercase) -> real value
    this.count = {};            // kind -> n
    this.personNo = new Map();  // person index / shared surface -> n
  }
  _token(kind, key, real) {
    const k = `${kind}:${key}`;
    let t = this.byKey.get(k);
    if (!t) {
      this.count[kind] = (this.count[kind] || 0) + 1;
      t = `[${kind}_${this.count[kind]}]`;
      this.byKey.set(k, t);
      this.back.set(t, real);
    }
    return t;
  }
  _person(id) {
    if (!this.personNo.has(id)) { this.count.PERSON = (this.count.PERSON || 0) + 1; this.personNo.set(id, this.count.PERSON); }
    return this.personNo.get(id);
  }
  _name(match) {
    const e = this.reg.entries.get(norm(match));
    if (!e || (e.caseSensitive && !capitalized(match))) return match;
    let t;
    if (e.kind === 'full') { t = `[PERSON_${this._person(e.person)}]`; }
    else if (e.kind === 'part') { t = `[PERSON_${this._person(e.person)}_${e.suffix}]`; }
    else { t = `[PERSON_${this._person(`shared:${norm(match)}`)}]`; }
    if (!this.back.has(t)) this.back.set(t, e.canon);
    return t;
  }
  // Text -> text with placeholders. Throws on bad input (callers fail closed).
  hide(text) {
    if (text == null) return text;
    let s = String(text);
    for (const d of DETECTORS) {
      s = s.replace(d.re, (m) => (d.ok && !d.ok(m)) || /^\[|\]$/.test(m) ? m : this._token(d.kind, d.key(m), m));
    }
    if (this.reg.re) s = s.replace(this.reg.re, (m) => this._name(m));
    return s;
  }
  // Placeholders -> real values. Unknown tokens stay as they are.
  show(text) {
    if (text == null) return text;
    return String(text).replace(TOKEN, (m, kind, n, suffix) => this.back.get(`[${kind.toUpperCase()}_${n}${suffix.toUpperCase()}]`) ?? m);
  }
  hideDeep(v) { return deep(v, (s) => this.hide(s)); }
  showDeep(v) { return deep(v, (s) => this.show(s)); }
  get size() { return this.back.size; }
}

function deep(v, fn, depth = 0) {
  if (depth > 20) throw new Error('pseudonym: value nested too deeply');
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => deep(x, fn, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, fn, depth + 1)]));
  return v;
}

// ---------- known names, read in code only (never shown to the model as a list) ----------
let vaultCache = { at: 0, names: [] };
const VAULT_TTL_MS = 60_000;

async function vaultNames() {
  if (Date.now() - vaultCache.at < VAULT_TTL_MS) return vaultCache.names;
  const { files } = require('./vault');
  const out = [];
  for (const f of await files.walkAll()) {
    const rel = files.rel(f).replace(/\\/g, '/');
    if (rel === 'Profile.md') {
      const t = await fs.readFile(f, 'utf8');
      const m = /^(?:name|full name)\s*:\s*(.+)$/im.exec(t) || /^-\s*(?:my )?(?:name|full name)\s*(?:is|:)\s*(.+)$/im.exec(t) || /\bmy name is ([\p{Lu}][\p{L}'-]*(?: [\p{Lu}][\p{L}'-]*){0,3})/u.exec(t);
      if (m) out.push(m[1].replace(/[.*_]+$/, '').trim());
      continue;
    }
    if (!/^(Private\/)?People\//i.test(rel)) continue;
    out.push(files.titleOf(f));
    if (/^Private\//i.test(rel)) { // hidden notes may be titled by phone number; their "# Name" heading is the name
      const h = /^# (.+)$/m.exec((await fs.readFile(f, 'utf8')).slice(0, 1500));
      if (h) out.push(h[1].trim());
    }
  }
  vaultCache = { at: Date.now(), names: out };
  return out;
}

// WhatsApp contact names the bot has seen (inbox, outbox, intake, VIPs). Tables that do not exist yet are skipped.
function dbNames() {
  const db = require('./db');
  const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  const out = [];
  const q = (table, sql) => { if (have.has(table)) for (const r of db.prepare(sql).all()) out.push(r.n); };
  q('inbox_messages', "SELECT DISTINCT chat_name n FROM inbox_messages WHERE is_group = 0 UNION SELECT DISTINCT sender FROM inbox_messages WHERE sender != 'Me'");
  q('outbox', 'SELECT DISTINCT to_name n FROM outbox');
  q('intake_people', 'SELECT DISTINCT name n FROM intake_people WHERE name IS NOT NULL');
  q('vips', 'SELECT DISTINCT name n FROM vips WHERE name IS NOT NULL');
  return out.filter(Boolean);
}

async function knownNames() {
  return [process.env.OWNER_NAME, ...(await vaultNames()), ...dbNames()].filter(Boolean);
}

function enabled() {
  const v = require('./db').getKv('pseudonymize');
  if (v === 'on') return true;
  if (v === 'off') return false;
  return !/^(0|false|off|no)$/i.test(String(process.env.PSEUDONYMIZE || '').trim());
}

// One mapping per AI request. Returns null when pseudonymization is switched off.
async function session() {
  if (!enabled()) return null;
  return new Session(buildRegistry(await knownNames()));
}

function command(args) {
  const db = require('./db');
  const a = String(args || '').trim().toLowerCase();
  if (a === 'on' || a === 'off') db.setKv('pseudonymize', a);
  else if (a) return 'Use /pseudo on or /pseudo off.';
  return enabled()
    ? `Pseudonymization is *on*${a ? ' now' : ''}: names, phone numbers, emails, addresses and ID numbers are replaced with placeholders like [PERSON_1] before anything goes to the AI, and put back in the answer. Images and PDFs are sent as they are. /pseudo off to stop.`
    : `Pseudonymization is *off*${a ? ' now' : ''}: the AI sees real names and numbers (still only over zero-data-retention routing). /pseudo on to turn it back on.`;
}

module.exports = { session, enabled, command, buildRegistry, Session, HINT, _resetCache: () => { vaultCache = { at: 0, names: [] }; } };
