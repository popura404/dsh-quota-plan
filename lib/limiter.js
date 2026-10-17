import { randomUUID } from 'node:crypto';
import { resolveRates, estimateReservation, priceUsage } from './pricing.js';

export class QuotaError extends Error {
  constructor(message, code = 'PLAN_QUOTA_EXCEEDED') {
    super(message); this.name = 'QuotaError'; this.code = code;
  }
}

export function createLimiter({ store, modelInfo = async () => ({}), estimateInput, priceCatalog, errorFactory = (message, code) => new QuotaError(message, code) }) {
  let lastRejection = null;
  const failedSettlements = new Map();
  const reject = (message, code) => {
    lastRejection = { message, code, at: Date.now() };
    return errorFactory(message, code);
  };
  const ledgerFailure = () => [...failedSettlements.values()].map(value => value.message).join('；') || null;
  const ledgerCode = error => error.code === 'PLAN_LOCK_BUSY' ? error.code : 'PLAN_LEDGER_ERROR';

  async function* stream(options, next) {
    // Retry each unresolved request before admission. A successful settlement
    // clears only its own failure, including when another stream finishes.
    for (const failed of [...failedSettlements.values()]) {
      try { failed.retry(); } catch { /* Its durable hold and retry remain. */ }
    }
    const unresolved = ledgerFailure();
    if (unresolved) throw reject(`额度账本结算失败，已停止新的模型调用：${unresolved}`, 'PLAN_LEDGER_ERROR');
    let config;
    try { config = store.status().config; }
    catch (e) { throw reject(`无法读取额度账本，已停止调用：${e.message}`, ledgerCode(e)); }
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
    let info;
    try {
      info = await modelInfo(options);
    } catch {
      if (options.signal?.aborted) return;
      // Model capacity is optional for a measurable request. Strict mode and
      // unknown inputs still fail the capacity check below; do not invent it.
    }
    if (options.signal?.aborted) return;
    let inputEstimate;
    try { inputEstimate = estimateInput?.(options, info); }
    catch { inputEstimate = null; }
    let pricingFailure;
    try {
      // Pricing and admission use the same locked configuration generation.
      // A GUI update during metadata resolution cannot retain an old price.
      store.transaction((engine, currentConfig) => {
        if (!currentConfig.enabled) { bypass = true; return; }
        try {
          rates = resolveRates(options, currentConfig, priceCatalog);
          const reservation = estimateReservation(options, rates, currentConfig, info?.context ?? {}, inputEstimate, engine.recent);
          amountUsd = Math.max(0.000001, reservation.costUsd);
          Object.assign(metadata, { reservationSource: reservation.source,
            reservedInputTokens: reservation.inputTokens, reservedOutputTokens: reservation.outputTokens,
            outputReservationSource: reservation.outputSource, outputReservationSamples: reservation.outputSampleCount });
        } catch (e) {
          pricingFailure = e;
          throw e;
        }
        admission = engine.reserve({ id, amountUsd, metadata });
      });
    } catch (e) {
      if (e === pricingFailure) throw reject(e.message, 'PLAN_PRICING_REQUIRED');
      throw reject(`无法预留额度，已停止调用：${e.message}`, ledgerCode(e));
    }
    if (bypass) { yield* next(); return; }
    if (!admission.ok) {
      const reason = admission.reason?.message ?? admission.reason ?? '剩余额度不足以预留本次请求，请调整预留设置或等待窗口重置。';
      throw reject(typeof reason === 'string' ? reason : JSON.stringify(reason), 'PLAN_QUOTA_EXCEEDED');
    }
    lastRejection = null;
    let usage = null;
    let entered = false;
    let settled = false;
    let terminal = null;
    let reachedEnd = false;
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
          // its reservation rather than keeping a permanent hold.
          store.commit(id, { ...metadata, costUsd: amountUsd, status: 'estimated', pricingSource: rates.source });
        } else {
          store.cancel(id, Date.now(), { definitelyUnbilled: true });
        }
        settled = true;
        failedSettlements.delete(id);
      } catch (e) {
        // Never silently release a potentially billed request on a write or
        // invalid-usage failure. The durable reservation remains occupied.
        failedSettlements.set(id, { retry: settle, message: e.message });
        throw reject(`费用结算失败，预留额度已保留：${e.message}`, ledgerCode(e));
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
          reachedEnd = true;
          // Commit before delivering finish, since callers may break on it.
          settle();
        }
        yield chunk;
      }
      reachedEnd = true;
    } catch (error) {
      terminal = 'error';
      throw error;
    } finally {
      // Partial usage is still billed, but interrupted responses must not
      // teach the output estimator that a normal completion is this short.
      if ((!reachedEnd || options.signal?.aborted) && !terminal) terminal = 'aborted';
      settle();
    }
  }

  return { stream, diagnostics: () => ({ lastRejection, ledgerFailure: ledgerFailure() }) };
}
