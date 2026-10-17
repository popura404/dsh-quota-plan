import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN_RATES, DEFAULT_CONFIG, estimateReservation, validateConfig } from '../lib/pricing.js';

const rates = BUILTIN_RATES['deepseek-official/deepseek-flash'];
const request = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash',
  messages: Object.freeze([{ role: 'user', content: 'Hello' }]) });

function completed(outputTokens, at, extra = {}) {
  return { id: `record-${at}`, at, provider: request.provider, model: request.model,
    status: 'completed', usage: { inputTokens: 10, outputTokens }, ...extra };
}

function estimate(records = [], options = request, config = DEFAULT_CONFIG) {
  return estimateReservation(options, rates, config, {}, 100, records);
}

test('output reservation has its own default and never adds or changes a request output limit', () => {
  assert.equal(DEFAULT_CONFIG.outputReservationTokens, 2048);
  assert.equal(Object.hasOwn(DEFAULT_CONFIG, 'maxOutputTokens'), false);
  for (const options of [request, ...[20000, 100000].map(maxTokens => Object.freeze({ ...request, maxTokens }))]) {
    const before = JSON.stringify(options);
    const reserved = estimate([], options);
    assert.equal(reserved.outputTokens, 2048);
    assert.equal(reserved.outputSource, 'fallback');
    assert.equal(reserved.outputSampleCount, 0);
    assert.equal(JSON.stringify(options), before);
  }
  assert.equal(Object.hasOwn(request, 'maxTokens'), false);
});

test('only an existing valid smaller request limit reduces the output reservation', () => {
  const limited = Object.freeze({ ...request, maxTokens: 128 });
  assert.equal(estimate([], limited).outputTokens, 128);
  assert.equal(limited.maxTokens, 128);
  for (const maxTokens of [undefined, null, 0, -1, 1.5, NaN, Infinity, '128']) {
    assert.equal(estimate([], Object.freeze({ ...request, maxTokens })).outputTokens, 2048);
  }
});

test('fewer than five matching completed samples use the configured fallback', () => {
  const records = [100, 200, 300, 400].map((output, index) => completed(output, index + 1));
  const reserved = estimate(records, request, validateConfig({ outputReservationTokens: 777 }));
  assert.equal(reserved.outputTokens, 777);
  assert.equal(reserved.outputSource, 'fallback');
  assert.equal(reserved.outputSampleCount, 4);
});

test('output history uses the P90 with a 25 percent margin and rounds up', () => {
  const records = [100, 200, 300, 400, 500, 600, 700, 800, 801, 10000]
    .map((output, index) => completed(output, index + 1));
  const reserved = estimate(records);
  // nearest-rank P90 is 801; the isolated maximum is outside that percentile.
  assert.equal(reserved.outputTokens, 1002);
  assert.equal(reserved.outputSource, 'history');
  assert.equal(reserved.outputSampleCount, 10);
  const capped = estimate(records, Object.freeze({ ...request, maxTokens: 128 }));
  assert.equal(capped.outputTokens, 128);
  assert.equal(capped.outputSource, 'history');
});

test('short or empty successful outputs still reserve a minimum of 256 tokens', () => {
  const reserved = estimate(Array.from({ length: 5 }, (_, index) => completed(0, index + 1)));
  assert.equal(reserved.outputTokens, 256);
  assert.equal(reserved.outputSource, 'history');
  assert.equal(reserved.outputSampleCount, 5);
});

test('history is isolated by provider and model and excludes unsuccessful or invalid output samples', () => {
  const valid = Array.from({ length: 5 }, (_, index) => completed(400, index + 1));
  const ineligible = [
    completed(999999, 100, { provider: 'another-channel' }),
    completed(999999, 101, { model: 'another-model' }),
    ...['failed', 'estimated', 'pending', 'uncertain', 'cancelled'].map((status, index) => completed(999999, 102 + index, { status })),
    ...[undefined, null, -1, 0.5, NaN, Infinity, '999999', Number.MAX_SAFE_INTEGER + 1]
      .map((value, index) => completed(value, 110 + index)),
    completed(999999, 120, { usage: undefined }),
  ];
  const records = Object.freeze([...ineligible, ...valid].map(record => Object.freeze(record)));
  const reserved = estimate(records);
  assert.equal(reserved.outputTokens, 500);
  assert.equal(reserved.outputSource, 'history');
  assert.equal(reserved.outputSampleCount, 5);
});

test('only the latest twenty eligible records influence the output estimate regardless of array order', () => {
  const older = Array.from({ length: 5 }, (_, index) => completed(100000, index + 1));
  const recent = Array.from({ length: 20 }, (_, index) => completed(400, index + 10));
  // Ineligible new records must not evict the twenty useful matching samples.
  const unrelated = Array.from({ length: 25 }, (_, index) => completed(100000, index + 100, { provider: 'other' }));
  const records = [...older, ...recent, ...unrelated];
  const before = records.map(record => record.id);
  const reserved = estimate(records);
  assert.equal(reserved.outputTokens, 500);
  assert.equal(reserved.outputSampleCount, 20);
  assert.deepEqual(records.map(record => record.id), before);
  assert.deepEqual(estimate([...records].reverse()), reserved);
});

test('history can reserve more than the fallback without imposing that estimate on the request', () => {
  const records = Array.from({ length: 5 }, (_, index) => completed(10000, index + 1));
  const reserved = estimate(records);
  assert.equal(reserved.outputTokens, 12500);
  assert.equal(reserved.outputSource, 'history');
  assert.equal(Object.hasOwn(request, 'maxTokens'), false);
});

test('legacy output caps migrate to reservation settings with an explicit new setting taking priority', () => {
  for (const [legacy, expected] of [[8192, 2048], [4096, 4096], [100000, 100000]]) {
    const migrated = validateConfig({ maxOutputTokens: legacy });
    assert.equal(migrated.outputReservationTokens, expected);
    assert.equal(Object.hasOwn(migrated, 'maxOutputTokens'), false);
    const previous = { ...DEFAULT_CONFIG, maxOutputTokens: legacy };
    delete previous.outputReservationTokens;
    const restored = validateConfig({ weeklyLimitUsd: 23 }, previous);
    assert.equal(restored.outputReservationTokens, expected);
    assert.equal(restored.weeklyLimitUsd, 23);
    assert.equal(Object.hasOwn(restored, 'maxOutputTokens'), false);
  }
  const explicit = validateConfig({ maxOutputTokens: 100000, outputReservationTokens: 1234 });
  assert.equal(explicit.outputReservationTokens, 1234);
  assert.equal(Object.hasOwn(explicit, 'maxOutputTokens'), false);
  for (const value of [0, -1, 1.5, NaN, Infinity, '2048', 1000001]) {
    assert.throws(() => validateConfig({ outputReservationTokens: value }));
  }
});
