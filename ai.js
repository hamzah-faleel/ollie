// AI tool loop shared by all providers. A provider (ai-gemini.js, ai-openrouter.js) only builds requests and parses
// responses: start(systemPrompt, history, media) -> state, step(state, tools) -> { text, calls }, addResults(...).
// AI_PROVIDER=gemini (default) | openrouter
const tools = require('./tools');
const { QuotaError, BusyError, CreditError, turnStore, bus } = require('./ai-common');
const crypto = require('crypto');

const NAME = (process.env.AI_PROVIDER || 'gemini').trim().toLowerCase();
if (!['gemini', 'openrouter'].includes(NAME)) { console.error(`AI_PROVIDER must be "gemini" or "openrouter", got "${NAME}"`); process.exit(1); }
const provider = require(NAME === 'openrouter' ? './ai-openrouter' : './ai-gemini');
console.log(`[ai] provider: ${provider.name}`);

/**
 * history: [{role:'user'|'model', text}]  (already includes the newest user message)
 * ctx: { sessionId, chatId } passed to tools
 * media: optional { mimeType, data (base64) } image/PDF/text attached to the newest user message
 * returns { text, toolsUsed: [names] }
 */
async function reply(systemPrompt, history, ctx, media) {
  return turnStore.run(crypto.randomUUID(), () => run(systemPrompt, history, ctx, media));
}

async function run(systemPrompt, history, ctx, media) {
  const state = await provider.start(systemPrompt, history, media);
  const toolsUsed = [];

  for (let step = 0; step < 6; step++) {
    const turn = await provider.step(state, tools);
    if (!turn.calls.length) return { text: turn.text || 'Done.', toolsUsed };

    const results = [];
    for (const call of turn.calls) {
      console.log(`[tool] ${call.name} ${JSON.stringify(call.args)}`);
      toolsUsed.push(call.name);
      results.push(await tools.run(call.name, call.args, ctx));
    }
    provider.addResults(state, turn, results);
  }
  return { text: 'I got stuck in a loop doing that. Could you rephrase?', toolsUsed };
}

// Summarize text from other people with no tools, only via OpenRouter's zero-data-retention routing. Fails closed otherwise.
async function untrusted(system, user) {
  if (typeof provider.plain !== 'function') throw new Error('Inbox processing needs AI_PROVIDER=openrouter (zero-data-retention routing).');
  return turnStore.run(crypto.randomUUID(), () => provider.plain(system, user));
}

module.exports = { reply, untrusted, QuotaError, BusyError, CreditError, bus, providerName: provider.name };
