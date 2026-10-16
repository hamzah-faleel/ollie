// Relationship taxonomy for the Private/People notes and an owner-driven review (/rel). No AI: the owner decides.
// Why: the nightly model guessed relationships from chat text, which mixed up e.g. uni clubs and actual work. Now the owner's choice
// (marked `reviewed: true`) always wins, and keyword hints only help pick the right letter.
const fs = require('fs/promises');
const path = require('path');
const db = require('./db');
const { files } = require('./vault');
const memory = require('./memory');

// [letter, stored value, label]
const TAXONOMY = [
  ['a', 'family', 'Family'],
  ['b', 'friend', 'Friend'],
  ['c', 'uni-club', 'Uni club / society'],
  ['d', 'classmate', 'Uni classmate / batchmate'],
  ['e', 'work', 'Work (current job / colleague)'],
  ['f', 'past-work', 'Former work / ex-colleague'],
  ['g', 'client', 'Client / customer'],
  ['h', 'service', 'Shop / service / business'],
  ['i', 'acquaintance', 'Acquaintance'],
  ['j', 'other', 'Other'],
];
const byLetter = new Map(TAXONOMY.map(([l, v, label]) => [l, { value: v, label }]));
const labelOf = (value) => TAXONOMY.find(([, v]) => v === value)?.[2] || value;

// Keyword hints, checked in this order (clubs before classmates before work, because their vocabulary overlaps).
const HINTS = [
  ['uni-club', /\b(club|society|committee|council|rotaract|leo club|aiesec|ieee|robotics|debating|mun|chapter|union|event team|core team)\b/gi],
  ['classmate', /\b(batch|batchmate|lecture|lecturer|assignment|coursework|module|semester|exam|tutorial|classmate|degree|university|uni|iit|group project|viva)\b/gi],
  ['client', /\b(client|customer|invoice|quotation|quote|payment|proposal|order)\b/gi],
  ['work', /\b(office|colleague|manager|boss|standup|sprint|deadline|company|salary|hr|employer|supervisor|workplace|team lead)\b/gi],
  ['family', /\b(mum|mom|amma|thaththa|appachchi|dad|brother|sister|aunt|uncle|cousin|grandma|grandpa|family|nangi|malli|akka|aiya)\b/gi],
  ['service', /\b(delivery|shop|store|bank|airline|support|helpline|promo|offer|otp|order id|booking)\b/gi],
];
function hint(text, groupNames = []) {
  const hay = `${text}\n${groupNames.join('\n')}`;
  let best = null;
  for (const [value, re] of HINTS) {
    const n = (hay.match(re) || []).length;
    if (n >= 2 && (!best || n > best.n)) best = { value, n };
  }
  return best ? best.value : null;
}

const PEOPLE = 'Private/People/';
async function reviewList() {
  const out = [];
  for (const n of await memory.peopleNotes()) {
    const { fm, body } = memory.splitNote(n.text);
    if (/^reviewed:[ \t]*true/m.test(fm)) continue;
    out.push({
      file: n.file, rel: files.rel(n.file), title: files.titleOf(n.file), fm, body,
      current: /^relationship:[ \t]*(.+)$/m.exec(fm)?.[1]?.trim() || '', last: /^last_contact:[ \t]*(\S+)/m.exec(fm)?.[1] || '',
    });
  }
  return out.sort((a, b) => b.last.localeCompare(a.last)); // most recent contacts first
}

const PAGE = 6;
const legend = () => TAXONOMY.map(([l, , label]) => `${l.toUpperCase()} ${label}`).join(' · ');

async function page() {
  const list = await reviewList();
  if (!list.length) { db.setKv('rel_page', '[]'); return '✅ Every person has a relationship you set. /rel stats shows the split.'; }
  const items = list.slice(0, PAGE);
  db.setKv('rel_page', JSON.stringify(items.map((i) => i.rel)));
  const groups = (name) => db.prepare("SELECT DISTINCT chat_name FROM inbox_messages WHERE is_group = 1 AND (lower(sender) = lower(?) OR phone = ?)").all(name, String(name).replace(/\D/g, '')).map((r) => r.chat_name);
  const lines = items.map((i, k) => {
    const h = hint(i.body, groups(i.title));
    return `${k + 1}. ${i.title}${i.last ? ` (last chat ${i.last})` : ''} - now: ${i.current ? labelOf(i.current) : 'unsorted'}${h ? ` - looks like: ${labelOf(h)}` : ''}`;
  });
  return `*Who is who* - ${list.length} to review\n${lines.join('\n')}\n\n${legend()}\n\nReply like: /rel 1=c 2=e 3=skip (skip = ask me later)`;
}

async function apply(spec) {
  const pageFiles = JSON.parse(db.getKv('rel_page') || '[]');
  let done = 0;
  const bad = [];
  for (const m of spec.matchAll(/(\d+)\s*=?\s*([a-j]|skip)\b/gi)) {
    const rel = pageFiles[Number(m[1]) - 1];
    const pick = m[2].toLowerCase();
    if (!rel) { bad.push(m[1]); continue; }
    if (pick === 'skip') continue;
    if (!rel.startsWith(PEOPLE)) continue;
    const file = files.safePath(rel);
    const { fm, body } = memory.splitNote(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, `---\n${memory.setFm(fm, { relationship: byLetter.get(pick).value, reviewed: 'true' })}\n---\n${body}`);
    done++;
  }
  if (done) files.schedulePush('Relationships reviewed');
  return { done, bad };
}

async function stats() {
  const counts = {};
  let reviewed = 0, total = 0;
  for (const n of await memory.peopleNotes()) {
    const { fm } = memory.splitNote(n.text);
    const rel = /^relationship:[ \t]*(.+)$/m.exec(fm)?.[1]?.trim() || 'unsorted';
    counts[rel] = (counts[rel] || 0) + 1; total++;
    if (/^reviewed:[ \t]*true/m.test(fm)) reviewed++;
  }
  return `*People by relationship* (${total} notes, ${reviewed} confirmed by you)\n` + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${labelOf(k)}: ${v}`).join('\n') + '\n\n/rel to review the rest';
}

// /rel [stats | 1=c 2=e ...]
async function command(arg) {
  const a = arg.trim().toLowerCase();
  if (a === 'stats') return stats();
  if (!a) return page();
  const { done, bad } = await apply(a);
  if (!done && !bad.length) return `I didn't understand that. Use /rel 1=c 2=e 3=skip (letters: ${legend()})`;
  return `Saved ${done}.${bad.length ? ` No such number: ${bad.join(', ')}.` : ''}\n\n${await page()}`;
}

module.exports = { TAXONOMY, labelOf, hint, command, page, stats, byLetter };
