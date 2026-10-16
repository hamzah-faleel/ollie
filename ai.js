// AI tool loop shared by all providers. A provider (ai-gemini.js, ai-openrouter.js) only builds requests and parses
// responses: start(systemPrompt, history, media) -> state, step(state, tools) -> { text, calls }, addResults(...).
// AI_PROVIDER=gemini (default) | openrouter
const tools = require('./tools');
const { QuotaError, BusyError, CreditError, turnStore, bus } = require('./ai-common');
const pseudonym = require('./pseudonym');
const crypto = require('crypto');

// Raised when personal data could not be hidden: nothing was sent to the AI (fail closed).
class PrivacyError extends Error {}
// Run a pseudonymization step; any failure stops the request before anything is sent. Never logs the text or the mapping.
function guard(fn) {
  try { return fn(); } catch (e) { throw new PrivacyError(`Privacy filter failed (${e.constructor.name}), so nothing was sent to the AI.`); }
}
async function pseudoSession() {
  try { return await pseudonym.session(); } catch (e) { throw new PrivacyError(`Privacy filter failed (${e.constructor.name}), so nothing was sent to the AI.`); }
}
// Text attachments are pseudonymized too; images and PDFs cannot be and go as they are.
function hideMedia(p, media) {
  if (!media || /^image\//.test(media.mimeType) || media.mimeType === 'application/pdf') return media;
  return { ...media, data: Buffer.from(p.hide(Buffer.from(media.data, 'base64').toString('utf8'))).toString('base64') };
}

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
  // Pseudonymization (pseudonym.js): one mapping for this whole turn. The model only ever sees placeholders; tools get real
  // values (arguments restored), tool results are hidden again before they go back, and the final reply is restored.
  const p = await pseudoSession();
  if (p) {
    ({ systemPrompt, history, media } = guard(() => ({
      systemPrompt: p.hide(`${systemPrompt}\n\n${pseudonym.HINT}`),
      history: history.map((m) => ({ ...m, text: p.hide(m.text) })),
      media: hideMedia(p, media),
    })));
  }
  const state = await provider.start(systemPrompt, history, media);
  const toolsUsed = [];

  for (let step = 0; step < 6; step++) {
    const turn = await provider.step(state, tools);
    if (!turn.calls.length) return { text: (p ? guard(() => p.show(turn.text)) : turn.text) || 'Done.', toolsUsed };

    const results = [];
    for (const call of turn.calls) {
      console.log(`[tool] ${call.name} ${JSON.stringify(call.args)}`); // as the model sent them (placeholders), never the mapping
      toolsUsed.push(call.name);
      const result = await tools.run(call.name, p ? guard(() => p.showDeep(call.args)) : call.args, ctx);
      results.push(p ? guard(() => p.hideDeep(result)) : result);
    }
    provider.addResults(state, turn, results);
  }
  return { text: 'I got stuck in a loop doing that. Could you rephrase?', toolsUsed };
}

// Summarize text from other people with no tools, only via OpenRouter's zero-data-retention routing. Fails closed otherwise.
async function untrusted(system, user, maxTokens) {
  if (typeof provider.plain !== 'function') throw new Error('Inbox processing needs AI_PROVIDER=openrouter (zero-data-retention routing).');
  const p = await pseudoSession();
  if (!p) return turnStore.run(crypto.randomUUID(), () => provider.plain(system, user, maxTokens));
  const [sys, msg] = guard(() => [p.hide(`${system}\n${pseudonym.HINT}`), p.hide(user)]);
  const out = await turnStore.run(crypto.randomUUID(), () => provider.plain(sys, msg, maxTokens));
  return guard(() => p.show(out));
}

async function converse(system, messages, maxTokens) {
  if (typeof provider.converse !== 'function') throw new Error('Chatting with outside people needs AI_PROVIDER=openrouter (zero-data-retention routing).');
  const p = await pseudoSession();
  if (!p) return turnStore.run(crypto.randomUUID(), () => provider.converse(system, messages, maxTokens));
  const [sys, msgs] = guard(() => [p.hide(`${system}\n${pseudonym.HINT}`), messages.map((m) => ({ ...m, content: p.hide(m.content) }))]);
  const out = await turnStore.run(crypto.randomUUID(), () => provider.converse(sys, msgs, maxTokens));
  return guard(() => p.show(out));
}

module.exports = { reply, untrusted, converse, PrivacyError, QuotaError, BusyError, CreditError, bus, providerName: provider.name };
