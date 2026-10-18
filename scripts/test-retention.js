// Unit test for retention.js on a temp DB. Run: docker run --rm -v "$PWD":/app -w /app node:22-alpine node --disable-warning=ExperimentalWarning scripts/test-retention.js
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ret-'));
process.env.DB_PATH = path.join(tmp, 'bot.db');
const db = require('../db');
require('../alerts'); require('../usage'); require('../outbox'); require('../mailout'); require('../inbox'); require('../intake');
const retention = require('../retention');
let failures = 0;
const check = (n, ok, i = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  ' + i}`); if (!ok) failures++; };
const D = 86_400_000, now = Date.now(), old = now - 100 * D, fresh = now - 10 * D;
const count = (t, w = '') => db.prepare(`SELECT count(*) c FROM ${t} ${w}`).get().c;

for (const [i, at] of [[1, old], [2, fresh]]) {
  db.prepare("INSERT INTO alerts (akey, kind, text, created_at) VALUES (?, 'message', 'x', ?)").run('k' + i, at);
  db.prepare("INSERT INTO triage (msg_id, label, at) VALUES (?, 'fyi', ?)").run('m' + i, at);
  db.prepare("INSERT INTO reply_check (msg_id, verdict, at) VALUES (?, 'no', ?)").run('m' + i, at);
  db.prepare("INSERT INTO ai_usage (ts, provider, model) VALUES (?, 'p', 'm')").run(at);
}
const ob = (st, at) => db.prepare("INSERT INTO outbox (owner_chat, session_id, to_name, to_chat, text, status, created_at) VALUES ('o','s','n','c','t',?,?)").run(st, at);
const eb = (st, at) => db.prepare("INSERT INTO email_outbox (owner_chat, to_addr, subject, body, status, created_at) VALUES ('o','a@b.c','s','b',?,?)").run(st, at);
const ib = (st, at) => db.prepare("INSERT INTO intake_invites (owner_chat, session_id, to_name, to_chat, phone, text, status, created_at) VALUES ('o','s','n','c','p','t',?,?)").run(st, at);
ob('sent', old); ob('draft', old); ob('cancelled', fresh); eb('expired', old); eb('draft', old); eb('sent', fresh); ib('sent', old); ib('failed', old); ib('draft', old); ib('sent', fresh);
db.prepare("INSERT INTO inbox_messages (msg_id, chat_id, chat_name, sender, ts, type, text, stored_at) VALUES ('i1','c','n','s',?,'chat','t',?)").run(old, old);
db.setKv('model_main', 'keep');

retention.tick(now);
for (const t of ['alerts', 'triage', 'reply_check', 'ai_usage']) check(`${t}: old row gone, new row kept`, count(t) === 1);
check('outbox: old finished purged, old draft + new kept', count('outbox') === 2 && count('outbox', "WHERE status='draft'") === 1);
check('email_outbox: old finished purged, old draft + new kept', count('email_outbox') === 2 && count('email_outbox', "WHERE status='draft'") === 1);
check('intake_invites: old finished purged, old draft + new kept', count('intake_invites') === 2 && count('intake_invites', "WHERE status='draft'") === 1);
check('inbox_messages and kv untouched', count('inbox_messages') === 1 && db.getKv('model_main') === 'keep');
ob('sent', old);
check('runs once a day (kv guard)', retention.tick(now) === null && count('outbox') === 3);
check('runs again the next day', retention.tick(now + D) !== null && count('outbox') === 2);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nAll retention tests passed');
process.exit(failures ? 1 : 0);
