// Gmail: search / read / draft. Deliberately no "send": drafts land in Gmail for the owner to review and send.
// Results are trimmed to keep Gemini tokens low. Needs the gmail scopes in google-auth.js (re-run it once).
const google = require('./google');

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const enabled = () => google.enabled() && /^(1|true|yes)$/i.test(process.env.GMAIL_ENABLED || '');

const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim(); // no header injection
const b64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

function summary(m) {
  return {
    id: m.id,
    from: header(m, 'From'),
    subject: header(m, 'Subject') || '(no subject)',
    date: header(m, 'Date'),
    snippet: (m.snippet || '').slice(0, 160),
    ...(m.labelIds?.includes('UNREAD') ? { unread: true } : {}),
  };
}

async function searchEmails({ query = 'in:inbox', limit = 10 } = {}) {
  const max = Math.min(Math.max(Number(limit) || 10, 1), 20);
  const list = await google.api(`${BASE}/messages?${new URLSearchParams({ q: query, maxResults: max })}`);
  const msgs = await Promise.all((list.messages || []).map((m) =>
    google.api(`${BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
  return { emails: msgs.map(summary), count: msgs.length };
}

// Pull readable text out of a MIME tree: prefer text/plain, fall back to stripped HTML.
function bodyText(part) {
  const found = { plain: '', html: '', files: [] };
  (function walk(p) {
    if (p.filename) found.files.push(p.filename);
    if (p.body?.data && p.mimeType === 'text/plain') found.plain += b64(p.body.data);
    else if (p.body?.data && p.mimeType === 'text/html') found.html += b64(p.body.data);
    (p.parts || []).forEach(walk);
  })(part);
  const text = found.plain || found.html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), files: found.files };
}

async function readEmail({ id }) {
  if (!id) throw new Error('id is required (get it from search_emails)');
  const m = await google.api(`${BASE}/messages/${encodeURIComponent(id)}?format=full`);
  const { text, files } = bodyText(m.payload || {});
  return {
    ...summary(m),
    to: header(m, 'To'),
    body: text.length > 4000 ? text.slice(0, 4000) + '\n[truncated]' : text,
    ...(files.length ? { attachments: files } : {}),
  };
}

// RFC 2047 encoded-word for non-ASCII subjects.
const encSubject = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

// New draft, or a threaded reply draft when reply_to_id is given.
async function createDraft({ to, subject, body, reply_to_id }) {
  if (!body) throw new Error('body is required');
  const lines = [];
  let threadId;
  if (reply_to_id) {
    const o = await google.api(`${BASE}/messages/${encodeURIComponent(reply_to_id)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`);
    threadId = o.threadId;
    const subj = header(o, 'Subject');
    to = to || header(o, 'Reply-To') || header(o, 'From');
    subject = subject || (/^re:/i.test(subj) ? subj : `Re: ${subj}`);
    const mid = header(o, 'Message-ID');
    if (mid) lines.push(`In-Reply-To: ${clean(mid)}`, `References: ${clean(`${header(o, 'References')} ${mid}`)}`);
  }
  if (!to) throw new Error('to is required for a new email');
  const raw = [
    `To: ${clean(to)}`,
    `Subject: ${encSubject(clean(subject))}`,
    ...lines,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
  ].join('\r\n');
  const d = await google.api(`${BASE}/drafts`, {
    method: 'POST',
    body: { message: { raw: Buffer.from(raw).toString('base64url'), ...(threadId ? { threadId } : {}) } },
  });
  return { ok: true, draft_id: d.id, to: clean(to), subject: clean(subject), note: 'Saved as a draft in Gmail. The owner must review and send it there.' };
}

// Cheap overview for the morning briefing: recent unread inbox mail, no AI involved.
async function unreadDigest(limit = 5) {
  const { emails } = await searchEmails({ query: 'is:unread in:inbox newer_than:1d category:primary', limit });
  return emails;
}

module.exports = { enabled, searchEmails, readEmail, createDraft, unreadDigest };
