// Gemini with function calling: the model can call tools, see results, then answer.
const tools = require('./tools');

const KEY = process.env.GEMINI_API_KEY;
const MODELS = [process.env.GEMINI_MODEL || 'gemini-3.8-flash', process.env.GEMINI_FALLBACK_MODEL].filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class QuotaError extends Error {}
class BusyError extends Error {}

// One generateContent call, with retries on "busy" and fallback to the second model.
async function generate(body) {
  let lastErr = '';
  let quota = false;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      lastErr = `Gemini ${model} ${res.status} ${await res.text()}`;
      if (res.status === 429) { quota = true; break; }
      if (res.status !== 500 && res.status !== 503) throw new Error(lastErr);
      console.warn(`${model} busy (${res.status}), retry ${attempt + 1}/3`);
      await sleep(2000 * 2 ** attempt);
    }
  }
  console.error(lastErr);
  throw quota ? new QuotaError(lastErr) : new BusyError(lastErr);
}

/**
 * history: [{role:'user'|'model', text}]  (already includes the newest user message)
 * ctx: { sessionId, chatId } passed to tools
 * returns { text, toolsUsed: [names] }
 */
async function reply(systemPrompt, history, ctx) {
  const contents = history.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
  const toolsUsed = [];

  for (let step = 0; step < 6; step++) {
    const json = await generate({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      tools: [{ functionDeclarations: tools.declarations }],
      generationConfig: { maxOutputTokens: 2048, temperature: 0.6 },
    });

    const content = json.candidates?.[0]?.content;
    const parts = content?.parts || [];
    const calls = parts.filter((p) => p.functionCall);

    if (!calls.length) {
      const text = parts.map((p) => p.text || '').join('').trim();
      return { text: text || "Done.", toolsUsed };
    }

    // Echo the model's turn back verbatim (keeps any thought signatures Gemini needs).
    contents.push(content);
    const responses = [];
    for (const { functionCall: fc } of calls) {
      console.log(`[tool] ${fc.name} ${JSON.stringify(fc.args || {})}`);
      toolsUsed.push(fc.name);
      const result = await tools.run(fc.name, fc.args, ctx);
      responses.push({ functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response: { result } } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return { text: 'I got stuck in a loop doing that. Could you rephrase?', toolsUsed };
}

module.exports = { reply, QuotaError, BusyError };
