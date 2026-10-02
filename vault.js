// Obsidian-compatible vault: notes are plain Markdown files.
// Optional: sync the vault to a private Git repo so Obsidian (Obsidian Git plugin) can pull it.
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const VAULT = path.resolve(process.env.VAULT_DIR || '/data/vault');
const REMOTE = process.env.VAULT_GIT_REMOTE || '';      // https://<token>@github.com/you/second-brain.git
const BRANCH = process.env.VAULT_GIT_BRANCH || 'main';
const TZ = process.env.TZ || 'Asia/Colombo';

// ---------- git (all operations run one at a time) ----------
let gitChain = Promise.resolve();
const gitEnabled = () => Boolean(REMOTE);

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: VAULT, timeout: 60_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args[0]}: ${(stderr || err.message).replace(REMOTE, '<remote>')}`)) : resolve(stdout));
  });
}
function queueGit(fn) {
  const run = gitChain.then(fn, fn);
  gitChain = run.catch((e) => console.warn('[vault]', e.message));
  return run;
}

async function init() {
  await fs.mkdir(VAULT, { recursive: true });
  if (!gitEnabled()) { console.log(`[vault] ${VAULT} (no git sync)`); return; }
  await queueGit(async () => {
    if (!fss.existsSync(path.join(VAULT, '.git'))) {
      const empty = (await fs.readdir(VAULT)).length === 0;
      let cloned = false;
      if (empty) cloned = await git(['clone', REMOTE, '.']).then(() => true, () => false);
      if (!cloned) {
        await git(['init', '-b', BRANCH]);
        await git(['remote', 'add', 'origin', REMOTE]);
      }
    } else {
      await git(['remote', 'set-url', 'origin', REMOTE]);
    }
    await git(['config', 'user.name', 'WhatsApp Secretary']);
    await git(['config', 'user.email', 'bot@localhost']);
    // Commit anything local, then merge in whatever is on GitHub (e.g. notes written in Obsidian).
    await git(['add', '-A']);
    if ((await git(['status', '--porcelain'])).trim()) await git(['commit', '-m', 'Local notes']);
    await git(['pull', '--rebase', 'origin', BRANCH]).catch(() => console.log('[vault] remote is empty, it will be created on first note'));
    console.log(`[vault] ${VAULT} synced with git remote`);
  });
}

let lastPull = 0;
function pull() {
  // Pick up edits made in Obsidian, at most once a minute so replies stay fast.
  if (!gitEnabled() || Date.now() - lastPull < 60_000) return Promise.resolve();
  lastPull = Date.now();
  return queueGit(() => git(['pull', '--rebase', '--autostash', 'origin', BRANCH]).catch(() => {}));
}

let pushTimer = null;
function schedulePush(message) {
  if (!gitEnabled()) return;
  clearTimeout(pushTimer);
  // Batch several quick edits into one commit.
  pushTimer = setTimeout(() => queueGit(async () => {
    await git(['add', '-A']);
    const status = await git(['status', '--porcelain']);
    if (!status.trim()) return;
    await git(['commit', '-m', message]);
    await git(['pull', '--rebase', '--autostash', 'origin', BRANCH]).catch(() => {});
    await git(['push', '-u', 'origin', BRANCH]);
    console.log('[vault] pushed:', message);
  }), 5_000);
}

// ---------- helpers ----------
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
const nowTime = () => new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

function slug(title) {
  return String(title).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled';
}
function safePath(rel) {
  const full = path.resolve(VAULT, rel);
  if (!full.startsWith(VAULT + path.sep)) throw new Error('Invalid note path');
  return full;
}
async function walk(dir = VAULT, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.')) continue; // skip .git, .obsidian, .trash
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(VAULT, p);
const titleOf = (p) => path.basename(p, '.md');

async function findNote(title) {
  const want = slug(title).toLowerCase();
  const files = await walk();
  return files.find((f) => titleOf(f).toLowerCase() === want)
    || files.find((f) => titleOf(f).toLowerCase().includes(want));
}

// ---------- note operations ----------
async function saveNote({ title, content, tags = [], folder = 'Inbox' }) {
  await pull();
  const name = slug(title);
  const existing = await findNote(name);
  if (existing && titleOf(existing).toLowerCase() === name.toLowerCase()) {
    await fs.appendFile(existing, `\n\n## ${today()} ${nowTime()}\n${content}\n`);
    schedulePush(`Update note: ${name}`);
    return { status: 'appended_to_existing', path: rel(existing) };
  }
  const file = safePath(path.join(slug(folder), `${name}.md`));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tagLine = tags.length ? `tags: [${tags.map((t) => slug(t).replace(/\s+/g, '-')).join(', ')}]\n` : '';
  await fs.writeFile(file, `---\ncreated: ${today()} ${nowTime()}\nsource: whatsapp\n${tagLine}---\n\n# ${name}\n\n${content}\n`);
  schedulePush(`New note: ${name}`);
  return { status: 'created', path: rel(file) };
}

async function appendToNote({ title, content }) {
  await pull();
  const file = await findNote(title);
  if (!file) return { error: `No note found matching "${title}"` };
  await fs.appendFile(file, `\n${content}\n`);
  schedulePush(`Update note: ${titleOf(file)}`);
  return { status: 'appended', path: rel(file) };
}

async function addToDailyLog({ entry }) {
  await pull();
  const file = safePath(path.join('Daily', `${today()}.md`));
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (!fss.existsSync(file)) await fs.writeFile(file, `# ${today()}\n\n`);
  await fs.appendFile(file, `- ${nowTime()} ${entry}\n`);
  schedulePush(`Daily log ${today()}`);
  return { status: 'logged', path: rel(file) };
}

async function readNote({ title }) {
  await pull();
  const file = await findNote(title);
  if (!file) return { error: `No note found matching "${title}"` };
  const text = await fs.readFile(file, 'utf8');
  return { path: rel(file), content: text.length > 6000 ? text.slice(0, 6000) + '\n…(truncated)' : text };
}

async function searchNotes({ query, limit = 5 }) {
  await pull();
  const words = String(query).toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const results = [];
  for (const f of await walk()) {
    const text = await fs.readFile(f, 'utf8');
    const hay = (titleOf(f) + ' ' + text).toLowerCase();
    let score = 0;
    for (const w of words) score += hay.split(w).length - 1 + (titleOf(f).toLowerCase().includes(w) ? 5 : 0);
    if (!score) continue;
    const i = Math.max(0, text.toLowerCase().indexOf(words[0] || ''));
    results.push({ title: titleOf(f), path: rel(f), score, snippet: text.slice(Math.max(0, i - 120), i + 280).replace(/\s+/g, ' ') });
  }
  results.sort((a, b) => b.score - a.score);
  return { results: results.slice(0, limit), total_matches: results.length };
}

async function listRecentNotes({ limit = 10 }) {
  await pull();
  const files = await walk();
  const withTime = await Promise.all(files.map(async (f) => ({ f, t: (await fs.stat(f)).mtimeMs })));
  withTime.sort((a, b) => b.t - a.t);
  return { notes: withTime.slice(0, limit).map(({ f }) => ({ title: titleOf(f), path: rel(f) })) };
}

module.exports = { init, saveNote, appendToNote, addToDailyLog, readNote, searchNotes, listRecentNotes, gitEnabled };
