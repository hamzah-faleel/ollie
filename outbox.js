// Sending WhatsApp messages to other people on the owner's behalf, from the bot's own number.
// The AI can only DRAFT (send_whatsapp). A draft goes out only when the owner replies "yes" in chat, which index.js
// handles in code before the AI sees it, so text inside an email or note can never trigger a send.
const db = require('./db');
const contacts = require('./contacts');

const CC = (process.env.DEFAULT_COUNTRY_CODE || '94').replace(/\D/g, '');
const DAILY_LIMIT = Number(process.env.SEND_DAILY_LIMIT || 10);
const DRAFT_TTL_MS = 15 * 60_000;
const OWNERS = (process.env.OWNER_NUMBERS || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);

db.exec(`
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_chat TEXT NOT NULL,
    session_id TEXT NOT NULL,
    to_name TEXT NOT NULL,
    to_chat TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',  -- draft | sent | cancelled | failed
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  );
`);

const toChatId = (phone) => {
  let d = String(phone).replace(/\D/g, '');
  if (d.startsWith('0')) d = CC + d.replace(/^0+/, '');
  return d.length >= 8 && d.length <= 15 ? { chatId: `${d}@c.us`, digits: d } : null;
};

async function resolve(to) {
  const raw = String(to || '').trim();
  if (/^\+?[\d\s()-]{7,}$/.test(raw)) {
    const r = toChatId(raw);
    return r ? { ...r, name: `+${r.digits}` } : { error: `"${raw}" doesn't look like a valid phone number.` };
  }
  const { results = [] } = await contacts.findContact({ query: raw });
  const named = results.filter((c) => c.phone && c.name.toLowerCase().includes(raw.toLowerCase()));
  const pool = named.length ? named : results.filter((c) => c.phone).slice(0, 1);
  if (!pool.length) return { error: `No contact with a phone number matches "${raw}". Ask the owner for the number, or to save the contact first.` };
  if (pool.length > 1) return { error: `Several contacts match "${raw}": ${pool.map((c) => c.name).join(', ')}. Ask the owner which one.` };
  const r = toChatId(pool[0].phone);
  return r ? { ...r, name: pool[0].name } : { error: `${pool[0].name}'s saved phone number looks invalid.` };
}

const sentToday = () => db.prepare("SELECT COUNT(*) n FROM outbox WHERE status = 'sent' AND sent_at > ?").get(Date.now() - 86_400_000).n;

async function createDraft({ to, text }, ctx) {
  text = String(text || '').trim();
  if (!text) return { error: 'The message text is empty.' };
  if (text.length > 1500) return { error: 'Message too long (max 1500 characters).' };
  const r = await resolve(to);
  if (r.error) return r;
  if (OWNERS.includes(r.digits)) return { error: "That's the owner's own number. Just tell them directly." };
  db.prepare("UPDATE outbox SET status = 'cancelled' WHERE owner_chat = ? AND status = 'draft'").run(ctx.chatId);
  db.prepare('INSERT INTO outbox (owner_chat, session_id, to_name, to_chat, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ctx.chatId, ctx.sessionId, r.name, r.chatId, text, Date.now());
  return { ok: true, status: 'draft_awaiting_owner_confirmation', to: r.name, note: 'NOT sent. The system shows the owner the draft and sends only after they reply yes. Do not say it was sent.' };
}

function pendingDraft(ownerChat) {
  const d = db.prepare("SELECT * FROM outbox WHERE owner_chat = ? AND status = 'draft' ORDER BY id DESC LIMIT 1").get(ownerChat);
  if (!d) return null;
  if (Date.now() - d.created_at > DRAFT_TTL_MS) {
    db.prepare("UPDATE outbox SET status = 'cancelled' WHERE id = ?").run(d.id);
    return null;
  }
  return d;
}

const draftPreview = (d) => `📨 *Draft to ${d.to_name}:*\n"${d.text}"\n\nReply *yes* to send, *no* to cancel, or tell me what to change.`;

// send(sessionId, chatId, text) is index.js's sendText. Returns the reply for the owner.
async function confirm(ownerChat, send) {
  const d = pendingDraft(ownerChat);
  if (!d) return null;
  if (sentToday() >= DAILY_LIMIT) {
    db.prepare("UPDATE outbox SET status = 'cancelled' WHERE id = ?").run(d.id);
    return `Daily send limit reached (${DAILY_LIMIT} per 24h). Draft discarded.`;
  }
  try {
    await send(d.session_id, d.to_chat, d.text);
  } catch (e) {
    db.prepare("UPDATE outbox SET status = 'failed' WHERE id = ?").run(d.id);
    console.error('[outbox] send failed:', e.message);
    return `Couldn't send to ${d.to_name}: ${e.message.slice(0, 160)}`;
  }
  db.prepare("UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?").run(Date.now(), d.id);
  console.log(`[outbox] sent #${d.id} to ${d.to_name}`);
  return `✅ Sent to ${d.to_name}.`;
}

function cancel(ownerChat) {
  const d = pendingDraft(ownerChat);
  if (!d) return null;
  db.prepare("UPDATE outbox SET status = 'cancelled' WHERE id = ?").run(d.id);
  return `Cancelled. Nothing was sent to ${d.to_name}.`;
}

module.exports = { createDraft, pendingDraft, draftPreview, confirm, cancel };
