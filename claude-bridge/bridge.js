// Claude bridge: the only place Claude Code runs for the WhatsApp bot. Zero dependencies, token protected.
//   POST /ask            {system, user}  -> {text}   one-shot `claude -p` with ALL tools disabled (nightly memory runs)
//   POST /remote/start                   -> state    starts `claude remote-control` so the owner can drive a session from the Claude app
//   GET  /remote/status | POST /remote/stop
//   GET  /status                         -> login state
// Text for /ask is only ever data to summarize: no tools, empty working directory, so nothing in it can run or read anything.
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

const TOKEN = process.env.BRIDGE_TOKEN || '';
if (TOKEN.length < 24) { console.error('BRIDGE_TOKEN (24+ characters) is required'); process.exit(1); }
const HOME = process.env.HOME || '/home/node', WORK = `${HOME}/work`, ASK_DIR = `${HOME}/ask`;
const MODEL = process.env.ASK_MODEL || '';
const MAX_BODY = 600_000, ASK_TIMEOUT_MS = 300_000;
fs.mkdirSync(ASK_DIR, { recursive: true });

const childEnv = () => { const e = { ...process.env }; delete e.BRIDGE_TOKEN; return e; };            // the child never sees the bridge token
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, '').replace(/\r/g, '');
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---- /ask: one request at a time, no tools ----
// `--tools ""` only removes the built-in tools: verified with the real CLI (2.1.302) that the account's claude.ai connectors
// (mcp__claude_ai_* : Gmail, Drive, Calendar, ...) stay callable with it alone. So /ask also:
//   --strict-mcp-config --mcp-config '{"mcpServers":{}}'  no MCP servers at all (connectors, ~/.claude.json, .mcp.json)
//   --disallowedTools mcp__*                               and deny any MCP tool that still shows up
//   --setting-sources ""                                   ignore user/project/local settings (hooks, plugins, permissions,
//                                                          CLAUDE.md) that a tool-enabled /code session could have written
//   --safe-mode                                            all customizations off (CLAUDE.md, skills, plugins, hooks, MCP)
// With these the CLI reports no tools at all and ignores a planted CLAUDE.md (checked live). A separate HOME for /ask was
// considered and not used: /code runs as the same user and could write there too, and a copied OAuth login would diverge
// from the main one when the refresh token rotates. The flags, not the directory, are what keep /ask tool-less.
const ASK_FLAGS = ['-p', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disallowedTools', 'mcp__*',
  '--setting-sources', '', '--safe-mode', '--no-session-persistence'];
let queue = Promise.resolve();
// signal: aborted when the HTTP client went away; a queued job is dropped and a running claude child is killed.
function ask({ system, user }, signal) {
  const run = () => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('client disconnected'));
    const args = [...ASK_FLAGS, '--system-prompt', String(system || 'You are a helpful assistant.'), ...(MODEL ? ['--model', MODEL] : [])];
    const p = spawn('claude', args, { cwd: ASK_DIR, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('timed out')); }, ASK_TIMEOUT_MS);
    const onAbort = () => { clearTimeout(timer); p.kill('SIGKILL'); console.log('[ask] client disconnected, claude stopped'); reject(new Error('client disconnected')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    p.on('close', () => signal?.removeEventListener('abort', onAbort));
    p.stdin.on('error', () => {}); // the child may die before reading stdin
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error(strip(err || out).trim().slice(0, 300) || (code === 0 ? 'empty answer from claude' : `claude exited with ${code}`))); });
    p.stdin.end(String(user || ''));
  });
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

// ---- Remote Control ----
let rc = null;
function syncRepo() {
  const git = (...a) => execFileSync('git', a, { cwd: WORK, timeout: 60_000, stdio: 'pipe' });
  if (!fs.existsSync(`${WORK}/.git`)) { execFileSync('git', ['clone', '-q', '/srv/repo.git', WORK], { timeout: 120_000, stdio: 'pipe' }); return; }
  try { git('pull', '--ff-only', '-q'); } catch { /* local work in progress or diverged: leave it as it is */ }
}
function startRemote() {
  if (rc && !rc.exited) return rc;
  syncRepo();
  const cmd = 'claude remote-control --spawn worktree --permission-mode default --name wa-code';
  const proc = spawn('script', ['-qfec', cmd, '/dev/null'], { cwd: WORK, env: { ...childEnv(), TERM: 'xterm' }, stdio: ['pipe', 'pipe', 'pipe'] });   // script gives it the terminal it expects
  rc = { proc, out: '', url: '', started: Date.now(), exited: false, code: null };
  const cur = rc;
  const on = (d) => { cur.out = (cur.out + strip(d.toString())).slice(-8000); const m = cur.out.match(/https:\/\/claude\.ai\/[^\s"')\]]+/); if (m) cur.url = m[0]; };
  proc.stdout.on('data', on); proc.stderr.on('data', on);
  proc.on('error', (e) => { cur.exited = true; cur.out += `\n${e.message}`; });
  proc.on('exit', (c) => { cur.exited = true; cur.code = c; });
  return rc;
}
const remoteState = () => !rc ? { running: false } : { running: !rc.exited, url: rc.url, since: rc.started, code: rc.code, tail: rc.out.replace(/\n{3,}/g, '\n\n').trim().slice(-500) };
function stopRemote() { if (rc && !rc.exited) { try { process.kill(rc.proc.pid, 'SIGTERM'); } catch {} spawn('pkill', ['-f', 'claude remote-control']).on('error', () => {}); } return remoteState(); }

function loginStatus() {
  try { return { ok: true, text: strip(execFileSync('claude', ['auth', 'status'], { timeout: 20_000, stdio: 'pipe', env: childEnv() }).toString()).trim().slice(0, 400) }; }
  catch (e) { return { ok: false, text: strip(String(e.stdout || e.stderr || e.message)).trim().slice(0, 400) }; }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  const send = (code, obj) => { if (res.destroyed || res.headersSent) return; res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.url === '/health') return send(200, { ok: true });
    if (!same(String(req.headers['x-bridge-token'] || ''), TOKEN)) return send(401, { error: 'unauthorized' });
    if (req.method === 'POST' && req.url === '/ask') {
      const b = await readJson(req);
      if (!b.user) return send(400, { error: 'user text required' });
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); }); // client gone before the answer: stop the work
      return send(200, { text: await ask(b, ac.signal) });
    }
    if (req.method === 'POST' && req.url === '/remote/start') { startRemote(); return send(200, remoteState()); }
    if (req.method === 'GET' && req.url === '/remote/status') return send(200, remoteState());
    if (req.method === 'POST' && req.url === '/remote/stop') return send(200, stopRemote());
    if (req.method === 'GET' && req.url === '/status') return send(200, { login: loginStatus(), remote: remoteState() });
    send(404, { error: 'not found' });
  } catch (e) { send(500, { error: String(e.message || e).slice(0, 300) }); }
}).listen(8787, '0.0.0.0', () => console.log('claude-bridge listening on :8787'));
