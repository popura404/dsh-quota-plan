import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BudgetEngine } from '../lib/budget.js';
import { createLimiter } from '../lib/limiter.js';
import { DEFAULT_CONFIG, validateConfig } from '../lib/pricing.js';
import { QuotaStore } from '../lib/store.js';

function request(extra = {}) {
  return Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 8192,
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好，请回复一句话。' }] }], ...extra });
}

function fixture({ config: input = {}, modelInfo = async () => ({ context: { contextWindow: 128000 } }) } = {}) {
  let config = validateConfig({ fiveHourLimitUsd: 0.02, weeklyLimitUsd: 1, ...input });
  const engine = new BudgetEngine({ config });
  const store = {
    status: () => ({ ...engine.snapshot(), config: { ...config } }),
    transaction: operation => operation(engine, config),
    commit: (...args) => engine.commit(...args),
    cancel: (...args) => engine.cancel(...args),
    configure(input) {
      config = validateConfig(input, config);
      engine.configure(config);
    },
  };
  let providerCalls = 0;
  const provider = (usage = { inputTokens: 40, outputTokens: 10 }) => async function* () {
    providerCalls += 1;
    if (usage) yield { type: 'usage', usage };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  return { engine, store, limiter: createLimiter({ store, modelInfo }), provider,
    providerCalls: () => providerCalls };
}

async function consume(stream) {
  for await (const _chunk of stream) { /* Include the final settlement. */ }
}

async function assertNextOutputReservation(f, expected) {
  const stream = f.limiter.stream(request(), f.provider());
  assert.equal((await stream.next()).value.type, 'usage');
  const pending = f.engine.snapshot().recent.find(record => record.status === 'pending');
  assert.equal(pending?.reservedOutputTokens, expected);
  await consume(stream);
}

function seedUsage(engine) {
  assert.equal(engine.reserve({ id: 'prior-spend', amountUsd: 0.02 }).ok, true);
  engine.commit('prior-spend', { costUsd: 0.02 });
}

test('0.02 remaining admits a short request with 8192 output tokens while context mode rejects', async () => {
  const measured = fixture({ config: { fiveHourLimitUsd: 0.04 } });
  const strict = fixture({ config: { fiveHourLimitUsd: 0.04, reservationMode: 'context' } });
  seedUsage(measured.engine);
  seedUsage(strict.engine);
  assert.equal(measured.engine.snapshot().remaining.fiveHour, 0.02);
  await consume(measured.limiter.stream(request(), measured.provider()));
  assert.equal(measured.providerCalls(), 1);
  assert.equal(measured.engine.snapshot().recent.find(record => record.id !== 'prior-spend').reservationSource, 'request');
  await assert.rejects(consume(strict.limiter.stream(request(), strict.provider())), { code: 'PLAN_QUOTA_EXCEEDED' });
  assert.equal(strict.providerCalls(), 0);
  assert.equal(strict.engine.snapshot().used.fiveHour, 0.02);
});

test('measurable text does not require available model metadata', async t => {
  for (const [name, modelInfo] of [
    ['no context metadata', async () => ({})],
    ['metadata lookup failure', async () => { throw new Error('metadata unavailable'); }],
  ]) {
    await t.test(name, async () => {
      const f = fixture({ modelInfo });
      await consume(f.limiter.stream(request(), f.provider()));
      assert.equal(f.providerCalls(), 1);
      assert.equal(f.engine.snapshot().recent.at(-1).reservationSource, 'request');
    });
  }
});

test('an unmeasurable image requires context capacity and uses the capacity fallback', async () => {
  const imageRequest = request({ messages: [{ role: 'user', content: [{ type: 'image', attachment: 'image-handle' }] }] });
  const unknownCapacity = fixture({ modelInfo: async () => ({}) });
  await assert.rejects(consume(unknownCapacity.limiter.stream(imageRequest, unknownCapacity.provider())),
    { code: 'PLAN_PRICING_REQUIRED' });
  assert.equal(unknownCapacity.providerCalls(), 0);
  assert.equal(unknownCapacity.engine.snapshot().pendingCount, 0);

  const knownCapacity = fixture({ modelInfo: async () => ({ context: { contextWindow: 2048 } }) });
  await consume(knownCapacity.limiter.stream(imageRequest, knownCapacity.provider()));
  assert.equal(knownCapacity.providerCalls(), 1);
  const record = knownCapacity.engine.snapshot().recent.at(-1);
  assert.equal(record.reservationSource, 'context-fallback');
  assert.equal(record.reservedInputTokens, 2560);
});

test('admission uses a mode change made while model metadata is resolving', async () => {
  let entered;
  const enteredLookup = new Promise(resolve => { entered = resolve; });
  let release;
  const metadata = new Promise(resolve => { release = resolve; });
  const f = fixture({ modelInfo: async () => { entered(); return metadata; } });
  const completion = consume(f.limiter.stream(request(), f.provider()));
  await enteredLookup;
  f.store.configure({ reservationMode: 'context' });
  release({ context: { contextWindow: 128000 } });
  await assert.rejects(completion, { code: 'PLAN_QUOTA_EXCEEDED' });
  assert.equal(f.providerCalls(), 0);
  assert.equal(f.engine.snapshot().pendingCount, 0);
});

test('admission without history uses the latest reservation setting after metadata lookup', async () => {
  let entered;
  const enteredLookup = new Promise(resolve => { entered = resolve; });
  let release;
  const metadata = new Promise(resolve => { release = resolve; });
  const f = fixture({ config: { fiveHourLimitUsd: 0.001 }, modelInfo: async () => { entered(); return metadata; } });
  const options = request({ maxTokens: 100000 });
  const completion = consume(f.limiter.stream(options, f.provider()));
  await enteredLookup;
  f.store.configure({ outputReservationTokens: 512 });
  release({ context: { contextWindow: 128000 } });
  await completion;
  assert.equal(f.providerCalls(), 1);
  assert.equal(f.engine.snapshot().recent[0].reservedOutputTokens, 512);
  assert.equal(options.maxTokens, 100000);
});

test('admission learns from settlements completed while model metadata is resolving', async () => {
  let entered;
  const enteredLookup = new Promise(resolve => { entered = resolve; });
  let release;
  const metadata = new Promise(resolve => { release = resolve; });
  const f = fixture({ config: { fiveHourLimitUsd: 0.001 }, modelInfo: async () => { entered(); return metadata; } });
  function seedSample(index) {
    const id = `history-${index}`;
    assert.equal(f.engine.reserve({ id, amountUsd: 0.00012,
      metadata: { provider: 'deepseek-official', model: 'deepseek-flash' } }).ok, true);
    f.engine.commit(id, { costUsd: 0.00012, status: 'completed', usage: { inputTokens: 0, outputTokens: 100 } });
  }
  for (let index = 0; index < 4; index++) seedSample(index);
  const completion = consume(f.limiter.stream(request({ maxTokens: 100000 }), f.provider()));
  await enteredLookup;
  seedSample(4);
  release({ context: { contextWindow: 128000 } });
  await completion;
  assert.equal(f.providerCalls(), 1);
  const actual = f.engine.snapshot().recent.find(record => !record.id.startsWith('history-'));
  assert.equal(actual.reservedOutputTokens, 256);
});

test('actual usage above the estimate is charged in full and blocks later admission', async () => {
  const f = fixture();
  await consume(f.limiter.stream(request(), f.provider({ inputTokens: 100000, outputTokens: 0 })));
  assert.equal(f.engine.snapshot().used.fiveHour, 0.03);
  assert.equal(f.engine.snapshot().pendingCount, 0);
  assert.equal(f.engine.snapshot().blockCode, 'fiveHour_limit');
  await assert.rejects(consume(f.limiter.stream(request(), f.provider())), { code: 'PLAN_QUOTA_EXCEEDED' });
  assert.equal(f.providerCalls(), 1);
  assert.equal(f.engine.snapshot().used.fiveHour, 0.03);
});

test('missing usage charges this request reservation instead of the whole model capacity', async () => {
  const f = fixture();
  await consume(f.limiter.stream(request(), f.provider(null)));
  const snapshot = f.engine.snapshot();
  const record = snapshot.recent.at(-1);
  assert.equal(record.status, 'estimated');
  assert.equal(record.reservationSource, 'request');
  assert.equal(record.reservedOutputTokens, 2048);
  assert.ok(record.costUsd > 0.0024 && record.costUsd < 0.003);
  assert.equal(snapshot.pendingCount, 0);
  assert.equal(snapshot.used.fiveHour, record.costUsd);
});

test('usage from interrupted streams is billed in full but cannot train output reservations', async t => {
  for (const mode of ['provider throws after usage', 'consumer returns before finish']) {
    await t.test(mode, async () => {
      const f = fixture();
      for (let attempt = 0; attempt < 5; attempt++) {
        const stream = f.limiter.stream(request(), async function* () {
          yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 400 } };
          if (mode === 'provider throws after usage') throw new Error('provider failed after reporting usage');
          yield { type: 'finish', reason: { kind: 'stop' } };
        });
        assert.equal((await stream.next()).value.type, 'usage');
        if (mode === 'provider throws after usage') {
          await assert.rejects(stream.next(), /provider failed after reporting usage/);
        } else {
          assert.equal((await stream.return()).done, true);
        }
      }
      const snapshot = f.engine.snapshot();
      assert.equal(snapshot.pendingCount, 0);
      assert.equal(snapshot.used.fiveHour, 0.00246);
      assert.equal(snapshot.recent.length, 5);
      for (const record of snapshot.recent) {
        assert.equal(record.status, 'failed');
        assert.equal(record.usage.outputTokens, 400);
        assert.equal(record.costUsd, 0.000492);
      }
      await assertNextOutputReservation(f, 2048);
    });
  }
});

test('breaking after a successful finish keeps the settlement completed and eligible for output history', async () => {
  const f = fixture();
  for (let attempt = 0; attempt < 5; attempt++) {
    for await (const chunk of f.limiter.stream(request(), f.provider({ inputTokens: 40, outputTokens: 400 }))) {
      if (chunk.type === 'finish') break;
    }
  }
  const snapshot = f.engine.snapshot();
  assert.equal(snapshot.pendingCount, 0);
  assert.equal(snapshot.used.fiveHour, 0.00246);
  assert.equal(snapshot.recent.length, 5);
  assert.equal(snapshot.recent.every(record => record.status === 'completed'), true);
  await assertNextOutputReservation(f, 500);
});

test('natural exhaustion with valid usage is a completed sample even without a finish frame', async () => {
  const f = fixture();
  for (let attempt = 0; attempt < 5; attempt++) {
    await consume(f.limiter.stream(request(), async function* () {
      yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 400 } };
    }));
  }
  const snapshot = f.engine.snapshot();
  assert.equal(snapshot.pendingCount, 0);
  assert.equal(snapshot.used.fiveHour, 0.00246);
  assert.equal(snapshot.recent.length, 5);
  assert.equal(snapshot.recent.every(record => record.status === 'completed'), true);
  await assertNextOutputReservation(f, 500);
});

test('the limiter accepts absent and large output limits without providing a request-rewriting hook', async () => {
  for (const maxTokens of [undefined, 20000, 100000]) {
    const { maxTokens: _removed, ...base } = request();
    const options = Object.freeze({ ...base, ...(maxTokens === undefined ? {} : { maxTokens }) });
    const before = JSON.stringify(options);
    const f = fixture({ modelInfo: async seen => {
      assert.equal(seen, options);
      return { context: { contextWindow: 128000 } };
    } });
    assert.equal(Object.hasOwn(f.limiter, 'configureCall'), false);
    await consume(f.limiter.stream(options, f.provider()));
    assert.equal(f.providerCalls(), 1);
    assert.equal(JSON.stringify(options), before);
    assert.equal(Object.hasOwn(options, 'maxTokens'), maxTokens !== undefined);
    assert.equal(f.engine.snapshot().recent[0].reservedOutputTokens, 2048);
  }
});

test('output beyond the reservation is passed through completely and charged in full before later calls stop', async () => {
  const f = fixture({ config: { fiveHourLimitUsd: 0.01 } });
  const options = request({ maxTokens: 100000 });
  const chunks = [
    { type: 'text', text: 'first part' },
    { type: 'text', text: 'remaining long response'.repeat(1000) },
    { type: 'usage', usage: { inputTokens: 40, outputTokens: 12000 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  let calls = 0;
  const provider = async function* () {
    calls++;
    assert.equal(options.maxTokens, 100000);
    assert.equal(f.engine.snapshot().recent[0].reservedOutputTokens, 2048);
    for (const chunk of chunks) yield chunk;
  };
  const received = [];
  for await (const chunk of f.limiter.stream(options, provider)) received.push(chunk);
  assert.equal(received.length, chunks.length);
  for (let index = 0; index < chunks.length; index++) assert.equal(received[index], chunks[index]);
  const snapshot = f.engine.snapshot();
  assert.equal(snapshot.pendingCount, 0);
  assert.equal(snapshot.used.fiveHour, 0.014412);
  assert.equal(snapshot.recent[0].usage.outputTokens, 12000);
  assert.equal(snapshot.recent[0].status, 'completed');
  assert.equal(snapshot.blockCode, 'fiveHour_limit');
  await assert.rejects(consume(f.limiter.stream(options, provider)), { code: 'PLAN_QUOTA_EXCEEDED' });
  assert.equal(calls, 1);
  assert.equal(options.maxTokens, 100000);
});

test('input estimation records counts without persisting prompts or tool arguments', async () => {
  const secrets = ['PRIVATE_SYSTEM_93825', 'PRIVATE_PROMPT_93825', 'PRIVATE_TOOL_ARGUMENT_93825', 'PRIVATE_TOOL_SCHEMA_93825'];
  const f = fixture();
  const options = request({ system: secrets[0], messages: [{ role: 'user', content: [
    { type: 'text', text: secrets[1] }, { type: 'tool-call', name: 'test_tool', arguments: JSON.stringify({ value: secrets[2] }) },
  ] }], tools: [{ name: 'test_tool', description: secrets[3], parameters: { type: 'object', properties: { value: { type: 'string' } } } }] });
  const stream = f.limiter.stream(options, f.provider());
  assert.equal((await stream.next()).value.type, 'usage');
  assert.equal(f.engine.snapshot().pendingCount, 1);
  for (const secret of secrets) assert.equal(JSON.stringify(f.engine.exportState()).includes(secret), false);
  await consume(stream);
  const state = JSON.stringify(f.engine.exportState());
  for (const secret of secrets) assert.equal(state.includes(secret), false);
  assert.ok(f.engine.snapshot().recent.at(-1).reservedInputTokens > 0);
});

test('the durable store restores the selected mode and upgrades an old configuration without losing usage', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-admission-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'ledger.json');
  const store = new QuotaStore(file);
  store.configure({ reservationMode: 'context' });
  assert.equal(store.reserve({ id: 'saved-charge', amountUsd: 0.1 }).ok, true);
  store.commit('saved-charge', { costUsd: 0.07 });
  const restored = new QuotaStore(file);
  assert.equal(restored.status().config.reservationMode, 'context');
  assert.equal(restored.status().used.fiveHour, 0.07);

  const oldLedger = JSON.parse(readFileSync(file, 'utf8'));
  delete oldLedger.config.reservationMode;
  delete oldLedger.engine.config.reservationMode;
  writeFileSync(file, JSON.stringify(oldLedger));
  const migrated = new QuotaStore(file).status();
  assert.equal(migrated.config.reservationMode, DEFAULT_CONFIG.reservationMode);
  assert.equal(migrated.used.fiveHour, 0.07);
  assert.equal(migrated.used.weekly, 0.07);
  assert.equal(migrated.recent.at(-1).id, 'saved-charge');
  assert.equal(migrated.recent.at(-1).costUsd, 0.07);
});

test('persisted legacy output caps migrate without resetting usage or enforcing a generation limit', async t => {
  for (const [legacy, explicit, expected] of [[8192, undefined, 2048], [12000, undefined, 12000], [12000, 1024, 1024]]) {
    await t.test(`legacy ${legacy}, explicit ${explicit ?? 'none'}`, t => {
      const directory = mkdtempSync(join(tmpdir(), 'dsh-output-migration-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const file = join(directory, 'ledger.json');
      const store = new QuotaStore(file);
      assert.equal(store.reserve({ id: 'saved-charge', amountUsd: 0.1 }).ok, true);
      store.commit('saved-charge', { costUsd: 0.07 });
      const oldLedger = JSON.parse(readFileSync(file, 'utf8'));
      for (const config of [oldLedger.config, oldLedger.engine.config]) {
        delete config.outputReservationTokens;
        config.maxOutputTokens = legacy;
        if (explicit !== undefined) config.outputReservationTokens = explicit;
      }
      writeFileSync(file, JSON.stringify(oldLedger));

      const migrated = new QuotaStore(file).status();
      assert.equal(migrated.config.outputReservationTokens, expected);
      assert.equal(Object.hasOwn(migrated.config, 'maxOutputTokens'), false);
      assert.equal(migrated.used.fiveHour, 0.07);
      assert.equal(migrated.used.weekly, 0.07);
      assert.equal(migrated.recent[0].id, 'saved-charge');
      assert.equal(migrated.recent[0].costUsd, 0.07);
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      for (const config of [saved.config, saved.engine.config]) {
        assert.equal(config.outputReservationTokens, expected);
        assert.equal(Object.hasOwn(config, 'maxOutputTokens'), false);
      }
    });
  }
});
