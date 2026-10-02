// SQLite storage for chat history and reminders (notes live as Markdown in the vault).
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || '/data/bot.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,            -- 'user' | 'model'
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    text TEXT NOT NULL,
    due_at INTEGER NOT NULL,       -- epoch ms
    repeat TEXT NOT NULL DEFAULT 'none',  -- none | daily | weekly | monthly
    status TEXT NOT NULL DEFAULT 'pending', -- pending | done | cancelled
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);
`);

const q = {
  addMsg: db.prepare('INSERT INTO messages (chat_id, role, text) VALUES (?, ?, ?)'),
  recentMsgs: db.prepare('SELECT role, text FROM (SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'),
  clearMsgs: db.prepare('DELETE FROM messages WHERE chat_id = ?'),
  pruneMsgs: db.prepare('DELETE FROM messages WHERE chat_id = ? AND id NOT IN (SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 500)'),

  addRem: db.prepare('INSERT INTO reminders (session_id, chat_id, text, due_at, repeat) VALUES (?, ?, ?, ?, ?)'),
  pendingRems: db.prepare("SELECT * FROM reminders WHERE chat_id = ? AND status = 'pending' ORDER BY due_at ASC LIMIT 50"),
  dueRems: db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT 20"),
  getRem: db.prepare('SELECT * FROM reminders WHERE id = ? AND chat_id = ?'),
  setStatus: db.prepare('UPDATE reminders SET status = ? WHERE id = ?'),
  setDue: db.prepare('UPDATE reminders SET due_at = ? WHERE id = ?'),
};

module.exports = {
  addMessage(chatId, role, text) {
    q.addMsg.run(chatId, role, text);
    q.pruneMsgs.run(chatId, chatId);
  },
  recentMessages: (chatId, limit) => q.recentMsgs.all(chatId, limit),
  clearMessages: (chatId) => q.clearMsgs.run(chatId),

  addReminder: (sessionId, chatId, text, dueAt, repeat = 'none') =>
    Number(q.addRem.run(sessionId, chatId, text, dueAt, repeat).lastInsertRowid),
  pendingReminders: (chatId) => q.pendingRems.all(chatId),
  dueReminders: (now) => q.dueRems.all(now),
  getReminder: (id, chatId) => q.getRem.get(id, chatId),
  setReminderStatus: (id, status) => q.setStatus.run(status, id),
  setReminderDue: (id, dueAt) => q.setDue.run(dueAt, id),
};
