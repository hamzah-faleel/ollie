// Tests claude-bridge/bridge.js and claude.js with a fake `claude` command. Needs `script` (util-linux), so run in a Debian image:
//   docker run --rm -v "$PWD":/app -w /app node:22-slim node --disable-warning=ExperimentalWarning scripts/test-claude.js
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
const bin = path.join(tmp, 'bin'), home = path.join(tmp, 'home');
fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(path.join(home, 'work', '.git'), { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
case "$1" in
  auth) echo "Logged in as test@example.com"; exit 0;;
  remote-control) echo "Remote Control ready: https://claude.ai/code/session_abc123"; sleep 60;;
  *) echo "ARGS: $*"; echo "STDIN: $(cat)"; echo "TOKENENV: \${BRIDGE_TOKEN:-none}"; exit 0;;
esac
`, { mode: 0o755 });

const TOKEN = 'test-token-0123456789abcdef0123456789';
process.env.DB_PATH = path.join(tmp, 'bot.db'); process.env.VAULT_DIR = path.join(tmp, 'vault');
process.env.CLAUDE_BRIDGE_URL = 'http://127.0.0.1:8787'; process.env.CLAUDE_BRIDGE_TOKEN = TOKEN;
const bridge = spawn('node', [path.join(__dirname, '..', 'claude-bridge', 'bridge.js')], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, BRIDGE_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
let bridgeLog = ''; bridge.stdout.on('data', (d) => { bridgeLog += d; }); bridge.stderr.on('data', (d) => { bridgeLog += d; });

let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(150); } return false; };
const req = async (method, p, body, token = TOKEN) => {
  const r = await fetch('http://127.0.0.1:8787' + p, { method, headers: { ...(token ? { 'X-Bridge-Token': token } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

(async () => {
  check('bridge starts', await until(() => /listening/.test(bridgeLog)), bridgeLog);
  check('/health needs no token', (await req('GET', '/health', null, '')).status === 200);
  check('no token: 401', (await req('POST', '/ask', { user: 'x' }, '')).status === 401);
  check('wrong token: 401', (await req('POST', '/ask', { user: 'x' }, 'nope')).status === 401);
  check('missing text: 400', (await req('POST', '/ask', {})).status === 400);

  const a = await req('POST', '/ask', { system: 'SYS PROMPT', user: 'hello [PERSON_1]' });
  check('/ask returns the answer', a.status === 200 && /STDIN: hello \[PERSON_1\]/.test(a.json.text), JSON.stringify(a));
  check('/ask runs print mode with every tool disabled and no session saved', /-p --tools {1,2}--no-session-persistence --system-prompt SYS PROMPT/.test(a.json.text), a.json.text);
  check('the claude child never sees the bridge token', /TOKENENV: none/.test(a.json.text) && !a.json.text.includes(TOKEN), a.json.text);

  const st = await req('GET', '/status');
  check('/status reports the login', st.status === 200 && st.json.login.ok && /Logged in/.test(st.json.login.text), JSON.stringify(st));

  const s1 = await req('POST', '/remote/start', {});
  check('/remote/start returns a running state', s1.status === 200 && s1.json.running === true, JSON.stringify(s1));
  check('the Claude app link is picked out of the output', await until(async () => (await req('GET', '/remote/status')).json.url === 'https://claude.ai/code/session_abc123'));
  const s2 = await req('POST', '/remote/start', {});
  check('starting twice does not start a second server', s2.json.since === s1.json.since, JSON.stringify([s1.json.since, s2.json.since]));
  await req('POST', '/remote/stop', {});
  check('/remote/stop ends it', await until(async () => (await req('GET', '/remote/status')).json.running === false));

  // claude.js (the bot side)
  const claude = require('../claude'), db = require('../db');
  check('claude.js is enabled when URL and token are set', claude.enabled());
  const text = await claude.ask('SYS', 'from the bot');
  check('claude.ask goes through the bridge', /STDIN: from the bot/.test(text), text);
  const bad = await (async () => { process.env.CLAUDE_BRIDGE_TOKEN = 'wrong-wrong-wrong-wrong-wrong-12'; try { await claude.ask('s', 'u'); return 'ok'; } catch (e) { return e.message; } finally { process.env.CLAUDE_BRIDGE_TOKEN = TOKEN; } })();
  check('claude.ask fails with a wrong token', /unauthorized/.test(bad), bad);
  check('nightly defaults to OpenRouter', !claude.nightlyOn());
  claude.setNightly('claude'); check('/nightly claude turns it on', claude.nightlyOn());
  claude.setNightly('openrouter'); check('/nightly openrouter turns it off', !claude.nightlyOn());
  claude.setNightly('claude'); const keep = process.env.CLAUDE_BRIDGE_URL; process.env.CLAUDE_BRIDGE_URL = '';
  check('without a bridge the nightly setting is ignored', !claude.nightlyOn()); process.env.CLAUDE_BRIDGE_URL = keep;
  db.setKv('nightly_ai', 'openrouter');

  bridge.kill('SIGKILL'); spawn('pkill', ['-f', 'session_abc123']).on('error', () => {});
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); bridge.kill('SIGKILL'); process.exit(1); });
