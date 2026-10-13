#!/usr/bin/env node
// Summarize exported WhatsApp transcripts into Private/People/<Name>.md notes using a LOCAL Ollama model.
// Runs on YOUR machine (Node 22+, no dependencies). Nothing leaves the machine: Ollama is local, files stay on disk.
//
//   node scripts/summarize-chats.js --in ./chat-export --vault /path/to/vault-clone
//   node scripts/summarize-chats.js --in ./chat-export --vault /path/to/vault-clone --answer    # answer saved questions later
//
// Options: --model gemma3:12b  --ollama http://127.0.0.1:11434  --only "name part"  --min 10 (skip chats under N messages)
//          --contacts contacts.vcf (match people by phone number)  --about me.txt (a few lines about you)
//          --ask (ask me the model's questions right away; default saves them for --answer)
//          --chunk 14000 (chars per piece of a long transcript)  --ctx 8192 (Ollama num_ctx)  --fresh (ignore _done.txt)
// Resumes by default: finished files are listed in <in>/_done.txt; unanswered questions in <in>/_questions.json.
const fs = require('fs');
const path = require('path');
const readline = require('node:readline/promises');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);

const IN = path.resolve(opt('in', './chat-export'));
const VAULT = path.resolve(opt('vault', '.'));
const MODEL = opt('model', 'gemma3:12b');
const OLLAMA = opt('ollama', process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const ONLY = (opt('only') || '').toLowerCase();
const MIN = Number(opt('min', 10));
const CHUNK = Number(opt('chunk', 14000));
const CTX = Number(opt('ctx', 8192));
const OUT = path.join(VAULT, 'Private', 'People');
const QFILE = path.join(IN, '_questions.json');

const GLOSSARY = `Glossary: ow = yes; na / nathuwa / ne = no; machan / macha = buddy; aiyo = oh no; mokada = why/what; mama = I; oya = you; heta = tomorrow; ada = today; kalin = earlier; passe = later; hari = ok; epa = don't; karanna = to do; enna = come; yanna = go; aiya = older brother; akka = older sister; malli = younger brother; nangi = younger sister.`;

const RULES = `The chat is in Sri Lankan English mixed with romanized Sinhala (Singlish), written in English letters. Write the note in English.
${GLOSSARY}
Rules:
- Use only what is written in the chat. Do not guess, infer, or fill gaps. Never turn one passing mention into a fact about the person (a single mention is not a "preference", "interest" or "location").
- If a message is unclear or you cannot tell what it means, leave it out. Do not interpret slang you do not know.
- "Me" is the owner of the notes. Write from the owner's point of view ("I", "we"), not "Me" in the third person.
- Keep dates, names and amounts exactly as written. Say "month and day only" if a year is not known.
- Never copy passwords, OTPs, card or ID numbers, or addresses. For health, money, romantic or other sensitive topics, record only the topic level ("was going through a hard time in March"), not the details. Don't quote long passages.
- Write plain Markdown, no code fences, no preamble. Use "None" for an empty section instead of filling it.`;

const SECTIONS = `## Snapshot
2-3 sentences: who they are to me ONLY if the chat or contact card says so (otherwise write "Relationship unclear"), and how often we talk
## How we talk
tone, language mix, typical topics
## Open loops
only things that one of us promised or asked and the chat shows still not done or unanswered at the end, with the date. Not things that were merely mentioned.
## Key moments
dated, one line each, only clearly stated events: trips, events, favours, disagreements
## Facts
only things explicitly stated: birthday, work/study, family, interests, important dates`;

const QUESTIONS = `## Questions for you
Up to 3 short questions, ONLY if you genuinely cannot tell who this person is to me (relationship, role, which "Sam" or "aiya" they are) or what an important item refers to. Never ask what the chat already answers, and never answer them yourself. Write "None" if nothing is unclear.`;

const REL = `Start the note with exactly one line: RELATIONSHIP: <friend|family|coworker|client|acquaintance|unknown>. Use "unknown" unless the chat, contact card or owner's answers state it.`;

async function chat(prompt) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: false, options: { num_ctx: CTX, temperature: 0.2 }, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(30 * 60_000),
  }).catch((e) => { throw new Error(`Cannot reach Ollama at ${OLLAMA} (${e.message}). Is it running? Is "${MODEL}" pulled?`); });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    if (res.status === 404) {
      const tags = await fetch(`${OLLAMA}/api/tags`).then((r) => r.json()).catch(() => null);
      const names = (tags?.models || []).map((m) => m.name).join(', ') || 'none';
      throw new Error(`Ollama 404: ${text}. Installed at ${OLLAMA}: ${names}. Rerun with --model <name>.`);
    }
    throw new Error(`Ollama ${res.status}: ${text}`);
  }
  const j = await res.json();
  return String(j.message?.content || '').replace(/^```(?:markdown|md)?\n?|\n?```$/g, '').trim();
}

// Split a transcript at line boundaries into pieces of about CHUNK chars.
function pieces(body) {
  const out = [];
  let cur = '';
  for (const l of body.split('\n')) {
    if (cur.length + l.length > CHUNK && cur) { out.push(cur); cur = ''; }
    cur += l + '\n';
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const meta = (txt, key) => (txt.match(new RegExp(`^- ${key}: (.*)$`, 'm')) || [])[1]?.trim() || '';
const safe = (s) => String(s).replace(/[\\/:*?"<>|\n\r]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Unknown';

// Optional background info, read locally.
const last9 = (s) => String(s).replace(/\D/g, '').slice(-9);
const ABOUT = opt('about') ? fs.readFileSync(path.resolve(opt('about')), 'utf8').trim().slice(0, 2000) : '';
const CONTACTS = new Map(); // last 9 digits of a number -> "Name; Org; Title; Note"
if (opt('contacts')) {
  const cards = fs.readFileSync(path.resolve(opt('contacts')), 'utf8').replace(/\r?\n[ \t]/g, '').split(/BEGIN:VCARD/i).slice(1);
  for (const card of cards) {
    const f = (k) => (card.match(new RegExp(`^${k}[^:\\n]*:(.*)$`, 'im')) || [])[1]?.replace(/\\[,;n]/g, ' ').replace(/;/g, ' ').trim() || '';
    const info = [f('FN'), f('ORG'), f('TITLE'), f('NOTE')].filter(Boolean).join('; ');
    for (const t of card.matchAll(/^TEL[^:\n]*:(.*)$/gim)) if (last9(t[1]).length === 9 && info) CONTACTS.set(last9(t[1]), info);
  }
  console.log(`Loaded ${CONTACTS.size} contact numbers from ${opt('contacts')}.`);
}
function context(phone) {
  const card = phone && CONTACTS.get(last9(phone));
  return `${ABOUT ? `About the owner ("Me"), for context only:\n${ABOUT}\n\n` : ''}${card ? `The owner's contact card for this person (trust it for who they are): ${card}\n\n` : ''}`;
}

// Pull the "Questions for you" section and the RELATIONSHIP line out of a model reply.
function parse(raw) {
  let note = raw;
  const rel = (note.match(/^RELATIONSHIP:\s*([a-z]+)/im) || [])[1]?.toLowerCase() || 'unknown';
  note = note.replace(/^RELATIONSHIP:.*\n?/im, '');
  const m = note.match(/\n?## Questions for you\s*\n([\s\S]*?)(?=\n## |$)/i);
  let questions = [];
  if (m) {
    note = note.replace(m[0], '');
    questions = m[1].split('\n').map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim()).filter((l) => l.endsWith('?')).slice(0, 3);
  }
  return { note: note.trim(), relationship: rel === 'unknown' ? 'unsure' : rel, questions };
}

async function summarize(name, txt, existing, phone) {
  const body = txt.split('\n').filter((l) => !/^- (phone|messages|span|exported):/.test(l) && !l.startsWith('# Chat with')).join('\n');
  const parts = pieces(body);
  const ctx = context(phone);
  const notes = [];
  for (let i = 0; i < parts.length; i++) {
    console.log(`    piece ${i + 1}/${parts.length}`);
    const last = parts.length === 1; // a single piece is the final note, so it also carries the questions
    notes.push(await chat(`${ctx}Below is part ${i + 1} of ${parts.length} of my WhatsApp chat with "${name}". Extract notes about this person and our relationship under these headings:\n\n${last ? `${REL}\n\n` : ''}${SECTIONS}${last ? `\n${QUESTIONS}` : ''}\n\n${RULES}\n\nChat:\n${parts[i]}`));
  }
  if (parts.length === 1 && !existing) return notes[0];
  console.log('    merging');
  return chat(`${ctx}Merge these notes about "${name}" into ONE note under exactly these headings (remove duplicates, keep dates, order Key moments chronologically; drop open loops that a later part shows were finished):\n\n${REL}\n\n${SECTIONS}\n${QUESTIONS}\n\n${existing ? `An existing note is included first. Keep any text the owner wrote themselves; merge, don't duplicate.\n\nEXISTING NOTE:\n${existing}\n\n` : ''}NEW NOTES:\n${notes.join('\n\n')}\n\n${RULES}`);
}

let rl;
const prompt = async (q) => (rl ||= readline.createInterface({ input: process.stdin, output: process.stdout })).question(q);

// Ask the owner each question; returns [{q, a}] for the answered ones (Enter skips).
async function askOwner(name, questions) {
  console.log(`\n  Questions about ${name} (Enter to skip one):`);
  const qa = [];
  for (const q of questions) {
    const a = (await prompt(`   ? ${q}\n   > `)).trim();
    if (a) qa.push({ q, a });
  }
  return qa;
}

async function applyAnswers(name, note, qa) {
  const raw = await chat(`Below is my note about "${name}" and my answers to your questions. Update the note: treat my answers as facts, put them under the right headings (Snapshot, Facts), fix anything they contradict, and keep every other line. Keep exactly the same headings, add no Questions section, and add no guesses.\n\n${REL}\n\nNOTE:\n${note}\n\nMY ANSWERS:\n${qa.map((x) => `Q: ${x.q}\nA: ${x.a}`).join('\n')}\n\n${RULES}`);
  return parse(raw);
}

const frontOf = (rel, phone, last) => ['---', 'private: true', `phone: ${phone === 'unknown' ? '' : phone}`, `relationship: ${rel}`, `last_contact: ${last}`, `source: whatsapp-export ${new Date().toISOString().slice(0, 10)}`, '---'].join('\n');
const loadQ = () => (fs.existsSync(QFILE) ? JSON.parse(fs.readFileSync(QFILE, 'utf8')) : {});
const saveQ = (q) => fs.writeFileSync(QFILE, JSON.stringify(q, null, 2), { mode: 0o600 });

// --answer: go through saved questions, ask the owner, update the notes.
async function answerMode() {
  const pending = loadQ();
  const keys = Object.keys(pending).filter((k) => k.toLowerCase().includes(ONLY));
  console.log(`${keys.length} people with open questions.`);
  for (const f of keys) {
    const { name, questions } = pending[f];
    const target = path.join(OUT, `${safe(name)}.md`);
    if (!fs.existsSync(target)) { delete pending[f]; continue; }
    const qa = await askOwner(name, questions);
    if (!qa.length) continue;
    const file = fs.readFileSync(target, 'utf8');
    const front = file.match(/^---[\s\S]*?---\n/)?.[0] || '';
    const body = file.slice(front.length).replace(/^# .*\n/, '').trim();
    const r = await applyAnswers(name, body, qa);
    const newFront = front.replace(/^relationship: .*$/m, `relationship: ${r.relationship === 'unsure' ? (front.match(/^relationship: (.*)$/m) || [])[1] || 'unsure' : r.relationship}`);
    fs.writeFileSync(target, `${newFront}# ${name}\n${r.note}\n`);
    delete pending[f];
    saveQ(pending);
    console.log('  updated.');
  }
  saveQ(pending);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (flag('answer')) { await answerMode(); rl?.close(); return; }
  if (!fs.existsSync(IN)) { console.error(`No export folder at ${IN}. Pass --in <folder>.`); process.exit(1); }
  const doneFile = path.join(IN, '_done.txt');
  const done = new Set(!flag('fresh') && fs.existsSync(doneFile) ? fs.readFileSync(doneFile, 'utf8').split('\n').filter(Boolean) : []);
  const files = fs.readdirSync(IN).filter((f) => f.endsWith('.md') && !f.startsWith('_') && f.toLowerCase().includes(ONLY));
  console.log(`${files.length} transcripts, model ${MODEL}, writing to ${OUT}`);
  let n = 0;
  for (const f of files) {
    n++;
    if (done.has(f)) continue;
    const txt = fs.readFileSync(path.join(IN, f), 'utf8');
    const name = (txt.match(/^# Chat with (.*)$/m) || [])[1] || f.replace(/\.md$/, '');
    const count = Number(meta(txt, 'messages').match(/\d+/)?.[0] || 0);
    if (count < MIN) { console.log(`[${n}/${files.length}] ${name}: ${count} messages, skipped`); done.add(f); fs.appendFileSync(doneFile, f + '\n'); continue; }
    console.log(`[${n}/${files.length}] ${name} (${count} messages)`);
    const target = path.join(OUT, `${safe(name)}.md`);
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/^---[\s\S]*?---\n/, '').trim() : '';
    const phone = meta(txt, 'phone');
    let r;
    try {
      r = parse(await summarize(name, txt, existing, phone));
      if (r.questions.length && flag('ask')) {
        const qa = await askOwner(name, r.questions);
        if (qa.length) r = await applyAnswers(name, r.note, qa);
        r.questions = [];
      }
    } catch (e) { console.error(`  failed: ${e.message}`); if (/Cannot reach/.test(e.message)) process.exit(1); continue; }
    const last = meta(txt, 'span').split(' to ')[1] || '';
    fs.writeFileSync(target, `${frontOf(r.relationship, phone, last)}\n# ${name}\n${r.note.replace(/^# .*\n/, '')}\n`);
    if (r.questions.length) { const q = loadQ(); q[f] = { name, questions: r.questions }; saveQ(q); }
    done.add(f);
    fs.appendFileSync(doneFile, f + '\n');
  }
  rl?.close();
  const open = Object.keys(loadQ()).length;
  if (open) console.log(`\n${open} people have open questions. Answer them with: node summarize-chats.js --in ${opt('in', './chat-export')} --vault ${opt('vault', '.')} --answer`);
  console.log(`\nDone. Notes are in ${OUT}. Review them in Obsidian, then delete ${IN} and commit the vault.`);
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
