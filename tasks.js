// To-do list kept in Tasks.md using Obsidian Tasks syntax ("- [ ] text 📅 2026-10-05"), so the owner can edit it in Obsidian.
const fs = require('fs/promises');
const { files } = require('./vault');

const FILE = 'Tasks.md';
const DUE = /\s*📅\s*(\d{4}-\d{2}-\d{2})/;
const read = () => fs.readFile(files.safePath(FILE), 'utf8').catch(() => '# Tasks\n\n');

function parse(text) {
  return text.split('\n').map((line, idx) => {
    const m = /^- \[( |x)\] (.*)$/.exec(line);
    if (!m) return null;
    const due = DUE.exec(m[2])?.[1] || null;
    return { idx, done: m[1] === 'x', text: m[2].replace(DUE, '').trim(), due };
  }).filter(Boolean);
}
const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.idx - b.idx;

async function openTasks() {
  await files.pull();
  return parse(await read()).filter((t) => !t.done).sort(byDue);
}

// Tasks completed on the given day (YYYY-MM-DD), recognised by the "✅ date" the bot adds on completion.
async function doneOn(day) {
  await files.pull();
  return parse(await read()).filter((t) => t.done && t.text.includes(`✅ ${day}`)).map((t) => t.text.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/, '').trim());
}

async function addTask({ text, due }) {
  if (!text || !String(text).trim()) return { error: 'Need the task text.' };
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { error: 'due must be YYYY-MM-DD.' };
  await files.pull();
  const body = (await read()).replace(/\n*$/, '\n');
  await fs.writeFile(files.safePath(FILE), `${body}- [ ] ${String(text).replace(/\s+/g, ' ').trim()}${due ? ` 📅 ${due}` : ''}\n`);
  files.schedulePush('Add task');
  return { status: 'added', text, due: due || null };
}

async function listTasks() {
  const open = await openTasks();
  return { open: open.map((t, i) => ({ n: i + 1, text: t.text, ...(t.due ? { due: t.due } : {}) })), today: files.today() };
}

async function completeTask({ match }) {
  const want = String(match || '').trim().toLowerCase();
  if (!want) return { error: 'Say which task (a number from list_tasks or some of its words).' };
  const open = await openTasks();
  const hits = /^\d+$/.test(want) ? [open[Number(want) - 1]].filter(Boolean) : open.filter((t) => t.text.toLowerCase().includes(want));
  if (hits.length === 0) return { error: `No open task matches "${match}".` };
  if (hits.length > 1) return { error: 'More than one task matches; be more specific.', matches: hits.map((t) => t.text) };
  const lines = (await read()).split('\n');
  lines[hits[0].idx] = lines[hits[0].idx].replace('- [ ]', '- [x]') + ` ✅ ${files.today()}`;
  await fs.writeFile(files.safePath(FILE), lines.join('\n'));
  files.schedulePush('Complete task');
  return { status: 'completed', text: hits[0].text };
}

module.exports = { openTasks, addTask, listTasks, completeTask, doneOn };
