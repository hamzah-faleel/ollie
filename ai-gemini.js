// Gemini provider (generateContent + function calling). Behaviour unchanged from the original ai.js.
const { QuotaError, BusyError, CreditError, sleep, logUsage } = require('./ai-common');

const KEY = process.env.GEMINI_API_KEY;
const MODELS = [process.env.GEMINI_MODEL || 'gemini-3.8-flash', process.env.GEMINI_FALLBACK_MODEL].filter(Boolean);

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
      }).catch((e) => ({ networkError: `${e.message} (${e.cause?.code || e.cause?.message || 'no cause'})` }));
      if (res.networkError) {
        lastErr = `Gemini ${model} network error: ${res.networkError}`;
        console.warn(`${lastErr}, retry ${attempt + 1}/3`);
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (res.ok) {
        const json = await res.json();
        const u = json.usageMetadata;
        if (u) logUsage('gemini', model, { input: u.promptTokenCount, output: u.candidatesTokenCount, cached: u.cachedContentTokenCount });
        return json;
      }
      lastErr = `Gemini ${model} ${res.status} ${await res.text()}`;
      if (res.status === 402) throw new CreditError('Gemini', lastErr.slice(0, 200));
      if (res.status === 429) { quota = true; break; }
      if (res.status !== 500 && res.status !== 503) throw new Error(lastErr);
      console.warn(`${model} busy (${res.status}), retry ${attempt + 1}/3`);
      await sleep(2000 * 2 ** attempt);
    }
  }
  console.error(lastErr);
  throw quota ? new QuotaError(lastErr) : new BusyError(lastErr);
}

const toolDeclarations = (tools) => [{ functionDeclarations: tools.declarations }];

module.exports = {
  name: 'gemini',
  start(systemPrompt, history, media) {
    const contents = history.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
    if (media && contents.length) contents[contents.length - 1].parts.unshift({ inlineData: { mimeType: media.mimeType, data: media.data } });
    return { systemPrompt, contents };
  },
  // -> { text, calls: [{ id, name, args }], raw }
  async step(state, tools) {
    const json = await generate({
      system_instruction: { parts: [{ text: state.systemPrompt }] },
      contents: state.contents,
      tools: toolDeclarations(tools),
      generationConfig: { maxOutputTokens: 2048, temperature: 0.6 },
    });
    const content = json.candidates?.[0]?.content;
    const parts = content?.parts || [];
    return {
      text: parts.map((p) => p.text || '').join('').trim(),
      calls: parts.filter((p) => p.functionCall).map((p) => ({ id: p.functionCall.id, name: p.functionCall.name, args: p.functionCall.args || {} })),
      raw: content,
    };
  },
  addResults(state, step, results) {
    // Echo the model's turn back verbatim (keeps any thought signatures Gemini needs).
    state.contents.push(step.raw);
    state.contents.push({
      role: 'user',
      parts: step.calls.map((c, i) => ({ functionResponse: { name: c.name, ...(c.id ? { id: c.id } : {}), response: { result: results[i] } } })),
    });
  },
};
