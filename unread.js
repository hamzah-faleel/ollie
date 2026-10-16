// Unread detection for the owner's PERSONAL WhatsApp. No AI, GET only, never marks anything read.
// How: OpenWA has no read-state event for incoming messages (message.ack is only for messages WE sent), so the only signal is the live
// `unreadCount` on GET /api/sessions/:id/chats. This polls that list (read-only key, short cache) on demand: /unread, the briefing, /pending
// and the VIP alert. The owner opening a chat on their phone resets the count, which is exactly the "read" signal wanted.
// Limits: the count is only as good as the engine (Baileys rebuilds the list after a restart, so a 1:1 chat can be missing until its next message).
const db = require('./db');
const inbox = require('./inbox');

const URL_ = (process.env.OPENWA_URL || 'http://openwa-api:2785').replace(/\/$/, '');
const KEY = () => (process.env.OPENWA_PERSONAL_KEY || '').trim();
const SESSION = () => (process.env.PERSONAL_SESSION_ID || '').trim();
const CACHE_MS = Number(process.env.UNREAD_CACHE_SEC || 60) * 1000;
const SKIP_KINDS = ['status', 'broadcast', 'channel'];

const digits = inbox.digits;
const preview = (t, n = 70) => inbox.redact(String(t || '')).replace(/\s+/g, ' ').trim().slice(0, n);
const age = (ts) => { const m = Math.max(1, Math.round((Date.now() - ts) / 60_000)); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const tsMs = (t) => { const n = Number(t); return n ? (n < 1e12 ? n * 1000 : n) : 0; };

// GET only. The single place this file talks to OpenWA.
async function fetchChats() {
  if (!SESSION() || !KEY()) throw new Error('unread detection needs PERSONAL_SESSION_ID and OPENWA_PERSONAL_KEY');
  const res = await fetch(`${URL_}/api/sessions/${encodeURIComponent(SESSION())}/chats?limit=300`, { method: 'GET', headers: { 'X-API-Key': KEY() }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(/not started/i.test(body) || res.status === 400 || res.status === 409 ? 'The personal WhatsApp session is not running right now.' : `chat list -> ${res.status}`);
  }
  const j = await res.json();
  return Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : []);
}

// Pure: a ChatSummary[] -> the unread list, oldest first. `incoming(chatId, n)` may supply stored incoming timestamps to age the oldest unread message.
function parse(chats, { incoming = () => [], isVip = () => false } = {}) {
  const out = [];
  for (const c of chats || []) {
    const count = Math.floor(Number(c.unreadCount));
    if (!(count > 0) || c.archived || SKIP_KINDS.includes(c.kind) || /@(broadcast|newsletter)$/.test(String(c.id)) || /^status@/.test(String(c.id))) continue;
    const isGroup = Boolean(c.isGroup) || c.kind === 'group' || /@g\.us$/.test(String(c.id));
    if (isGroup && c.muted) continue;                                          // muted groups are noise by the owner's own choice
    const last = tsMs(c.timestamp) || Date.now();
    const stored = incoming(String(c.id), count);                              // newest first
    const since = stored.length >= count ? stored[count - 1] : last;           // oldest unread: Nth-newest stored incoming message, else the last message time
    const phone = /@(c\.us|s\.whatsapp\.net)$/.test(String(c.id)) ? digits(String(c.id).split('@')[0]) : '';
    const name = String(c.name || '').trim() || (phone ? `+${phone}` : String(c.id).split('@')[0]);
    out.push({ id: String(c.id), name, count, isGroup, muted: Boolean(c.muted), last, since: Math.min(since, last), phone, preview: preview(c.lastMessage), vip: !isGroup && isVip(phone, name) });
  }
  return out.sort((a, b) => a.since - b.since);
}

const storedIncoming = (id, n) => db.prepare('SELECT ts FROM inbox_messages WHERE chat_id = ? AND from_me = 0 ORDER BY ts DESC LIMIT ?').all(id, n).map((r) => r.ts);

let cache = { at: 0, chats: null };
async function chats(force) {
  if (!force && cache.chats && Date.now() - cache.at < CACHE_MS) return cache.chats;
  cache = { at: Date.now(), chats: await fetchChats() };
  return cache.chats;
}
const resetCache = () => { cache = { at: 0, chats: null }; };

async function list({ force = false, isVip } = {}) {
  return parse(await chats(force), { incoming: storedIncoming, isVip });
}

async function unreadText(limit = 15) {
  let items;
  try { items = await list({ force: true }); } catch (e) { return `I couldn't read your chat list (${e.message}).`; }
  if (!items.length) return 'No unread chats. (Counts come from WhatsApp itself; I never mark anything as read.)';
  const total = items.reduce((s, i) => s + i.count, 0);
  return `*Unread* - ${items.length} chat${items.length === 1 ? '' : 's'}, ${total} message${total === 1 ? '' : 's'}\n`
    + items.slice(0, limit).map((i) => `- ${i.name}${i.isGroup ? ' (group)' : ''}: ${i.count} unread, ${age(i.since)}${i.preview ? ` - "${i.preview}"` : ''}`).join('\n')
    + (items.length > limit ? `\n...and ${items.length - limit} more` : '');
}

// /pending with the unread / read-but-unanswered distinction. Falls back to the plain list if the chat list is unavailable.
async function pendingText(limit = 15) {
  let { items, sawOwnReplies } = inbox.pending();
  if (items.some((i) => i.unsure)) { await inbox.refine(items); ({ items, sawOwnReplies } = inbox.pending()); }
  let unread = null;
  try { unread = new Map((await list()).map((u) => [u.id, u])); } catch { /* plain list */ }
  const tagged = items.map((i) => ({ ...i, unread: unread ? unread.has(i.chat_id) : null }));
  if (unread === null || !tagged.length) return inbox.pendingText(limit);
  const line = (i) => `- ${i.name}: ${i.count > 1 ? i.count + ' messages, ' : ''}waiting ${age(i.since)}${i.preview ? ` - "${i.preview}"` : ''}`;
  const a = tagged.filter((i) => i.unread), b = tagged.filter((i) => !i.unread);
  let out = `*Waiting for your reply* (${tagged.length})`;
  if (a.length) out += `\n_Unread_\n${a.slice(0, limit).map(line).join('\n')}`;
  if (b.length) out += `\n_Read, not answered_\n${b.slice(0, limit).map(line).join('\n')}`;
  return out + (sawOwnReplies ? '' : '\n\n(Heads up: I have not seen any replies you sent, so this may include chats you already answered. Add message.sent to the personal webhook.)');
}

// Morning briefing section body (null = nothing to show). Throws if the chat list is unavailable so the caller's section() can skip it.
async function briefingLines(limit = 5) {
  const items = await list();
  if (!items.length) return null;
  return items.slice(0, limit).map((i) => `- ${i.name}${i.isGroup ? ' (group)' : ''}: ${i.count} unread, ${age(i.since)}`).join('\n') + (items.length > limit ? `\n- ...and ${items.length - limit} more (/unread)` : '');
}

module.exports = { parse, list, unreadText, pendingText, briefingLines, fetchChats, resetCache, age };
