// Tests memory.js consolidation with a stubbed AI (nothing leaves the machine; synthetic names and numbers only):
// preamble stripping, privacy-safe reject logs, parking chats after repeated rejects, and once-a-day consolidation
// while a failed history backfill retries.
// Run: docker run --rm -v "$PWD":/app -w /app node:22-alpine node --disable-warning=ExperimentalWarning scripts/test-memory.js
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
fs.mkdirSync(path.join(tmp, 'vault'), { recursive: true });
Object.assign(process.env, { DB_PATH: path.join(tmp, 'bot.db'), VAULT_DIR: path.join(tmp, 'vault'), PERSONAL_SESSION_ID: 'personal', OPENWA_PERSONAL_KEY: 'test-key', MEMORY_PAUSE_MS: '0', MEMORY_MIN_MESSAGES: '1', TZ: 'Asia/Colombo' });

// The personal session is "down": every GET fails at once (500 is not retried).
const openwa = http.createServer((req, res) => { res.writeHead(500); res.end('session not started'); });

// Stub ai.js before memory.js loads it.
const answers = [];
const calls = [];
class CreditError extends Error {}
require.cache[require.resolve('../ai')] = { id: 'ai', filename: require.resolve('../ai'), loaded: true,
  exports: { untrusted: async (sys, user) => { calls.push(user); const a = answers.shift(); if (a instanceof Error) throw a; return a ?? 'SKIP'; }, CreditError } };

let failures = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(info).slice(0, 300)}`); if (!ok) failures++; };
const logs = [];
const origWarn = console.warn, origLog = console.log;
const capture = (fn) => async (...a) => { console.warn = (...x) => logs.push(x.join(' ')); try { return await fn(...a); } finally { console.warn = origWarn; } };

(async () => {
  await new Promise((r) => openwa.listen(0, '127.0.0.1', r));
  process.env.OPENWA_URL = `http://127.0.0.1:${openwa.address().port}`;
  const inbox = require('../inbox');
  const memory = require('../memory');
  const db = require('../db');
  const run = capture((o) => memory.run(o));

  let n = 0;
  const add = (chat, name, phone, text) => inbox.insertRaw({ msg_id: `m${++n}`, chat_id: chat, chat_name: name, sender: name, is_group: false, ts: Date.now() - 3600_000 + n, type: 'text', text, seen: true, from_me: false, phone });
  add('94711110001@c.us', 'Test Alpha', '94711110001', 'see you at the club on friday');
  add('94722220002@c.us', 'Test Bravo', '94722220002', 'did you get the parcel?');
  const good = 'Here is the updated note:\n\n# Test Alpha\n## Snapshot\nA club friend.\n## How we talk\nShort.\n## Open loops\n- Friday at the club\n## Key moments\n- none\n## Facts\n- club member';

  // 1. nightly run, backfill fails: Alpha is accepted after its preamble is stripped, Bravo's answer is rejected
  answers.push(good, 'Sorry, I cannot do that.');
  const r1 = await run({ day: '2026-10-17' });
  check('a failed backfill is reported', Boolean(r1.backfillError), JSON.stringify(r1));
  check('consolidation ran once: two model calls', calls.length === 2, calls.length);
  const alpha = fs.readdirSync(path.join(tmp, 'vault', 'Private', 'People')).map((f) => fs.readFileSync(path.join(tmp, 'vault', 'Private', 'People', f), 'utf8')).join('\n');
  check('a preamble before the "# " heading is stripped and the note written', /^---\n[\s\S]*\n---\n# Test Alpha\n## Snapshot/.test(alpha) && !/Here is/.test(alpha), alpha.slice(0, 200));
  const rej = logs.find((l) => /rejected model output/.test(l)) || '';
  check('the reject log names a reason code and a chat hash', /rejected model output \(prefix\) chat [0-9a-f]{8};/.test(rej), rej);
  check('no log line carries a name or a phone number', !logs.some((l) => /Test|Alpha|Bravo|9471|9472|11110001|22220002/.test(l)), logs.join(' | '));

  // 2. the 30-minute retry the same night: backfill is retried, consolidation is not (no paid calls redone)
  answers.push('should not be used');
  const r2 = await run({ day: '2026-10-17' });
  check('a retry on the same day does not consolidate again', calls.length === 2 && r2.consolidateDone === true, `${calls.length} ${JSON.stringify(r2)}`);
  check('the once-a-day marker is stored', db.getKv('last_consolidate_day') === '2026-10-17');
  answers.length = 0;

  // 3. a manual run consolidates; Bravo is rejected a second time (heading missing) and then parked
  answers.push('# Test Bravo\n## Snapshot\nA neighbour.');
  await run();
  check('a manual /memory run still consolidates', calls.length === 3, calls.length);
  check('the second reject logs the missing heading', logs.some((l) => /rejected model output \(heading:Open loops\)/.test(l)), logs.join(' | '));
  const before = calls.length;
  const r4 = await run();
  check('after 2 rejects in a row the chat is skipped (no model call)', calls.length === before && r4.parked === 1, `${calls.length} ${JSON.stringify(r4)}`);
  check('describe() mentions parked chats', /wait[s]? for new messages/.test(memory.describe(r4)), memory.describe(r4));

  // 4. a new message un-parks it
  await new Promise((r) => setTimeout(r, 5));
  add('94722220002@c.us', 'Test Bravo', '94722220002', 'parcel arrived, thanks');
  answers.push('# Test Bravo\n## Snapshot\nA neighbour.\n## Open loops\n- none\n## Key moments\n- parcel\n## Facts\n- neighbour');
  const r5 = await run();
  check('new messages bring a parked chat back', calls.length === before + 1 && r5.created === 1, `${calls.length} ${JSON.stringify(r5)}`);
  check('a success clears the reject counter', !db.prepare('SELECT 1 FROM memory_rejects').get());

  // 5. a different day consolidates again
  add('94711110001@c.us', 'Test Alpha', '94711110001', 'friday is cancelled');
  answers.push('SKIP');
  const c = calls.length;
  await run({ day: '2026-10-18' });
  check('the next day consolidates again', calls.length === c + 1, calls.length);

  console.log = origLog;
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
