// Sending email from the owner's Gmail, behind the same confirm step as outbox.js.
// The AI can only QUEUE an email (send_email). index.js sends it only when the owner types yes, checked here in code
// before the AI sees the message, so text inside an email or note can never trigger a send.
// Email content is untrusted (prompt injection). If an email was read in this turn (or recently in this chat), the
// recipient must be the sender of the email being replied to or an address in People/ contacts; any other address must
// be typed back by the owner ("yes <address>"). The owner always sees the exact recipient, subject and full body.
// Off unless GMAIL_SEND_ENABLED=true (and the refresh token has the gmail.send scope, see google-auth.js).
const db = require('./db');
const google = require('./google');
const gmail = require('./gmail');
const contacts = require('./contacts');

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DAILY_LIMIT = Number(process.env.EMAIL_DAILY_LIMIT || 5);
const TTL_MS = 15 * 60_000;
const TAINT_MS = 2 * 3_600_000; // an email read this long ago may still be in the chat history the AI sees
const MAX_RECIPIENTS = 5;
const MAX_BODY = 10_000;
const MAX_SUBJECT = 250;

const enabled = () => gmail.enabled() && /^(1|true|yes)$/i.test(process.env.GMAIL_SEND_ENABLED || '');

db.exec(`
  CREATE TABLE IF NOT EXISTS email_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_chat TEXT NOT NULL,
    to_addr TEXT NOT NULL,          -- comma-separated bare addresses
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    thread_id TEXT,
    in_reply_to TEXT,
    refs TEXT,
    reply_subject TEXT,             -- subject of the email being answered, for the preview
    unverified TEXT,                -- addresses the owner must type back, comma-separated ('' = none)
    status TEXT NOT NULL DEFAULT 'draft',  -- draft | sent | cancelled | expired | failed
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    gmail_id TEXT
  );
`);

const ADDR = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
// "Name <a@b.c>" or "a@b.c" -> "a@b.c" (lowercased), else null
function bareAddress(s) {
  const t = String(s || '').trim();
  const m = /<([^<>\s]+)>\s*$/.exec(t);
  const a = (m ? m[1] : t).trim().toLowerCase();
  return ADDR.test(a) && a.length <= 254 ? a : null;
}

// Called by the search_emails / read_email tools: this turn (ctx) and this chat now carry untrusted email text.
function markRead(ctx) {
  if (!ctx) return;
  ctx.emailRead = true;
  if (ctx.chatId) db.setKv(`email_read_at:${ctx.chatId}`, Date.now());
}
const tainted = (ctx) => Boolean(ctx?.emailRead) || Date.now() - Number(db.getKv(`email_read_at:${ctx?.chatId}`) || 0) < TAINT_MS;

async function contactEmails() {
  const set = new Set();
  for (const c of await contacts.allContacts()) for (const e of String(c.email || '').split(/[,;\s]+/)) { const a = bareAddress(e); if (a) set.add(a); }
  return set;
}

// RFC 2047 encoded-words for non-ASCII header text; each word <= 75 chars, folded onto continuation lines.
function encodeHeader(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = [];
  let chunk = '';
  for (const ch of Array.from(s)) { // never split a UTF-8 character across words
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}
const msgIds = (s) => (String(s || '').match(/<[^<>\s]+@[^<>\s]+>/g) || []);

function buildRaw(e) {
  const lines = [`To: ${e.to_addr}`, `Subject: ${encodeHeader(e.subject)}`];
  if (e.in_reply_to) lines.push(`In-Reply-To: ${e.in_reply_to}`);
  if (e.refs) lines.push(`References: ${e.refs}`);
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(e.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'));
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

const sentToday = () => db.prepare("SELECT COUNT(*) n FROM email_outbox WHERE status = 'sent' AND sent_at > ?").get(Date.now() - 86_400_000).n;

// Tool handler. Validates everything in code; the AI's text is never trusted for headers.
async function queue({ to, subject, body, reply_to_id } = {}, ctx) {
  if (!enabled()) return { error: 'Sending email is not enabled.' };
  if (!ctx?.chatId) return { error: 'No chat context.' };
  body = String(body ?? '').trim();
  if (!body) return { error: 'The email body is empty.' };
  if (body.length > MAX_BODY) return { error: `Email body too long (max ${MAX_BODY} characters).` };
  if (/[\r\n]/.test(String(to ?? '')) || /[\r\n]/.test(String(subject ?? ''))) return { error: 'Recipient and subject must be a single line (no line breaks).' };
  subject = String(subject ?? '').trim();
  if (subject.length > MAX_SUBJECT) return { error: `Subject too long (max ${MAX_SUBJECT} characters).` };

  let thread = null;
  if (reply_to_id) {
    const o = await google.api(`${BASE}/messages/${encodeURIComponent(String(reply_to_id))}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`);
    const h = (n) => String(o.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || '').replace(/[\r\n]+/g, ' ').trim();
    const mid = msgIds(h('Message-ID'))[0] || '';
    thread = { id: o.threadId, from: bareAddress(h('From')), replyTo: bareAddress(h('Reply-To')), subject: h('Subject'), mid, refs: [...msgIds(h('References')), ...(mid ? [mid] : [])].slice(-20).join(' ') };
    if (!to) to = thread.replyTo || thread.from;
    if (!subject) subject = /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`.trim();
    if (/[\r\n]/.test(subject)) return { error: 'Bad subject.' };
    subject = subject.slice(0, MAX_SUBJECT);
  }
  if (!to) return { error: 'Need a recipient address (to), or reply_to_id to answer an email.' };
  if (!subject) return { error: 'Need a subject.' };
  if (/\b(cc|bcc)\s*:/i.test(String(to))) return { error: 'Only plain To: addresses are allowed (no cc/bcc).' };
  const parts = String(to).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > MAX_RECIPIENTS) return { error: `Too many recipients (max ${MAX_RECIPIENTS}).` };
  const addrs = [];
  for (const p of parts) {
    const a = bareAddress(p);
    if (!a) return { error: `"${p.slice(0, 80)}" is not a valid email address.` };
    if (!addrs.includes(a)) addrs.push(a);
  }
  if (!addrs.length) return { error: 'Need a recipient address.' };

  // Injection defence: after reading email, only the replied-to sender or a saved contact is trusted.
  let unverified = [];
  if (tainted(ctx)) {
    const known = await contactEmails();
    if (thread?.from) known.add(thread.from);
    unverified = addrs.filter((a) => !known.has(a));
  }

  db.prepare("UPDATE email_outbox SET status = 'cancelled' WHERE owner_chat = ? AND status = 'draft'").run(ctx.chatId);
  try { db.prepare("UPDATE outbox SET status = 'cancelled' WHERE owner_chat = ? AND status = 'draft'").run(ctx.chatId); } catch {} // one pending "yes" at a time
  db.prepare('INSERT INTO email_outbox (owner_chat, to_addr, subject, body, thread_id, in_reply_to, refs, reply_subject, unverified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ctx.chatId, addrs.join(', '), subject, body, thread?.id || null, thread?.mid || null, thread?.refs || null, thread ? thread.subject.slice(0, 200) : null, unverified.join(', '), Date.now());
  return { ok: true, status: 'queued_awaiting_owner_confirmation', to: addrs.join(', '), note: 'NOT sent. The system shows the owner the exact email and sends only after they reply yes. Do not say it was sent.' };
}

function pending(ownerChat) {
  const e = db.prepare("SELECT * FROM email_outbox WHERE owner_chat = ? AND status = 'draft' ORDER BY id DESC LIMIT 1").get(ownerChat);
  if (!e) return null;
  if (Date.now() - e.created_at > TTL_MS) {
    db.prepare("UPDATE email_outbox SET status = 'expired' WHERE id = ?").run(e.id);
    return null;
  }
  return e;
}

function preview(e) {
  const warn = e.unverified
    ? `\n\n⚠️ *Check the address:* ${e.unverified} is not the sender you're replying to and not in your contacts, and I read email in this chat (email text can try to trick me). To send anyway, type *yes ${e.unverified.split(', ')[0]}*${e.unverified.includes(',') ? ' followed by every address listed' : ''}.`
    : '';
  return `📧 *Email ready to send*\n*To:* ${e.to_addr}\n*Subject:* ${e.subject}${e.thread_id ? `\n_(reply in the thread "${e.reply_subject || ''}")_` : ''}\n\n${e.body}${warn}\n\nReply *yes* to send, *no* to cancel, or tell me what to change. Expires in 15 min.`;
}

async function send(e) {
  if (sentToday() >= DAILY_LIMIT) {
    db.prepare("UPDATE email_outbox SET status = 'cancelled' WHERE id = ?").run(e.id);
    return `Daily email limit reached (${DAILY_LIMIT} per 24h). Draft discarded.`;
  }
  try {
    const r = await google.api(`${BASE}/messages/send`, { method: 'POST', body: { raw: buildRaw(e), ...(e.thread_id ? { threadId: e.thread_id } : {}) } });
    db.prepare("UPDATE email_outbox SET status = 'sent', sent_at = ?, gmail_id = ? WHERE id = ?").run(Date.now(), r?.id || null, e.id);
  } catch (err) {
    db.prepare("UPDATE email_outbox SET status = 'failed' WHERE id = ?").run(e.id);
    console.error('[mailout] send failed:', err.message);
    return `Couldn't send the email: ${err.message.slice(0, 160)}${/403|insufficient/i.test(err.message) ? '\n(The Google token may lack the gmail.send scope: re-run google-auth.js.)' : ''}`;
  }
  console.log(`[mailout] sent #${e.id}`);
  return `✅ Email sent to ${e.to_addr}.`;
}

// The owner's typed reply while an email is pending. Returns the answer for the owner, or null (not a yes/no).
async function handleReply(ownerChat, text) {
  const e = pending(ownerChat);
  if (!e) return null;
  const t = String(text || '').trim().toLowerCase().replace(/[.!\s]+$/g, '');
  if (/^(no|n|cancel|discard|don'?t send|stop)$/.test(t)) {
    db.prepare("UPDATE email_outbox SET status = 'cancelled' WHERE id = ?").run(e.id);
    return 'Cancelled. The email was not sent.';
  }
  const m = /^(?:yes|y|yep|send|send it|confirm|yes send|ok send|go ahead)(?:\s+(.+))?$/.exec(t);
  if (!m) return null;
  if (e.unverified) {
    const typed = new Set(String(m[1] || '').split(/[\s,;]+/).map(bareAddress).filter(Boolean));
    const need = e.unverified.split(', ');
    if (!need.every((a) => typed.has(a))) return `Not sent. ${need.join(', ')} is a new address, so type *yes ${need.join(' ')}* to confirm it, or *no* to cancel.`;
  } else if (m[1] && m[1] !== 'please') return null; // "yes but change X": let the AI handle it
  return send(e);
}

function cancel(ownerChat) {
  const e = pending(ownerChat);
  if (!e) return null;
  db.prepare("UPDATE email_outbox SET status = 'cancelled' WHERE id = ?").run(e.id);
  return `Cancelled. Nothing was sent to ${e.to_addr}.`;
}

// /email: show or cancel the waiting email. Nothing here involves the AI.
function command(args, ownerChat) {
  if (!enabled()) return 'Sending email is off (set GMAIL_SEND_ENABLED=true after re-running google-auth.js).';
  if (/^(cancel|no|clear)$/i.test(String(args || '').trim())) return cancel(ownerChat) || 'No email is waiting.';
  const e = pending(ownerChat);
  const head = `Emails sent in the last 24h: ${sentToday()}/${DAILY_LIMIT}.`;
  return e ? `${preview(e)}\n\n${head}` : `No email is waiting for your yes.\n${head}`;
}

// Used by outbox.js so a new WhatsApp draft replaces a waiting email (only one "yes" can be pending).
const discard = (ownerChat) => db.prepare("UPDATE email_outbox SET status = 'cancelled' WHERE owner_chat = ? AND status = 'draft'").run(ownerChat);

module.exports = { enabled, markRead, queue, pending, preview, handleReply, cancel, command, discard, encodeHeader, buildRaw, bareAddress };
