import { randomUUID } from 'node:crypto';
import { resolveRates, estimateReservation, priceUsage } from './pricing.js';

export class QuotaError extends Error {
  constructor(message, code = 'PLAN_QUOTA_EXCEEDED') {
    super(message); this.name = 'QuotaError'; this.code = code;
  }
}

export function createLimiter({ store, modelInfo, errorFactory = (message, code) => new QuotaError(message, code) }) {
  let lastRejection = null;
  let ledgerFailure = null;
  const reject = (message, code) => {
    lastRejection = { message, code, at: Date.now() };
    return errorFactory(message, code);
  };

  async function* stream(options, next) {
    if (ledgerFailure) throw reject(`额度账本结算失败，已停止新的模型调用：${ledgerFailure}`, 'PLAN_LEDGER_ERROR');
    let config;
    try { config = store.status().config; }
    catch (e) { throw reject(`无法读取额度账本，已停止调用：${e.message}`, 'PLAN_LEDGER_ERROR'); }
    if (!config.enabled) {
      yield* next();
      return;
    }
    const id = randomUUID();
    const metadata = {
      model: options.model, provider: options.provider,
      sessionId: options.sessionId ?? null, purpose: options.purpose ?? 'conversation',
      ownerPid: process.pid,
    };
    let rates;
    let amountUsd;
    let admission;
    let bypass = false;
    try {
      const info = await modelInfo(options);
      if (options.signal?.aborted) return;
      // Pricing and admission use the same locked configuration generation.
      // A GUI update during metadata resolution cannot retain an old price.
      store.transaction((engine, currentConfig) => {
        if (!currentConfig.enabled) { bypass = true; return; }
        rates = resolveRates(options, currentConfig);
        amountUsd = Math.max(0.000001, estimateReservation(options, rates, currentConfig, info?.context ?? {}).costUsd);
        admission = engine.reserve({ id, amountUsd, metadata });
      });
    } catch (e) {
      throw reject(e.message, 'PLAN_PRICING_REQUIRED');
    }
    if (bypass) { yield* next(); return; }
    if (!admission.ok) {
      const reason = admission.reason?.message ?? admission.reason ?? '剩余额度不足以预留本次请求的最高费用，请等待窗口重置。';
      throw reject(typeof reason === 'string' ? reason : JSON.stringify(reason), 'PLAN_QUOTA_EXCEEDED');
    }
    lastRejection = null;
    let usage = null;
    let entered = false;
    let settled = false;
    let terminal = null;
    const settle = () => {
      if (settled) return;
      try {
        if (usage) {
          store.commit(id, {
            ...metadata, costUsd: priceUsage(usage, rates), usage,
            status: terminal === 'error' || terminal === 'aborted' ? 'failed' : 'completed',
            pricingSource: rates.source,
          });
        } else if (entered) {
          // The stream has ended but its provider supplied no counters. Charge
          // the full upper bound rather than keeping a permanent reservation.
          store.commit(id, { ...metadata, costUsd: amountUsd, status: 'estimated', pricingSource: rates.source });
        } else {
          store.cancel(id, Date.now(), { definitelyUnbilled: true });
        }
        settled = true;
      } catch (e) {
        // Never silently release a potentially billed request on a write or
        // invalid-usage failure. The durable reservation remains occupied.
        ledgerFailure = e.message;
        throw reject(`费用结算失败，预留额度已保留：${e.message}`, 'PLAN_LEDGER_ERROR');
      }
    };
    try {
      if (options.signal?.aborted) return;
      entered = true;
      for await (const chunk of next()) {
        // Usage frames describe full-call counters, not additive deltas.
        if (chunk.type === 'usage') usage = chunk.usage;
        if (chunk.type === 'finish') {
          terminal = chunk.reason?.kind;
          // Commit before delivering finish, since callers may break on it.
          settle();
        }
        yield chunk;
      }
    } finally { settle(); }
  }

  async function configureCall(_payload, next) {
    const proposal = await next();
    let config;
    try { config = store.status().config; }
    catch (e) { throw reject(`无法读取额度设置：${e.message}`, 'PLAN_LEDGER_ERROR'); }
    if (!config.enabled) return proposal;
    return { ...proposal, maxTokens: Math.min(proposal.maxTokens ?? config.maxOutputTokens, config.maxOutputTokens) };
  }

  return { stream, configureCall, diagnostics: () => ({ lastRejection, ledgerFailure }) };
}
