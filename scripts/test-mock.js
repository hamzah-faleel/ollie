// Mock end-to-end test for the OpenRouter provider: fake OpenRouter + fake OpenWA, real index.js in a child process.
// Run: node scripts/test-mock.js   (Node 22, no dependencies, nothing leaves the machine)
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const OWNER = '94700000001', SESSION = 'sess-1', SECRET = 'test-secret-test-secret';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mock-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });

let script = [];            // queued OpenRouter responses: { status, json }
const orRequests = [];      // what the bot sent to OpenRouter
const sent = [];            // what the bot sent to WhatsApp
const orSrv = http.createServer(async (req, res) => {
  const j = JSON.parse(await body(req));
  orRequests.push(j);
  const next = script.shift() || { status: 500, json: { error: { message: 'script empty' } } };
  res.writeHead(next.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(next.json));
});
const owSrv = http.createServer(async (req, res) => {
  const b = await body(req);
  if (req.url.endsWith('/send-text')) sent.push(JSON.parse(b).text);
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
});

const text = (t, extra = {}) => ({ status: 200, json: { model: 'mock', choices: [{ message: { role: 'assistant', content: t } }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 64 }, cost: 0.0001 }, ...extra } });
const calls = (...cs) => ({ status: 200, json: { model: 'mock', choices: [{ message: { role: 'assistant', content: null, tool_calls: cs.map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }], usage: { prompt_tokens: 120, completion_tokens: 20 } } });
const fail = (status, message = 'x') => ({ status, json: { error: { code: status, message } } });

let n = 0;
async function say(botPort, msg) {
  const raw = JSON.stringify({ event: 'message.received', sessionId: SESSION, data: { id: `m${++n}`, chatId: `${OWNER}@c.us`, from: `${OWNER}@c.us`, body: msg, type: 'text', kind: 'individual', isGroup: false, fromMe: false } });
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  await fetch(`http://127.0.0.1:${botPort}/webhook`, { method: 'POST', headers: { 'X-OpenWA-Signature': sig, 'X-OpenWA-Idempotency-Key': `k${n}` }, body: raw });
}
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(50); } return false; }

let failures = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + info}`); if (!ok) failures++; };

(async () => {
  const [orPort, owPort] = [await listen(orSrv), await listen(owSrv)];
  const botPort = 30000 + Math.floor(Math.random() * 10000);
  const dbPath = path.join(tmp, 'bot.db');
  const bot = spawn('node', ['--disable-warning=ExperimentalWarning', 'index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { PATH: process.env.PATH, PORT: botPort, OPENWA_URL: `http://127.0.0.1:${owPort}`, OPENWA_API_KEY: 'k', WEBHOOK_SECRET: SECRET, OWNER_NUMBERS: OWNER,
      GEMINI_API_KEY: 'unused', AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk-or-test', OPENROUTER_BASE_URL: `http://127.0.0.1:${orPort}`,
      OPENROUTER_MODEL: 'main/model', OPENROUTER_FALLBACK_MODEL: 'fallback/model', AI_RETRY_BASE_MS: '20', BRIEFING_TIME: '', DB_PATH: dbPath, VAULT_DIR: path.join(tmp, 'vault'), TZ: 'Asia/Colombo' },
  });
  let log = '';
  bot.stdout.on('data', (d) => { log += d; }); bot.stderr.on('data', (d) => { log += d; });
  if (!(await until(() => log.includes('listening')))) { console.log(log); throw new Error('bot did not start'); }

  const reset = () => { sent.length = 0; orRequests.length = 0; };

  // 1. plain reply
  reset(); script = [text('Hello there')];
  await say(botPort, 'hi');
  check('plain reply is sent', await until(() => sent.includes('Hello there')), JSON.stringify(sent));
  const r1 = orRequests[0] || {};
  check('privacy routing fields on every request', r1.provider?.zdr === true && r1.provider?.data_collection === 'deny' && r1.provider?.allow_fallbacks === false, JSON.stringify(r1.provider));
  check('tools sent in OpenAI format (lowercase types)', r1.tools?.length > 5 && r1.tools.every((t) => t.type === 'function' && t.function.parameters.type === 'object') && !JSON.stringify(r1.tools).includes('"STRING"'));
  check('system prompt has no clock (cacheable); clock is on the user message', !/Current local date and time/.test(r1.messages[0].content) && /Current local date and time/.test(r1.messages.at(-1).content));
  check('usage logged with cached tokens and cost', /\[ai\] openrouter model=mock in=100 out=10 cached=64 cost=\$0\.000100/.test(log));

  // 2. one tool call
  reset(); script = [calls(['call_1', 'set_reminder', { text: 'call mum', in_minutes: 5 }]), text('Reminder set')];
  await say(botPort, 'remind me in 5 min to call mum');
  check('tool call then final reply', await until(() => sent.includes('Reminder set')), JSON.stringify(sent));
  const toolMsg = orRequests[1]?.messages.filter((m) => m.role === 'tool') || [];
  check('tool result returned with matching tool_call_id', toolMsg.length === 1 && toolMsg[0].tool_call_id === 'call_1' && JSON.parse(toolMsg[0].content).ok === true, JSON.stringify(toolMsg));
  const db = new DatabaseSync(dbPath);
  check('reminder row written to SQLite', db.prepare("SELECT COUNT(*) n FROM reminders WHERE text = 'call mum' AND status = 'pending'").get().n === 1);

  // 3. two tool calls in one turn
  reset(); script = [calls(['a1', 'set_reminder', { text: 'one', in_minutes: 10 }], ['a2', 'set_reminder', { text: 'two', in_minutes: 20 }]), text('Both set')];
  await say(botPort, 'two reminders');
  check('two tool calls in one turn', await until(() => sent.includes('Both set')), JSON.stringify(sent));
  const t2 = orRequests[1]?.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id) || [];
  check('both results sent back with their ids', t2.join() === 'a1,a2', t2.join());
  check('both reminders stored', db.prepare("SELECT COUNT(*) n FROM reminders WHERE text IN ('one','two')").get().n === 2);

  // 4. 503 x4 on main -> fallback
  reset(); script = [fail(503), fail(503), fail(503), fail(503), text('From fallback')];
  await say(botPort, 'busy test');
  check('503 retried then fallback model answers', await until(() => sent.includes('From fallback')), JSON.stringify(sent));
  check('model order: main x4 then fallback', orRequests.map((r) => r.model).join() === 'main/model,main/model,main/model,main/model,fallback/model', orRequests.map((r) => r.model).join());

  // 5. 404 (no endpoint allowed by privacy settings) -> straight to fallback
  reset(); script = [fail(404, 'No endpoints found matching your data policy'), text('Fallback after 404')];
  await say(botPort, 'privacy test');
  check('404 goes straight to fallback (no retries)', await until(() => sent.includes('Fallback after 404')) && orRequests.length === 2, `${orRequests.length} requests`);

  // 6. 402 -> credit warning once per hour + unavailable reply
  reset(); script = [fail(402, 'Insufficient credits')];
  await say(botPort, 'credit test');
  check('402: top-up warning sent', await until(() => sent.includes('AI credit ran out — top up OpenRouter')), JSON.stringify(sent));
  check('402: owner told the AI is unavailable', await until(() => sent.some((s) => /unavailable/i.test(s))), JSON.stringify(sent));
  reset(); script = [fail(402, 'Insufficient credits')];
  await say(botPort, 'credit test again');
  check('402 again: reply sent but no second top-up warning', await until(() => sent.some((s) => /unavailable/i.test(s))) && !sent.some((s) => /top up/.test(s)), JSON.stringify(sent));

  bot.kill();
  orSrv.close(); owSrv.close();
  if (/sk-or-test/.test(log)) { console.log('FAIL  API key appeared in logs'); failures++; } else console.log('PASS  API key never logged');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nAll mock tests passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
