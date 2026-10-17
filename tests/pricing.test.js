import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateRequestTokens, estimateTextTokens } from '../lib/request-estimate.js';
import { BUILTIN_RATES, DEFAULT_CONFIG, estimateReservation, validateConfig } from '../lib/pricing.js';

const rates = BUILTIN_RATES['deepseek-official/deepseek-flash'];
const request = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash',
  maxTokens: 8192, messages: [{ role: 'user', content: [{ type: 'text', text: '你好，请帮我检查代码。' }] }] });
const tool = { name: 'read_file', description: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } };

test('a short request reserves its own input regardless of model capacity', () => {
  const withoutCapacity = estimateReservation(request, rates, DEFAULT_CONFIG);
  const withCapacity = estimateReservation(request, rates, DEFAULT_CONFIG, { contextWindow: 1_000_000 });
  const strict = estimateReservation(request, rates, { ...DEFAULT_CONFIG, reservationMode: 'context' }, { contextWindow: 1_000_000 });
  assert.equal(withoutCapacity.source, 'request');
  assert.deepEqual(withCapacity, withoutCapacity);
  assert.ok(withoutCapacity.costUsd < 0.02);
  assert.ok(strict.costUsd > withoutCapacity.costUsd * 30);
  assert.equal(strict.inputTokens, 1_250_000);
});

test('input estimates include system, reasoning, tool arguments, and declarations', () => {
  const baseline = estimateRequestTokens(request);
  for (const change of [
    { system: '系统提示'.repeat(100) },
    { messages: [...request.messages, { role: 'assistant', content: [{ type: 'reasoning', text: '思考'.repeat(100) }] }] },
    { messages: [...request.messages, { role: 'assistant', content: [{ type: 'tool-call', name: 'read_file', arguments: JSON.stringify({ path: 'a'.repeat(1000) }) }] }] },
    { tools: [tool] },
  ]) assert.ok(estimateRequestTokens({ ...request, ...change }) > baseline);
});

test('session metadata and private replay state do not enlarge input estimates', () => {
  const largePrivateValue = 'private-state'.repeat(100_000);
  const messages = request.messages.map(message => ({ ...message, id: largePrivateValue,
    source: { provider: 'test', replayState: { response: largePrivateValue } }, createdAt: 100 }));
  assert.equal(estimateRequestTokens({ ...request, messages, sessionId: largePrivateValue }), estimateRequestTokens(request));
});

test('Chinese is counted more densely than the same number of ASCII characters', () => {
  assert.ok(estimateTextTokens('汉'.repeat(400)) >= estimateTextTokens('a'.repeat(400)) * 3);
  assert.ok(estimateTextTokens('你好🙂 abc') > 0);
});

test('many short tool schemas include their serialized field names and structure', () => {
  const tools = Array.from({ length: 100 }, (_, index) => ({ name: `t${index}`, description: '', parameters: {} }));
  const added = estimateRequestTokens({ ...request, tools }) - estimateRequestTokens(request);
  assert.ok(added >= estimateTextTokens(JSON.stringify(tools)));
});

test('old SDK fallback includes removed tools and schema revisions without exact duplicates', () => {
  const current = estimateRequestTokens({ ...request, tools: [tool] });
  const duplicate = { tools: [tool], updates: [{ messageId: 'm1', additions: [tool] }] };
  assert.equal(estimateRequestTokens({ ...request, tools: [tool], toolHistory: duplicate }), current);
  const removed = { ...tool, name: 'removed_tool' };
  const revised = { ...tool, description: 'a changed schema' };
  const history = { tools: [removed, tool], updates: [{ messageId: 'm1', additions: [revised] }] };
  assert.ok(estimateRequestTokens({ ...request, tools: [tool], toolHistory: history }) > current);
  assert.equal(estimateRequestTokens({ ...request, tools: [tool], toolHistory: history }, {
    projectRequest: input => ({ messages: input.messages, tools: input.tools }),
  }), current);
});

test('image occurrences use route visual tokens and text with checked alignment', () => {
  const image = { type: 'image', attachment: { attachmentId: 'same-image' } };
  const input = { ...request, messages: [{ role: 'user', content: [image, image, { ...image, offloaded: true }] }] };
  assert.equal(estimateRequestTokens(input), null);
  const count = estimateRequestTokens(input, { priceImages(images) {
    assert.equal(images.length, 3);
    assert.equal(images[2].offloaded, true);
    return [{ visualTokens: 512, text: 'image one' }, { visualTokens: 512, text: 'image two' }, { visualTokens: 0, text: 'offloaded image' }];
  } });
  assert.ok(count > 1024);
  for (const prices of [[], [{ visualTokens: -1, text: '' }], Array(3).fill({ visualTokens: NaN, text: '' })]) {
    assert.equal(estimateRequestTokens(input, { priceImages: () => prices }), null);
  }
});

test('projected text image placeholders can be measured without visual pricing', () => {
  const input = { ...request, messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }] }] };
  const tokens = estimateRequestTokens(input, { projectRequest: () => ({
    messages: [{ role: 'user', content: [{ type: 'text', text: '[image omitted]' }] }], tools: [],
  }) });
  assert.ok(tokens > 0 && tokens < 100);
});

test('file references use model-visible handle text regardless of binary size', () => {
  const input = bytes => ({ ...request, messages: [{ role: 'user', content: [{ type: 'file', attachment: { bytes } }] }] });
  assert.equal(estimateRequestTokens(input(1)), null);
  const helpers = { fileText: () => '[file: large.zip at /read-only/large.zip]' };
  assert.equal(estimateRequestTokens(input(1), helpers), estimateRequestTokens(input(1_000_000_000), helpers));
});

test('unknown input formats fall back to capacity and require it only when necessary', () => {
  const unknown = { ...request, messages: [{ role: 'user', content: [{ type: 'audio', data: 'opaque' }] }] };
  const fallback = estimateReservation(unknown, rates, DEFAULT_CONFIG, { contextWindow: 128_000 });
  assert.equal(fallback.source, 'context-fallback');
  assert.equal(fallback.inputTokens, 160_000);
  assert.throws(() => estimateReservation(unknown, rates, DEFAULT_CONFIG), /无法估算本次输入/);
  assert.throws(() => estimateReservation(request, rates, { ...DEFAULT_CONFIG, reservationMode: 'context' }), /严格预留/);
  assert.equal(estimateReservation(request, rates, DEFAULT_CONFIG, { contextWindow: 128_000 }, null).source, 'context-fallback');
});

test('reservation accounts for cache-write premiums without using the whole output limit', () => {
  const normal = estimateReservation(request, rates, DEFAULT_CONFIG);
  const premium = estimateReservation(request, { ...rates, cacheWrite: 10 }, DEFAULT_CONFIG);
  assert.ok(premium.costUsd > normal.costUsd);
  assert.equal(normal.outputTokens, DEFAULT_CONFIG.outputReservationTokens);
  assert.equal(premium.outputTokens, normal.outputTokens);
});

test('old configuration gains request mode while preserving the chosen multiplier', () => {
  const old = { ...DEFAULT_CONFIG, inputTokenMultiplier: 2 };
  delete old.reservationMode;
  const migrated = validateConfig(old);
  assert.equal(migrated.reservationMode, 'request');
  assert.equal(migrated.inputTokenMultiplier, 2);
  assert.equal(validateConfig({ reservationMode: 'context' }, migrated).reservationMode, 'context');
  assert.throws(() => validateConfig({ reservationMode: 'ignore-budget' }), /预留模式/);
});
