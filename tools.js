// Tools the AI can call. Each has a declaration (shown to Gemini) and a handler (runs here).
const db = require('./db');
const vault = require('./vault');

const TZ = process.env.TZ || 'Asia/Colombo';
const fmt = (ms) => new Date(ms).toLocaleString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const S = (description, extra = {}) => ({ type: 'STRING', description, ...extra });

const declarations = [
  {
    name: 'set_reminder',
    description: 'Schedule a WhatsApp reminder to the owner. Use in_minutes for relative times ("in 20 minutes", "in 2 hours") and due_at for clock times or dates.',
    parameters: {
      type: 'OBJECT',
      properties: {
        text: S('What to remind about, phrased as the reminder message, e.g. "Call the client about the invoice"'),
        due_at: S('Absolute time in ISO 8601 WITH the timezone offset, e.g. 2026-10-02T16:00:00+05:30'),
        in_minutes: { type: 'NUMBER', description: 'Minutes from now. Use instead of due_at for relative times.' },
        repeat: S('Repeat schedule', { enum: ['none', 'daily', 'weekly', 'monthly'] }),
      },
      required: ['text'],
    },
  },
  {
    name: 'list_reminders',
    description: 'List the owner\'s upcoming reminders with their ids.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel a reminder by id. Call list_reminders first if you do not know the id.',
    parameters: { type: 'OBJECT', properties: { id: { type: 'NUMBER', description: 'Reminder id' } }, required: ['id'] },
  },
  {
    name: 'save_note',
    description: 'Save information to the owner\'s second brain (an Obsidian vault of Markdown notes). Use for ideas, meeting notes, facts to remember, lists. If a note with the same title exists, the content is appended to it.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: S('Short, specific note title, e.g. "Cartivate shoot ideas"'),
        content: S('The note body in Markdown. Keep the owner\'s details; tidy the wording. Use [[Note Title]] links to related notes when relevant.'),
        tags: { type: 'ARRAY', items: { type: 'STRING' }, description: 'A few lowercase tags, e.g. ["ideas","work"]' },
        folder: S('Folder for the note. Default "Inbox". Use e.g. "Projects", "People", "Ideas" when obvious.'),
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'append_to_note',
    description: 'Add text to the end of an existing note found by title.',
    parameters: { type: 'OBJECT', properties: { title: S('Title of the existing note'), content: S('Markdown to append') }, required: ['title', 'content'] },
  },
  {
    name: 'add_to_daily_log',
    description: 'Add a short timestamped entry to today\'s daily note (journal-style: what happened, quick thoughts, progress).',
    parameters: { type: 'OBJECT', properties: { entry: S('One-line entry') }, required: ['entry'] },
  },
  {
    name: 'search_notes',
    description: 'Search the owner\'s notes by keywords. Use before answering questions about things the owner may have saved earlier.',
    parameters: { type: 'OBJECT', properties: { query: S('Keywords to search for') }, required: ['query'] },
  },
  {
    name: 'read_note',
    description: 'Read the full content of a note by title.',
    parameters: { type: 'OBJECT', properties: { title: S('Note title') }, required: ['title'] },
  },
  {
    name: 'list_recent_notes',
    description: 'List the most recently edited notes.',
    parameters: { type: 'OBJECT', properties: { limit: { type: 'NUMBER', description: 'How many (default 10)' } } },
  },
];

const handlers = {
  set_reminder({ text, due_at, in_minutes, repeat = 'none' }, ctx) {
    let due;
    if (in_minutes != null && Number(in_minutes) > 0) due = Date.now() + Number(in_minutes) * 60_000;
    else if (due_at) due = Date.parse(due_at);
    if (!due || Number.isNaN(due)) return { error: 'Need a valid due_at (ISO 8601 with offset) or in_minutes.' };
    if (due < Date.now() - 60_000) return { error: `That time (${fmt(due)}) is in the past. Ask the owner to confirm the time.` };
    const id = db.addReminder(ctx.sessionId, ctx.chatId, text, due, repeat);
    return { ok: true, id, due: fmt(due), repeat };
  },
  list_reminders(_, ctx) {
    return { reminders: db.pendingReminders(ctx.chatId).map((r) => ({ id: r.id, text: r.text, due: fmt(r.due_at), repeat: r.repeat })) };
  },
  cancel_reminder({ id }, ctx) {
    const r = db.getReminder(Number(id), ctx.chatId);
    if (!r || r.status !== 'pending') return { error: `No pending reminder with id ${id}` };
    db.setReminderStatus(r.id, 'cancelled');
    return { ok: true, cancelled: r.text };
  },
  save_note: (a) => vault.saveNote(a),
  append_to_note: (a) => vault.appendToNote(a),
  add_to_daily_log: (a) => vault.addToDailyLog(a),
  search_notes: (a) => vault.searchNotes(a),
  read_note: (a) => vault.readNote(a),
  list_recent_notes: (a) => vault.listRecentNotes(a),
};

async function run(name, args, ctx) {
  const fn = handlers[name];
  if (!fn) return { error: `Unknown tool ${name}` };
  try {
    return await fn(args || {}, ctx);
  } catch (e) {
    console.error(`[tool ${name}]`, e.message);
    return { error: e.message };
  }
}

module.exports = { declarations, run, fmt };
