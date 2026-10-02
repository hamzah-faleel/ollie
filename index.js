// WhatsApp AI secretary — stage 2
// OpenWA webhook -> (Groq Whisper for voice) -> Gemini with tools -> reply via OpenWA
// Storage: SQLite (history, reminders) + Obsidian-style Markdown vault (notes).
// Zero npm dependencies: Node 22 built-ins only.

const http = require('http');
const crypto = require('crypto');

const cfg = {
  port: Number(process.env.PORT || 3000),
  openwaUrl: (process.env.OPENWA_URL || 'http://openwa-api:2785').replace(/\/$/, ''),
  openwaKey: process.env.OPENWA_API_KEY,
  webhookSecret: process.env.WEBHOOK_SECRET,
  owners: (process.env.OWNER_NUMBERS || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean),
  geminiKey: process.env.GEMINI_API_KEY,
  groqKey: process.env.GROQ_API_KEY,
  whisperModel: process.env.WHISPER_MODEL || 'whisper-large-v3-turbo',
  historyLimit: Number(process.env.HISTORY_LIMIT || 20),
  timezone: process.env.TZ || 'Asia/Colombo',
  botName: process.env.BOT_NAME || 'Sec',
};

for (const k of ['openwaKey', 'webhookSecret', 'geminiKey']) {
  if (!cfg[k]) { console.error(`Missing required env var for ${k}`); process.exit(1); }
}
if (!cfg.owners.length) console.warn('OWNER_NUMBERS is empty: the bot will ignore everyone and log senders so you can find your id.');
if (!cfg.groqKey) console.warn('GROQ_API_KEY not set: voice notes will be ignored.');

const db = require('./db');
const vault = require('./vault');
const ai = require('./ai');
const { fmt } = require('./tools');

function systemPrompt() {
  const now = new Date();
  const local = now.toLocaleString('en-GB', { timeZone: cfg.timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `You are ${cfg.botName}, a personal AI secretary and second brain, chatting with your owner on WhatsApp.

Current local date and time: ${local} (${cfg.timezone}, UTC+05:30). Current UTC time: ${now.toISOString()}.

How to behave:
- Be concise, warm and practical. Write like a WhatsApp message: short paragraphs, no markdown headers or tables.
- WhatsApp formatting only: *bold*, _italic_, ~strike~, and simple "- " lists.
- Messages marked [voice note] are transcriptions and may contain small errors; infer the intent.

Tools:
- Reminders: when the owner asks to be reminded, call set_reminder. For relative times use in_minutes. For clock times, give due_at in ISO 8601 with the +05:30 offset. If the time is ambiguous (e.g. "at 4" when it's already past 4am), assume the next upcoming occurrence. Confirm with the exact time returned by the tool.
- Notes / second brain: when the owner says note, save, remember, jot down, or shares an idea or info worth keeping, save it with save_note (or add_to_daily_log for quick journal-style updates). When asked about something they might have saved, call search_notes first, then read_note if needed. Never invent note contents.
- Only claim an action is done if the tool returned ok/created/appended. If a tool returns an error, tell the owner plainly.`;
}

// ---------- OpenWA ----------
async function openwa(path, opts = {}) {
  const res = await fetch(`${cfg.openwaUrl}/api${path}`, {
    ...opts,
    headers: { 'X-API-Key': cfg.openwaKey, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!res.ok) throw new Error(`OpenWA ${path} -> ${res.status} ${await res.text().catch(() => '')}`);
  return res;
}

async function sendText(sessionId, chatId, text) {
  const chunks = text.match(/[\s\S]{1,4000}(\n|$)|[\s\S]{1,4000}/g) || [text];
  for (const chunk of chunks) {
    await openwa(`/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, {
      method: 'POST',
      body: JSON.stringify({ chatId, text: chunk.trim() }),
    });
  }
}

async function setTyping(sessionId, chatId, state) {
  try {
    await openwa(`/sessions/${encodeURIComponent(sessionId)}/chats/typing`, {
      method: 'POST',
      body: JSON.stringify({ chatId, state }),
    });
  } catch { /* cosmetic only */ }
}

async function getAudio(sessionId, msg) {
  if (msg.media?.data) return { buf: Buffer.from(msg.media.data, 'base64'), mimetype: msg.media.mimetype };
  const res = await openwa(
    `/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(msg.chatId)}/${encodeURIComponent(msg.id)}/media`,
  );
  return { buf: Buffer.from(await res.arrayBuffer()), mimetype: msg.media?.mimetype || 'audio/ogg' };
}

// ---------- Groq Whisper ----------
async function transcribe({ buf, mimetype }) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mimetype || 'audio/ogg' }), 'voice.ogg');
  form.append('model', cfg.whisperModel);
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.groqKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq ${res.status} ${await res.text()}`);
  return (await res.json()).text?.trim() || '';
}

// ---------- message handling ----------
function isOwner(msg) {
  const ids = [msg.from, msg.author, msg.senderPhone, msg.contact?.number]
    .filter(Boolean)
    .map((s) => String(s).split('@')[0].replace(/\D/g, ''));
  return ids.some((id) => cfg.owners.includes(id));
}

const HELP = `*What I can do*
- Chat, or send me a voice note
- _"Remind me in 20 minutes to call Mum"_
- _"Remind me every Monday at 9 to post the weekly update"_
- _"Note: idea for the next shoot…"_
- _"What did I note about…?"_
- _"Log: finished the proposal draft"_

*Commands*
/reminders - upcoming reminders
/notes - recent notes
/reset - clear chat memory (notes and reminders stay)`;

async function handleCommand(cmd, sessionId, chatId) {
  if (cmd === '/reset') {
    db.clearMessages(chatId);
    return sendText(sessionId, chatId, 'Chat memory cleared. Your notes and reminders are untouched.');
  }
  if (cmd === '/reminders') {
    const rs = db.pendingReminders(chatId);
    return sendText(sessionId, chatId, rs.length
      ? '*Upcoming reminders*\n' + rs.map((r) => `${r.id}. ${r.text} - ${fmt(r.due_at)}${r.repeat !== 'none' ? ` (${r.repeat})` : ''}`).join('\n')
      : 'No upcoming reminders.');
  }
  if (cmd === '/notes') {
    const { notes } = await vault.listRecentNotes({ limit: 10 });
    return sendText(sessionId, chatId, notes.length ? '*Recent notes*\n' + notes.map((n) => `- ${n.path}`).join('\n') : 'No notes yet.');
  }
  if (cmd === '/help' || cmd === '/start') return sendText(sessionId, chatId, HELP);
  return false;
}

async function handle(event) {
  if (event.event !== 'message.received') return;
  const msg = event.data || {};
  const sessionId = event.sessionId;
  if (msg.fromMe || msg.isGroup || msg.kind !== 'individual') return;

  if (!isOwner(msg)) {
    console.log(`Ignored message from ${msg.from} (senderPhone=${msg.senderPhone ?? 'n/a'}). Add your number to OWNER_NUMBERS if this is you.`);
    return;
  }

  let text = (msg.body || '').trim();
  let viaVoice = false;

  if (msg.type === 'voice' || msg.type === 'audio') {
    if (!cfg.groqKey) return sendText(sessionId, msg.chatId, 'Voice notes are not set up yet (missing GROQ_API_KEY).');
    await setTyping(sessionId, msg.chatId, 'typing');
    text = await transcribe(await getAudio(sessionId, msg));
    viaVoice = true;
    if (!text) return sendText(sessionId, msg.chatId, "I couldn't make out that voice note. Could you try again?");
  } else if (msg.type !== 'text' || !text) {
    return sendText(sessionId, msg.chatId, 'For now I can only handle text and voice notes.');
  }

  if (!viaVoice && text.startsWith('/')) {
    const handled = await handleCommand(text.toLowerCase().split(/\s/)[0], sessionId, msg.chatId);
    if (handled !== false) return;
  }

  db.addMessage(msg.chatId, 'user', viaVoice ? `[voice note] ${text}` : text);
  await setTyping(sessionId, msg.chatId, 'typing');

  let answer;
  try {
    const history = db.recentMessages(msg.chatId, cfg.historyLimit);
    ({ text: answer } = await ai.reply(systemPrompt(), history, { sessionId, chatId: msg.chatId }));
    db.addMessage(msg.chatId, 'model', answer);
  } catch (e) {
    if (e instanceof ai.QuotaError) answer = "I've hit my free AI limit for now. Try again in a minute (or tomorrow if it's the daily cap).";
    else if (e instanceof ai.BusyError) answer = "Google's AI is overloaded right now. Give it a minute and send that again.";
    else throw e;
  }
  await setTyping(sessionId, msg.chatId, 'paused');
  await sendText(sessionId, msg.chatId, viaVoice ? `🎙️ _"${text.length > 200 ? text.slice(0, 200) + '…' : text}"_\n\n${answer}` : answer);
}

// ---------- reminder scheduler ----------
function nextOccurrence(ms, repeat) {
  const d = new Date(ms);
  if (repeat === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (repeat === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (repeat === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (const r of db.dueReminders(Date.now())) {
      try {
        await sendText(r.session_id, r.chat_id, `⏰ *Reminder:* ${r.text}`);
        if (r.repeat === 'none') db.setReminderStatus(r.id, 'done');
        else {
          let next = nextOccurrence(r.due_at, r.repeat);
          while (next <= Date.now()) next = nextOccurrence(next, r.repeat); // skip missed ones after downtime
          db.setReminderDue(r.id, next);
        }
        console.log(`[reminder] sent #${r.id}`);
      } catch (e) {
        console.error(`[reminder] #${r.id} failed, will retry:`, e.message); // stays pending
      }
    }
  } finally {
    ticking = false;
  }
}

// ---------- HTTP server ----------
const seen = new Map();
function alreadySeen(key) {
  if (!key) return false;
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 3_600_000) seen.delete(k);
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

function verifySignature(raw, header) {
  if (typeof header !== 'string') return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', cfg.webhookSecret).update(raw).digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (req.method !== 'POST' || req.url !== '/webhook') { res.writeHead(404); return res.end(); }

  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 20 * 1024 * 1024) req.destroy(); else chunks.push(c);
  });
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (!verifySignature(raw, req.headers['x-openwa-signature'])) {
      res.writeHead(401); return res.end('bad signature');
    }
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { res.writeHead(400); return res.end(); }

    res.writeHead(200); res.end('ok');
    if (alreadySeen(req.headers['x-openwa-idempotency-key'] || event.idempotencyKey)) return;

    handle(event).catch(async (err) => {
      console.error('Handler error:', err.message);
      const d = event.data || {};
      if (isOwner(d)) await sendText(event.sessionId, d.chatId, 'Something went wrong on my side. Check the bot logs.').catch(() => {});
    });
  });
});

vault.init()
  .catch((e) => console.error('[vault] init failed (notes still work locally):', e.message))
  .finally(() => {
    server.listen(cfg.port, () => console.log(`wa-bot listening on :${cfg.port} (owners: ${cfg.owners.join(', ') || 'none'})`));
    setInterval(tick, 20_000);
    tick();
  });
