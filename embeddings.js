// Semantic note search: Gemini embeddings stored in SQLite, cosine similarity in plain JS.
// A personal vault is small, so a brute-force scan is plenty fast and needs no vector database.
const crypto = require('crypto');
const db = require('./db');

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
const DIMS = Number(process.env.EMBEDDING_DIMS || 768);
const enabled = () => Boolean(KEY) && !/^(0|false|off|no)$/i.test(process.env.EMBEDDINGS || '');

db.exec(`
  CREATE TABLE IF NOT EXISTS note_index (path TEXT PRIMARY KEY, hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS note_chunks (
    path TEXT NOT NULL,
    idx INTEGER NOT NULL,
    text TEXT NOT NULL,
    vec BLOB NOT NULL,
    PRIMARY KEY (path, idx)
  );
`);
const q = {
  hashes: db.prepare('SELECT path, hash FROM note_index'),
  setHash: db.prepare('INSERT INTO note_index (path, hash) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash'),
  delIndex: db.prepare('DELETE FROM note_index WHERE path = ?'),
  delChunks: db.prepare('DELETE FROM note_chunks WHERE path = ?'),
  addChunk: db.prepare('INSERT INTO note_chunks (path, idx, text, vec) VALUES (?, ?, ?, ?)'),
  allChunks: db.prepare('SELECT path, text, vec FROM note_chunks'),
};

// Paragraph-aware chunks of about 1200 chars, capped to keep embedding calls cheap.
function chunk(text, max = 1200, cap = 12) {
  const out = [];
  let cur = '';
  for (const para of text.split(/\n\s*\n/)) {
    for (let p = para.trim(); p; p = p.slice(max)) {
      const piece = p.slice(0, max);
      if (cur && cur.length + piece.length + 2 > max) { out.push(cur); cur = ''; }
      cur += (cur ? '\n\n' : '') + piece;
    }
  }
  if (cur) out.push(cur);
  return out.slice(0, cap);
}

const normalize = (v) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return Float32Array.from(v, (x) => x / n);
};
const toBlob = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
const fromBlob = (u8) => new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)); // copy: SQLite blobs may be unaligned

async function embed(texts, taskType) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({
      requests: texts.map((text) => ({ model: `models/${MODEL}`, content: { parts: [{ text }] }, taskType, outputDimensionality: DIMS })),
    }),
  });
  if (!res.ok) throw new Error(`Gemini embeddings ${res.status} ${(await res.text()).slice(0, 200)}`);
  const { embeddings } = await res.json();
  if (!embeddings || embeddings.length !== texts.length) throw new Error('Gemini embeddings: unexpected response');
  return embeddings.map((e) => normalize(e.values)); // truncated dimensions are not unit length
}

let syncing = null;
/** notes: [{ path, title, text }]. Embeds new/changed notes (at most `maxNotes` per run) and drops deleted ones. */
function sync(notes, maxNotes = 15) {
  if (!enabled()) return Promise.resolve({ embedded: 0 });
  if (syncing) return syncing;
  syncing = (async () => {
    const known = new Map(q.hashes.all().map((r) => [r.path, r.hash]));
    const live = new Set(notes.map((n) => n.path));
    for (const p of known.keys()) if (!live.has(p)) { q.delChunks.run(p); q.delIndex.run(p); }

    const stale = notes.filter((n) => n.text.trim() && known.get(n.path) !== crypto.createHash('sha1').update(n.text).digest('hex'));
    let embedded = 0;
    for (const n of stale.slice(0, maxNotes)) {
      const pieces = chunk(n.text).map((c) => `${n.title}\n${c}`);
      const vecs = await embed(pieces, 'RETRIEVAL_DOCUMENT');
      q.delChunks.run(n.path);
      pieces.forEach((t, i) => q.addChunk.run(n.path, i, t, toBlob(vecs[i])));
      q.setHash.run(n.path, crypto.createHash('sha1').update(n.text).digest('hex'));
      embedded++;
    }
    if (embedded) console.log(`[embeddings] indexed ${embedded} note(s), ${Math.max(0, stale.length - embedded)} pending`);
    return { embedded, pending: Math.max(0, stale.length - embedded) };
  })().finally(() => { syncing = null; });
  return syncing;
}

/** Best-matching chunk per note. Returns [{ path, score, snippet }] sorted by similarity. */
async function search(query, limit = 5, minScore = 0.35) {
  if (!enabled()) return [];
  const rows = q.allChunks.all();
  if (!rows.length) return [];
  const [qv] = await embed([query], 'RETRIEVAL_QUERY');
  const best = new Map();
  for (const r of rows) {
    const v = fromBlob(r.vec);
    if (v.length !== qv.length) continue; // index built with different dimensions; re-index needed
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * qv[i];
    if (s >= minScore && (!best.has(r.path) || s > best.get(r.path).score)) best.set(r.path, { path: r.path, score: Math.round(s * 100) / 100, snippet: r.text.replace(/\s+/g, ' ').slice(0, 400) });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { enabled, sync, search };
