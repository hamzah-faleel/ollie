// Client for the claude-bridge container (see claude-bridge/). Claude Code never runs inside the bot, which keeps .env out of its reach.
//   ask()    : one-shot text-in/text-out call with every Claude Code tool disabled (used for the nightly memory run)
//   remote   : start/stop a Remote Control session the owner then opens in the Claude app (owner command /code only)
// Text from outside people may only ever go through ask(); remote sessions are driven from the Claude app, never from message text.
const db = require('./db');

const url = () => (process.env.CLAUDE_BRIDGE_URL || '').replace(/\/$/, '');
const token = () => (process.env.CLAUDE_BRIDGE_TOKEN || '').trim();
const enabled = () => Boolean(url() && token());

async function call(method, path, body, timeoutMs = 20_000) {
  if (!enabled()) throw new Error('The Claude bridge is not set up (CLAUDE_BRIDGE_URL / CLAUDE_BRIDGE_TOKEN).');
  const res = await fetch(url() + path, {
    method, headers: { 'X-Bridge-Token': token(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `bridge ${path} -> ${res.status}`);
  return j;
}

async function ask(system, user) {
  const j = await call('POST', '/ask', { system, user }, 330_000);
  if (!j.text) throw new Error('empty answer from Claude');
  return String(j.text);
}

// Nightly runs use Claude when /nightly claude was chosen (kv), else NIGHTLY_AI=claude, and only if the bridge exists.
const nightlyOn = () => enabled() && (db.getKv('nightly_ai') ?? (process.env.NIGHTLY_AI || '')).toLowerCase() === 'claude';
function setNightly(v) { db.setKv('nightly_ai', v === 'claude' ? 'claude' : 'openrouter'); }

const remote = {
  start: () => call('POST', '/remote/start', {}),
  status: () => call('GET', '/remote/status'),
  stop: () => call('POST', '/remote/stop', {}),
  login: () => call('GET', '/status'),
};

module.exports = { enabled, ask, nightlyOn, setNightly, remote };
