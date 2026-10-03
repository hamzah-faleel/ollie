// What the secretary knows about the owner: one Markdown note (Profile.md) the owner can also edit in Obsidian.
// It is injected into every system prompt, so keep it short; the cap protects the free-tier token budget.
const fs = require('fs/promises');
const { files } = require('./vault');

const FILE = 'Profile.md';
const SECTIONS = ['About me', 'Current focus', 'Preferences', 'People & relationships'];
const MAX_PROMPT_CHARS = 3000;

const read = () => fs.readFile(files.safePath(FILE), 'utf8').catch(() => '');

async function promptText() {
  const text = (await read()).replace(/^# .*\n+/, '').trim();
  return text.length > MAX_PROMPT_CHARS ? text.slice(0, MAX_PROMPT_CHARS) + '\n…(truncated)' : text;
}

async function rememberFact({ fact, section = 'About me' }) {
  if (!fact || !String(fact).trim()) return { error: 'Need a fact to remember.' };
  const name = SECTIONS.find((s) => s.toLowerCase() === String(section).toLowerCase()) || 'About me';
  await files.pull();
  const lines = (await read()).split('\n');
  if (!lines.some((l) => l.startsWith('# '))) lines.unshift('# Profile', '');
  const bullet = `- ${String(fact).replace(/\s+/g, ' ').trim()}`;
  if (lines.some((l) => l.trim().toLowerCase() === bullet.toLowerCase())) return { status: 'already_known' };
  let i = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (i < 0) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', `## ${name}`);
    i = lines.length - 1;
  }
  let end = i + 1; // insert after the last non-blank line of the section
  for (let j = i + 1; j < lines.length && !lines[j].startsWith('## '); j++) if (lines[j].trim()) end = j + 1;
  lines.splice(end, 0, bullet);
  await fs.writeFile(files.safePath(FILE), lines.join('\n').replace(/\n*$/, '\n'));
  files.schedulePush('Update profile');
  return { status: 'remembered', section: name };
}

async function forgetFact({ text }) {
  const want = String(text || '').trim().toLowerCase();
  if (!want) return { error: 'Need some text from the fact to forget.' };
  const lines = (await read()).split('\n');
  const hits = lines.filter((l) => l.startsWith('- ') && l.toLowerCase().includes(want));
  if (hits.length === 0) return { error: `Nothing in the profile matches "${text}".` };
  if (hits.length > 1) return { error: 'More than one fact matches; be more specific.', matches: hits.map((h) => h.slice(2)) };
  await fs.writeFile(files.safePath(FILE), lines.filter((l) => l !== hits[0]).join('\n'));
  files.schedulePush('Update profile');
  return { status: 'forgotten', fact: hits[0].slice(2) };
}

module.exports = { promptText, rememberFact, forgetFact };
