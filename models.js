// OpenRouter model choice: the main model can be switched at runtime (/model, stored in SQLite);
// the fallback comes from .env. Also knows prices so the spend guard can pick the cheapest model.
const db = require('./db');

const BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const DEFAULT_MAIN = process.env.OPENROUTER_MODEL || 'openai/gpt-6-luna';
const FALLBACK = process.env.OPENROUTER_FALLBACK_MODEL || 'google/gemini-3.1-flash-lite';

const current = () => ({ main: db.getKv('model_main') || DEFAULT_MAIN, fallback: FALLBACK, overridden: Boolean(db.getKv('model_main')) });
const setMain = (slug) => db.setKv('model_main', slug);
const reset = () => db.setKv('model_main', '');

let cache = { at: 0, byId: null };
async function catalog() {
  if (cache.byId && Date.now() - cache.at < 3_600_000) return cache.byId;
  try {
    const res = await fetch(`${BASE}/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cache = { at: Date.now(), byId: new Map((await res.json()).data.map((m) => [m.id, m])) };
  } catch (e) {
    console.warn('[models] could not load OpenRouter model list:', e.message);
    if (!cache.byId) return null;
  }
  return cache.byId;
}

// -> { ok: true } | { ok: false, reason, suggestions }
async function validate(slug) {
  const all = await catalog();
  if (!all) return { ok: false, reason: "Couldn't reach OpenRouter to check that model. Try again in a moment.", suggestions: [] };
  const m = all.get(slug);
  if (m && (m.supported_parameters || []).includes('tools')) return { ok: true };
  if (m) return { ok: false, reason: `${slug} exists but doesn't support tool calling, which I need.`, suggestions: [] };
  const needle = slug.toLowerCase().split('/').pop();
  const suggestions = [...all.keys()].filter((id) => id.toLowerCase().includes(needle) && !id.includes(':') && (all.get(id).supported_parameters || []).includes('tools')).slice(0, 5);
  return { ok: false, reason: `No model "${slug}" on OpenRouter.`, suggestions };
}

// Cheapest (prompt + completion price) among the given slugs; unknown prices count as most expensive.
async function cheapest(slugs) {
  const all = await catalog();
  if (!all) return slugs[slugs.length - 1]; // no prices: the fallback is normally the cheaper one
  const price = (s) => { const p = all?.get(s)?.pricing; return p ? Number(p.prompt) + Number(p.completion) : Infinity; };
  return [...slugs].sort((a, b) => price(a) - price(b))[0];
}

module.exports = { current, setMain, reset, validate, cheapest };
