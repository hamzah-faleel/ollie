// Sending WhatsApp messages to other people on the owner's behalf, from the bot's own number.
// The AI can only DRAFT (send_whatsapp). A draft goes out only when the owner replies "yes" in chat, which index.js
// handles in code before the AI sees it, so text inside an email or note can never trigger a send.
const db = require('./db');
const fs = require('fs/promises');
const contacts = require('./contacts');
const { files } = require('./vault');

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
    status TEXT NOT NULL DEFAULT 'draft',  -- draft | sending | sent | cancelled | failed
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  );
`);
// Nothing is in flight at startup: a row left 'sending' by a crash mid-send is marked failed (never resent, it may have gone out).
db.prepare("UPDATE outbox SET status = 'failed' WHERE status = 'sending'").run();

const toChatId = (phone) => {
  let d = String(phone).replace(/\D/g, '');
  if (d.startsWith('0')) d = CC + d.replace(/^0+/, '');
  return d.length >= 8 && d.length <= 15 ? { chatId: `${d}@c.us`, digits: d } : null;
};

// "94771234567" -> "+94 77 123 4567" (Sri Lankan mobile layout); other numbers as "+<digits>". Shown in every draft preview.
const formatPhone = (digits) => {
  const d = String(digits || '').replace(/\D/g, '');
  return /^94\d{9}$/.test(d) ? `+94 ${d.slice(2, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : `+${d}`;
};

// A Private/People note whose person only ever wrote to the BOT's number (or filled in the intake form) carries a name that person
// chose themselves, so it must not decide who "message <name>" goes to. Marked going forward by memory.js / intake.js ("origin: bot");
// for older notes: an intake note ("source: form") or a phone seen in the inbox only from the bot number ('bot' / 'bot-auto').
function botOnlyPhone(phone) {
  const last9 = String(phone || '').replace(/\D/g, '').slice(-9);
  if (last9.length < 7) return false;
  try {
    // A number the owner chose to send the intake form to (/intake send) is the owner's own contact, not a bot-only stranger.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'intake_invites'").get()
      && db.prepare("SELECT 1 FROM intake_invites WHERE status = 'sent' AND substr(phone, -9) = ? LIMIT 1").get(last9)) return false;
    const rows = db.prepare("SELECT DISTINCT source FROM inbox_messages WHERE substr(phone, -9) = ? OR chat_id LIKE ?").all(last9, `%${last9}@c.us`);
    return rows.length > 0 && rows.every((r) => r.source === 'bot' || r.source === 'bot-auto');
  } catch { return false; }
}
const fromBotOnly = (head, phone) => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(head)?.[1] || '';
  return /^origin:[ \t]*bot\b/m.test(fm) || /^source:[ \t]*form\b/m.test(fm) || botOnlyPhone(phone);
};

// Names and phone numbers from Private/People, read here in code only. The AI never sees these notes or their names:
// it passes along the name the owner typed, and only a phone number comes back out of this lookup.
async function privateContacts() {
  const out = [];
  for (const f of await files.walkAll()) {
    if (!files.rel(f).startsWith('Private/People/')) continue;
    const head = (await fs.readFile(f, 'utf8')).slice(0, 800);
    const phone = /^phone:[ \t]*(\S.*?)[ \t]*$/m.exec(head)?.[1];
    if (phone && !fromBotOnly(head, phone)) out.push({ name: files.titleOf(f), phone });
  }
  return out;
}

async function resolve(to) {
  const raw = String(to || '').trim();
  if (/^\+?[\d\s()-]{7,}$/.test(raw)) {
    const r = toChatId(raw);
    return r ? { ...r, name: `+${r.digits}` } : { error: `"${raw}" doesn't look like a valid phone number.` };
  }
  const { results = [] } = await contacts.findContact({ query: raw });
  const named = results.filter((c) => c.phone && c.name.toLowerCase().includes(raw.toLowerCase()));
  // A real name match in Private/People beats a loose People/ hit (e.g. the shared word "Test" or a relationship word).
  if (!named.length) {
    const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = (await privateContacts()).filter((c) => words.every((w) => c.name.toLowerCase().includes(w)));
    const exact = hits.filter((c) => c.name.toLowerCase() === raw.toLowerCase());
    const one = exact.length === 1 ? exact : hits;
    if (one.length === 1) {
      const r = toChatId(one[0].phone);
      return r ? { ...r, name: one[0].name } : { error: 'The saved phone number for that person looks invalid.' };
    }
    if (one.length > 1) return { error: `${one.length} saved contacts match "${raw}". Ask the owner for the full name or the phone number.` };
  }
  const pool = named.length ? named : results.filter((c) => c.phone).slice(0, 1);
  if (!pool.length) return { error: `No contact with a phone number matches "${raw}". Ask the owner for the number, or to save the contact first.` };
  if (pool.length > 1) return { error: `Several contacts match "${raw}": ${pool.map((c) => c.name).join(', ')}. Ask the owner which one.` };
  const r = toChatId(pool[0].phone);
  return r ? { ...r, name: pool[0].name } : { error: `${pool[0].name}'s saved phone number looks invalid.` };
}

// Counts messages being sent right now too, so two quick yeses can't both pass the limit.
const sentToday = () => db.prepare("SELECT COUNT(*) n FROM outbox WHERE (status = 'sent' AND sent_at > ?) OR (status = 'sending' AND created_at > ?)").get(Date.now() - 86_400_000, Date.now() - 86_400_000).n;

async function createDraft({ to, text }, ctx) {
  text = String(text || '').trim();
  if (!text) return { error: 'The message text is empty.' };
  if (text.length > 1500) return { error: 'Message too long (max 1500 characters).' };
  const r = await resolve(to);
  if (r.error) return r;
  if (OWNERS.includes(r.digits)) return { error: "That's the owner's own number. Just tell them directly." };
  db.prepare("UPDATE outbox SET status = 'cancelled' WHERE owner_chat = ? AND status = 'draft'").run(ctx.chatId);
  require('./mailout').discard(ctx.chatId); // only one pending "yes" at a time: a new WhatsApp draft replaces a waiting email
  require('./intake').discardInvites(ctx.chatId); // ...and a waiting intake invite (lazy: intake.js requires this file)
  db.prepare('INSERT INTO outbox (owner_chat, session_id, to_name, to_chat, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ctx.chatId, ctx.sessionId, r.name, r.chatId, text, Date.now());
  return { ok: true, status: 'draft_awaiting_owner_confirmation', to: String(to).trim(), note: 'NOT sent. The system shows the owner the draft and sends only after they reply yes. Do not say it was sent.' };
}

// Has the bot ever sent (with the owner's yes) a message to this phone number? Used to recognise replies.
const hasSentTo = (phoneDigits) => Boolean(phoneDigits)
  && Boolean(db.prepare("SELECT 1 FROM outbox WHERE status = 'sent' AND to_chat = ? LIMIT 1").get(`${String(phoneDigits).replace(/\D/g, '')}@c.us`));

function pendingDraft(ownerChat) {
  const d = db.prepare("SELECT * FROM outbox WHERE owner_chat = ? AND status = 'draft' ORDER BY id DESC LIMIT 1").get(ownerChat);
  if (!d) return null;
  if (Date.now() - d.created_at > DRAFT_TTL_MS) {
    db.prepare("UPDATE outbox SET status = 'cancelled' WHERE id = ?").run(d.id);
    return null;
  }
  return d;
}

// Always shows the exact number the message would go to, plus a warning when that contact's number was changed in the last 7 days.
function draftPreview(d) {
  const number = formatPhone(d.to_chat.split('@')[0]);
  const who = /^\+\d+$/.test(d.to_name) ? number : `${d.to_name} (${number})`;
  const changed = /^\+\d+$/.test(d.to_name) ? null : contacts.recentChange(d.to_name).phone;
  const warn = changed ? `\n\n⚠️ ${d.to_name}'s number was changed ${new Date(changed).toLocaleDateString('en-GB', { timeZone: process.env.TZ || 'Asia/Colombo', day: 'numeric', month: 'short' })} (in the last 7 days). Check it is right before you say yes.` : '';
  return `📨 *Draft to ${who}:*\n"${d.text}"${warn}\n\nReply *yes* to send, *no* to cancel, or tell me what to change.`;
}

// send(sessionId, chatId, text) is index.js's sendText. Returns the reply for the owner.
async function confirm(ownerChat, send) {
  const d = pendingDraft(ownerChat);
  if (!d) return sending(ownerChat) ? 'That message is already being sent.' : null;
  // Claim the draft before the network call: a second "yes" arriving while OpenWA is still answering finds nothing to send.
  if (db.prepare("UPDATE outbox SET status = 'sending' WHERE id = ? AND status = 'draft'").run(d.id).changes !== 1) return 'That message is already being sent.';
  if (sentToday() - 1 >= DAILY_LIMIT) { // minus this one, which is now 'sending'
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
  try { // remember it as the owner's own reply, so /pending and the alerts know that chat was answered
    require('./inbox').insertRaw({ msg_id: `bot-owner-${d.id}`, chat_id: d.to_chat, chat_name: d.to_name, sender: 'Me', is_group: false, ts: Date.now(), type: 'text', text: d.text, seen: true, from_me: true, phone: d.to_chat.split('@')[0], source: 'bot-owner' });
  } catch (e) { console.warn('[outbox] not recorded in inbox:', e.message); }
  console.log(`[outbox] sent #${d.id} to ${d.to_name}`);
  return `✅ Sent to ${d.to_name}.`;
}

function cancel(ownerChat) {
  const d = pendingDraft(ownerChat);
  if (!d) return null;
  db.prepare("UPDATE outbox SET status = 'cancelled' WHERE id = ?").run(d.id);
  return `Cancelled. Nothing was sent to ${d.to_name}.`;
}

// The AI turn failed after drafting: the owner never saw the preview, so the draft must not stay waiting for a yes. Returns how many.
const discardSince = (ownerChat, since) => Number(db.prepare("UPDATE outbox SET status = 'cancelled' WHERE owner_chat = ? AND status = 'draft' AND created_at >= ?").run(ownerChat, since).changes);
// A draft of this chat is being handed to OpenWA right now (claimed by a yes).
const sending = (ownerChat) => Boolean(db.prepare("SELECT 1 FROM outbox WHERE owner_chat = ? AND status = 'sending' LIMIT 1").get(ownerChat));

module.exports = { createDraft, hasSentTo, pendingDraft, draftPreview, confirm, cancel, discardSince, sending, formatPhone, resolve };
