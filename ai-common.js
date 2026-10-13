// Shared by ai.js and the provider files: error types, sleep, and the one-line-per-request usage log.
class QuotaError extends Error {}
class BusyError extends Error {}
class CreditError extends Error {
  constructor(provider, detail) { super(`${provider} credit ran out: ${detail || ''}`.trim()); this.provider = provider; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// usage: { input, output, cached, cost } (any may be null). Never logs message text or keys.
function logUsage(provider, model, u = {}) {
  const cost = u.cost == null ? 'n/a' : `$${Number(u.cost).toFixed(6)}`;
  console.log(`[ai] ${provider} model=${model} in=${u.input ?? '?'} out=${u.output ?? '?'} cached=${u.cached ?? 0} cost=${cost}`);
}

module.exports = { QuotaError, BusyError, CreditError, sleep, logUsage };
