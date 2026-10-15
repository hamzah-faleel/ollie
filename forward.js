// Forwards messages that reach the BOT's own number from other people straight to the owner. No AI involved, and the bot never answers
// the sender: this only relays text to the owner's chat. Messages are also stored in the inbox (source 'bot') so they join the memory.
// Modes (/forward): replies = only people the bot has messaged for the owner (default) | all = every direct message | off = store only.
// Rate limits stop a flood (or a loop) from spamming the owner: per sender and overall, per hour.
const db = require('./db');
const outbox = require('./outbox');
const inbox = require('./inbox');

const MODES = ['replies', 'all', 'off'];
const PER_SENDER = Number(process.env.FORWARD_PER_SENDER_HOUR || 10);
const TOTAL = Number(process.env.FORWARD_TOTAL_HOUR || 60);
const HOUR = 3_600_000;

const mode = () => { const m = db.getKv('forward_mode') || (process.env.FORWARD_MODE || 'replies').toLowerCase(); return MODES.includes(m) ? m : 'replies'; };
const setMode = (m) => { if (!MODES.includes(m)) return false; db.setKv('forward_mode', m); return true; };

const sentAt = new Map();   // sender key -> timestamps of forwards in the last hour
const total = [];           // timestamps of all forwards in the last hour
const noticed = new Map();  // key -> when we last said "held back"
const recent = (arr) => { const cut = Date.now() - HOUR; while (arr.length && arr[0] < cut) arr.shift(); return arr; };

const clean = (t) => String(t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 1500);

// msg: the webhook's data object from the BOT session. send(text) delivers to the owner. Returns true if the message was handled (stored).
async function handle(msg, send) {
  const rec = inbox.ingestBot(msg);
  if (!rec) return false;
  const m = mode();
  if (m === 'off') return true;
  if (m === 'replies' && !outbox.hasSentTo(rec.phone)) return true;

  const key = rec.phone || String(msg.chatId);
  const mine = recent(sentAt.get(key) || sentAt.set(key, []).get(key));
  const all = recent(total);
  if (mine.length >= PER_SENDER || all.length >= TOTAL) {
    if (Date.now() - (noticed.get(key) || 0) > HOUR) { // one heads-up per sender per hour, never a flood
      noticed.set(key, Date.now());
      await send(`⚠️ Holding back messages from ${rec.name}: too many in the last hour (limit ${mine.length >= PER_SENDER ? PER_SENDER + ' per person' : TOTAL + ' overall'}). They are stored, not lost.`).catch(() => {});
    }
    return true;
  }
  mine.push(Date.now()); all.push(Date.now());
  await send(`↩️ *${clean(rec.name).slice(0, 60)}*${rec.phone ? ` (+${rec.phone})` : ''}:\n${clean(rec.text)}`).catch((e) => console.warn('[forward] failed:', e.message));
  return true;
}

const describe = () => {
  const m = mode();
  return `*Forwarding*\nMode: *${m}* - ${{ replies: 'replies from people I have messaged for you', all: 'every direct message to my number', off: 'nothing is forwarded (messages are still stored)' }[m]}.\n`
    + `Limits: ${PER_SENDER} per person and ${TOTAL} overall per hour. I never answer them.\n/forward replies | /forward all | /forward off`;
};

module.exports = { handle, mode, setMode, describe };
