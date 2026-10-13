// OpenRouter provider (OpenAI-compatible Chat Completions with tool calling).
// Privacy: every request asks for zero-data-retention endpoints only, no data collection, no silent provider fallback.
const { QuotaError, BusyError, CreditError, sleep, logUsage, bus } = require('./ai-common');
const models = require('./models');
const usage = require('./usage');

const BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const KEY = process.env.OPENROUTER_API_KEY;
const PRIVACY = { zdr: true, data_collection: 'deny', allow_fallbacks: false, require_parameters: true };
const RETRY_MS = Number(process.env.AI_RETRY_BASE_MS || 2000); // 2s, 4s, 8s; tests shrink it
const RETRY_STATUS = new Set([429, 500, 502, 503]);

const CLOCK = /^Current local date and time:.*$/m;

// Media for the newest user message, in OpenAI content-part format.
function mediaPart(media) {
  const mime = media.mimeType;
  if (mime.startsWith('image/')) return { type: 'image_url', image_url: { url: `data:${mime};base64,${media.data}` } };
  if (mime === 'application/pdf') return { type: 'file', file: { filename: 'document.pdf', file_data: `data:${mime};base64,${media.data}` } };
  return { type: 'text', text: `[attached file]\n${Buffer.from(media.data, 'base64').toString('utf8').slice(0, 30000)}` };
}

// One request, with retries (2s, 4s, 8s) then the fallback model. Sticky: once on the fallback, stay there for this turn.
async function complete(state, tools) {
  let lastStatus = 0;
  let lastErr = '';
  for (let mi = state.modelIdx; mi < state.models.length; mi++) {
    const model = state.models[mi];
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, 'X-Title': 'WA Secretary' },
        body: JSON.stringify({
          model,
          messages: state.messages,
          tools: tools.openaiTools(),
          max_tokens: 2048, // no temperature: GPT-6 Luna endpoints don't support it, and require_parameters then finds no endpoint (404)
          provider: PRIVACY,
          usage: { include: true },
        }),
      }).catch((e) => ({ networkError: `${e.message} (${e.cause?.code || e.cause?.message || 'no cause'})` }));

      let status = 0, json = null, text = '';
      if (res.networkError) { text = res.networkError; status = -1; }
      else {
        status = res.status;
        text = await res.text();
        try { json = JSON.parse(text); } catch { /* keep text */ }
        if (status === 200 && json?.error) status = Number(json.error.code) || 500; // errors can arrive inside a 200
      }
      if (status === 200 && json?.choices?.[0]) {
        state.modelIdx = mi;
        const u = json.usage || {};
        logUsage('openrouter', json.model || model, { input: u.prompt_tokens, output: u.completion_tokens, cached: u.prompt_tokens_details?.cached_tokens, cost: u.cost });
        return json.choices[0].message;
      }
      lastStatus = status;
      lastErr = `OpenRouter ${model} ${status} ${text.slice(0, 300)}`;
      if (status === 402) throw new CreditError('OpenRouter', text.slice(0, 200));
      if (status === 404) { console.warn(`${model}: no endpoint allowed (${text.slice(0, 120)}), trying fallback`); break; }
      if (status !== -1 && !RETRY_STATUS.has(status)) throw new Error(lastErr);
      console.warn(`${model} ${status === -1 ? 'network error' : status}, retry ${attempt + 1}/3`);
      if (attempt < 3) await sleep(RETRY_MS * 2 ** attempt);
    }
    console.warn(`${model} failed, switching model`);
  }
  console.error(lastErr);
  if (lastStatus === 404) throw new Error(`No OpenRouter endpoint satisfies the privacy settings for ${state.models.join(' or ')}`);
  throw lastStatus === 429 ? new QuotaError(lastErr) : new BusyError(lastErr);
}

module.exports = {
  name: 'openrouter',
  async start(systemPrompt, history, media) {
    // Main model (runtime-switchable) then fallback. Over the daily spend limit: cheapest first.
    const cur = models.current();
    let list = [cur.main, cur.fallback].filter((m, i, a) => m && a.indexOf(m) === i);
    if (usage.overLimit()) {
      const cheap = await models.cheapest(list);
      list = [cheap, ...list.filter((m) => m !== cheap)];
      bus.emit('spend-limit', { spent: usage.spentToday(), limit: usage.limit(), model: cheap });
    }
    // The clock changes every second; keep it out of the system prompt so the prompt prefix can be cached,
    // and put it on the newest user message instead.
    const clock = (CLOCK.exec(systemPrompt) || [''])[0];
    const stable = systemPrompt.replace(CLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
    const system = list[0].startsWith('anthropic/')
      ? { role: 'system', content: [{ type: 'text', text: stable, cache_control: { type: 'ephemeral' } }] } // Anthropic needs an explicit marker
      : { role: 'system', content: stable }; // OpenAI/Gemini cache a repeated prefix automatically
    const messages = [system, ...history.map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text }))];
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') {
      const text = clock ? `[${clock}]\n${last.content}` : last.content;
      last.content = media ? [mediaPart(media), { type: 'text', text }] : text;
    }
    return { messages, models: list, modelIdx: 0 };
  },
  async step(state, tools) {
    const msg = await complete(state, tools);
    const calls = (msg.tool_calls || []).map((c) => {
      let args = {};
      try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* bad JSON -> no args, the tool will report what is missing */ }
      return { id: c.id, name: c.function?.name, args };
    });
    return { text: String(msg.content || '').trim(), calls, raw: msg };
  },
  addResults(state, step, results) {
    const { role, content, tool_calls, reasoning_details } = step.raw; // echo verbatim, incl. reasoning details some models need back
    state.messages.push({ role, content: content ?? null, tool_calls, ...(reasoning_details ? { reasoning_details } : {}) });
    step.calls.forEach((c, i) => state.messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(results[i]) }));
  },
};
