// Shared by ai.js and the provider files: error types, sleep, and the one-line-per-request usage log.
const { AsyncLocalStorage } = require('async_hooks');
const { EventEmitter } = require('events');
const turnStore = new AsyncLocalStorage(); // one id per owner message, so /usage can count messages
const bus = new EventEmitter();            // 'spend-limit' is emitted when the daily guard kicks in

class QuotaError extends Error {}
class BusyError extends Error {}
class CreditError extends Error {
  constructor(provider, detail) { super(`${provider} credit ran out: ${detail || ''}`.trim()); this.provider = provider; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// usage: { input, output, cached, cost } (any may be null). Never logs message text or keys.
function logUsage(provider, model, u = {}) {
  const cost = u.cost == null ? 'n/a' : `$${Number(u.cost).toFixed(6)}`;
  try {
    require('./usage').record({ turn: turnStore.getStore(), provider, model, input: u.input, output: u.output, cached: u.cached, cost: u.cost });
  } catch (e) { console.warn('[usage] not recorded:', e.message); }
  console.log(`[ai] ${provider} model=${model} in=${u.input ?? '?'} out=${u.output ?? '?'} cached=${u.cached ?? 0} cost=${cost}`);
}

module.exports = { QuotaError, BusyError, CreditError, sleep, logUsage, turnStore, bus };
