// Consistent snapshot for the host-side backup (scripts/backup.sh). Runs inside the container, writes to /tmp/bk.
// bot.db is copied with VACUUM INTO (safe while the bot is running, unlike copying a live WAL database) and verified.
// The notes vault is copied WITHOUT its .git folder (that holds the sync token). No .env or other secrets are in /data.
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const OUT = '/tmp/bk', DB = process.env.DB_PATH || '/data/bot.db', VAULT = process.env.VAULT_DIR || '/data/vault';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });

const src = new DatabaseSync(DB);
src.exec(`VACUUM INTO '${OUT}/bot.db'`);
src.close();

const snap = new DatabaseSync(`${OUT}/bot.db`, { readOnly: true });
const check = Object.values(snap.prepare('PRAGMA integrity_check').get())[0];
const messages = snap.prepare('SELECT COUNT(*) n FROM messages').get().n;
snap.close();
if (check !== 'ok') { console.error(`integrity check failed: ${check}`); process.exit(3); }

let notes = 0;
fs.cpSync(VAULT, `${OUT}/vault`, { recursive: true, filter: (p) => { if (/(^|\/)\.git(\/|$)/.test(p)) return false; if (/\.md$/.test(p)) notes++; return true; } });
console.log(`snapshot ok: database verified (${messages} chat messages), ${notes} notes`);
