import assert from 'node:assert/strict';
import test from 'node:test';
import { BudgetEngine } from '../lib/budget.js';
import { createLimiter } from '../lib/limiter.js';
import { DEFAULT_CONFIG } from '../lib/pricing.js';

const options = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 16 });
const usage = Object.freeze({ inputTokens: 11, outputTokens: 2 });

function fixture({ beforeCommit = () => {}, afterCommit = () => {}, beforeTransaction = () => {}, beforeStatus = () => {} } = {}) {
  const config = { ...DEFAULT_CONFIG };
  const engine = new BudgetEngine({ config });
  let providerCalls = 0;
  const commitAttempts = [];
  const store = {
    status() {
      beforeStatus();
      return { ...engine.snapshot(), config };
    },
    transaction(operation) {
      beforeTransaction();
      return operation(engine, config);
    },
    commit(id, charge) {
      commitAttempts.push({ id, charge });
      beforeCommit(id, charge);
      const result = engine.commit(id, charge);
      afterCommit(id, charge);
      return result;
    },
    cancel: (...args) => engine.cancel(...args),
  };
  const limiter = createLimiter({ store, modelInfo: async () => ({ context: { contextWindow: 1000 } }) });
  const provider = (counts = usage) => async function* () {
    providerCalls += 1;
    yield { type: 'usage', usage: counts };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  return { limiter, engine, provider, commitAttempts, providerCalls: () => providerCalls };
}

async function consume(stream) {
  for await (const _chunk of stream) { /* Consume through settlement. */ }
}

test('a successful finally retry clears its failure and charges once', async () => {
  let failOnce = true;
  const f = fixture({ beforeCommit() {
    if (failOnce) { failOnce = false; throw new Error('temporary disk failure'); }
  } });
  await assert.rejects(consume(f.limiter.stream(options, f.provider())), { code: 'PLAN_LEDGER_ERROR' });
  assert.equal(f.commitAttempts.length, 2);
  assert.equal(f.engine.snapshot().pendingCount, 0);
  assert.equal(f.engine.snapshot().recent.length, 1);
  assert.equal(f.limiter.diagnostics().ledgerFailure, null);
  const firstCost = f.engine.snapshot().used.fiveHour;

  await consume(f.limiter.stream(options, f.provider()));
  assert.equal(f.providerCalls(), 2);
  assert.equal(f.engine.snapshot().used.fiveHour, firstCost * 2);
});

test('a later request retries its predecessor before admitting another call', async () => {
  let failuresRemaining = 2;
  const f = fixture({ beforeCommit() {
    if (failuresRemaining > 0) { failuresRemaining -= 1; throw new Error('temporary disk failure'); }
  } });
  await assert.rejects(consume(f.limiter.stream(options, f.provider())), { code: 'PLAN_LEDGER_ERROR' });
  assert.equal(f.engine.snapshot().pendingCount, 1);
  assert.match(f.limiter.diagnostics().ledgerFailure, /temporary disk failure/);

  await consume(f.limiter.stream(options, f.provider()));
  assert.equal(f.commitAttempts.length, 4);
  assert.equal(f.engine.snapshot().pendingCount, 0);
  assert.equal(f.engine.snapshot().recent.length, 2);
  assert.equal(f.limiter.diagnostics().ledgerFailure, null);
});

test('retrying a write reported failed after persistence does not double charge', async () => {
  let failOnce = true;
  const f = fixture({ afterCommit() {
    if (failOnce) { failOnce = false; throw new Error('lock cleanup failed after persistence'); }
  } });
  await assert.rejects(consume(f.limiter.stream(options, f.provider())), { code: 'PLAN_LEDGER_ERROR' });
  assert.equal(f.commitAttempts.length, 2);
  assert.equal(f.engine.snapshot().pendingCount, 0);
  assert.equal(f.engine.snapshot().recent.length, 1);
  assert.equal(f.limiter.diagnostics().ledgerFailure, null);
  const firstCost = f.engine.snapshot().used.fiveHour;

  await consume(f.limiter.stream(options, f.provider()));
  assert.equal(f.engine.snapshot().used.fiveHour, firstCost * 2);
  assert.equal(f.engine.snapshot().recent.length, 2);
});

test('persistent settlement failure keeps the reservation and blocks providers', async () => {
  const f = fixture({ beforeCommit() { throw new Error('disk still unavailable'); } });
  await assert.rejects(consume(f.limiter.stream(options, f.provider())), { code: 'PLAN_LEDGER_ERROR' });
  const held = f.engine.snapshot().reserved.fiveHour;
  assert.ok(held > 0);

  await assert.rejects(consume(f.limiter.stream(options, f.provider())), { code: 'PLAN_LEDGER_ERROR' });
  assert.equal(f.providerCalls(), 1);
  assert.equal(f.commitAttempts.length, 3);
  assert.equal(f.engine.snapshot().pendingCount, 1);
  assert.equal(f.engine.snapshot().reserved.fiveHour, held);
  assert.equal(f.engine.snapshot().used.fiveHour, 0);
});

test('an already-running successful call cannot clear another request failure', async () => {
  let failedRequestStillUnavailable = true;
  const f = fixture({ beforeCommit(_id, charge) {
    if (charge.usage.inputTokens === 11 && failedRequestStillUnavailable) throw new Error('first request write failure');
  } });
  const first = f.limiter.stream(options, f.provider());
  const second = f.limiter.stream(options, f.provider({ inputTokens: 22, outputTokens: 2 }));
  assert.equal((await first.next()).value.type, 'usage');
  assert.equal((await second.next()).value.type, 'usage');
  assert.equal(f.engine.snapshot().pendingCount, 2);

  await assert.rejects(first.next(), { code: 'PLAN_LEDGER_ERROR' });
  assert.equal((await second.next()).value.type, 'finish');
  await second.next();
  assert.equal(f.engine.snapshot().pendingCount, 1);
  assert.match(f.limiter.diagnostics().ledgerFailure, /first request write failure/);
  await assert.rejects(consume(f.limiter.stream(options, f.provider())), { code: 'PLAN_LEDGER_ERROR' });
  assert.equal(f.providerCalls(), 2);

  failedRequestStillUnavailable = false;
  await consume(f.limiter.stream(options, f.provider()));
  assert.equal(f.engine.snapshot().pendingCount, 0);
  assert.equal(f.engine.snapshot().recent.length, 3);
  assert.equal(f.limiter.diagnostics().ledgerFailure, null);
});

test('invalid usage never releases a potentially billed reservation', async () => {
  const f = fixture();
  await assert.rejects(consume(f.limiter.stream(options, f.provider({ inputTokens: 11, outputTokens: -1 }))),
    { code: 'PLAN_LEDGER_ERROR' });
  assert.equal(f.commitAttempts.length, 0);
  const held = f.engine.snapshot().reserved.fiveHour;
  assert.ok(held > 0);
  await assert.rejects(consume(f.limiter.stream(options, f.provider())), { code: 'PLAN_LEDGER_ERROR' });
  assert.equal(f.providerCalls(), 1);
  assert.equal(f.engine.snapshot().pendingCount, 1);
  assert.equal(f.engine.snapshot().reserved.fiveHour, held);
});

test('admission distinguishes ledger writes, lock contention, and unknown prices', async () => {
  const brokenLedger = fixture({ beforeTransaction() { throw new Error('disk unavailable'); } });
  await assert.rejects(consume(brokenLedger.limiter.stream(options, brokenLedger.provider())), { code: 'PLAN_LEDGER_ERROR' });
  assert.equal(brokenLedger.providerCalls(), 0);

  const busyLedger = fixture({ beforeTransaction() {
    throw Object.assign(new Error('ledger locked'), { code: 'PLAN_LOCK_BUSY' });
  } });
  await assert.rejects(consume(busyLedger.limiter.stream(options, busyLedger.provider())), { code: 'PLAN_LOCK_BUSY' });
  assert.equal(busyLedger.providerCalls(), 0);

  const unknownPrice = fixture();
  await assert.rejects(consume(unknownPrice.limiter.stream({ ...options, model: 'unknown-model' }, unknownPrice.provider())),
    { code: 'PLAN_PRICING_REQUIRED' });
  assert.equal(unknownPrice.providerCalls(), 0);
});
