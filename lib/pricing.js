import { estimateRequestTokens } from './request-estimate.js';

// Rates are USD per million tokens. Official peak prices are intentionally
// used throughout the day, so the local ledger conservatively budgets costs.
// https://api-docs.deepseek.com/quick_start/pricing/ (checked 2026-10-13)
const FLASH = Object.freeze({ input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2 });
const PRO = Object.freeze({ input: 1.32, cacheRead: 0.044, cacheWrite: 1.32, output: 3.96 });
export const BUILTIN_RATES = Object.freeze({
  'deepseek-official/deepseek-flash': FLASH,
  'deepseek-official/deepseek-v4-flash': FLASH,
  'deepseek-official/deepseek-v4-flash-vision-exp': FLASH,
  'deepseek-official/deepseek-v4-pro': PRO,
});

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true, fiveHourEnabled: true,
  fiveHourLimitUsd: 4, weeklyLimitUsd: 20,
  outputReservationTokens: 2048, inputTokenMultiplier: 1.25, reservationMode: 'request', modelRates: {},
  autoPricingEnabled: true, pricingRefreshHours: 24, pricingMaxAgeHours: 168,
  pricingCnyPerUsd: null, pricingRoutes: { 'deepseek-official': 'deepseek' }, pricingModelAliases: {},
});

const PRICE_SOURCES = new Set(['deepseek', 'openai', 'anthropic', 'google', 'mistral',
  'bigmodel', 'zai', 'kimi', 'minimax-cn', 'minimax', 'siliconflow-cn', 'siliconflow',
  'cohere', 'openrouter', 'azure', 'bedrock']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function dictionary(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => UNSAFE_KEYS.has(key))) throw new Error(`${label}必须是普通对象`);
}

function modelKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
    && !value.split('/').some(part => UNSAFE_KEYS.has(part));
}

function positive(value, key, max = 1000000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new Error(`${key} 必须是大于 0 且不超过 ${max} 的数字`);
  }
}

function migrateOutputReservation(config) {
  const { maxOutputTokens, ...next } = config;
  if (Object.hasOwn(config, 'maxOutputTokens')) {
    positive(maxOutputTokens, '旧输出 token 上限');
    if (!Number.isSafeInteger(maxOutputTokens)) throw new Error('旧输出 token 上限必须是整数');
    if (!Object.hasOwn(config, 'outputReservationTokens')) {
      // The former default becomes the new fallback. Other explicit values
      // remain useful estimates, but never constrain the model's generation.
      next.outputReservationTokens = maxOutputTokens === 8192 ? DEFAULT_CONFIG.outputReservationTokens : maxOutputTokens;
    }
  }
  return next;
}

export function validateConfig(input, previous = DEFAULT_CONFIG) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是 JSON 对象');
  const allowed = new Set([...Object.keys(DEFAULT_CONFIG), 'maxOutputTokens']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`未知配置项：${key}`);
  const config = { ...DEFAULT_CONFIG, ...migrateOutputReservation(previous), ...migrateOutputReservation(input) };
  for (const key of ['enabled', 'fiveHourEnabled', 'autoPricingEnabled']) {
    if (typeof config[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
  }
  positive(config.fiveHourLimitUsd, '5 小时额度');
  positive(config.weeklyLimitUsd, '每周额度');
  positive(config.outputReservationTokens, '无历史时输出预留 tokens', 1000000);
  if (!Number.isSafeInteger(config.outputReservationTokens)) throw new Error('输出预留 token 数必须是整数');
  if (!Number.isFinite(config.inputTokenMultiplier) || config.inputTokenMultiplier < 1 || config.inputTokenMultiplier > 10) {
    throw new Error('输入预留倍数必须在 1 至 10 之间');
  }
  if (!['request', 'context'].includes(config.reservationMode)) {
    throw new Error('预留模式必须是 request 或 context');
  }
  for (const key of ['pricingRefreshHours', 'pricingMaxAgeHours']) positive(config[key], key, 8760);
  if (config.pricingRefreshHours < 1 || config.pricingMaxAgeHours < config.pricingRefreshHours) {
    throw new Error('价格刷新间隔至少为 1 小时，有效期不能短于刷新间隔');
  }
  if (config.pricingCnyPerUsd !== null) positive(config.pricingCnyPerUsd, '人民币换算汇率');
  dictionary(config.pricingRoutes, '价格来源绑定');
  dictionary(config.pricingModelAliases, '精确型号映射');
  if (Object.keys(config.pricingRoutes).length > 64 || Object.keys(config.pricingModelAliases).length > 256) {
    throw new Error('价格来源绑定或型号映射过多');
  }
  for (const [provider, source] of Object.entries(config.pricingRoutes)) {
    if (!modelKey(provider) || provider.length > 200 || /[\s/]/.test(provider) || !PRICE_SOURCES.has(source)) {
      throw new Error('价格来源绑定包含无效服务 ID 或尚未支持的来源');
    }
  }
  for (const [request, model] of Object.entries(config.pricingModelAliases)) {
    const separator = request.indexOf('/');
    if (!modelKey(request) || separator < 1 || separator === request.length - 1
      || /\s/.test(request.slice(0, separator)) || !modelKey(model)
      || !Object.hasOwn(config.pricingRoutes, request.slice(0, separator))) {
      throw new Error('型号映射需要完整的服务/模型 ID，且该服务已绑定价格来源');
    }
  }
  if (!config.modelRates || typeof config.modelRates !== 'object' || Array.isArray(config.modelRates)) {
    throw new Error('模型单价必须是对象');
  }
  const rates = {};
  for (const [model, price] of Object.entries(config.modelRates)) {
    if (!model || model.length > 200 || /[\u0000-\u001f]/.test(model) || ['__proto__', 'constructor', 'prototype'].includes(model)) {
      throw new Error('模型名称无效');
    }
    rates[model] = validateRates(price);
  }
  return { ...config, modelRates: rates, pricingRoutes: { ...config.pricingRoutes },
    pricingModelAliases: { ...config.pricingModelAliases } };
}

export function validateRates(price) {
  if (!price || typeof price !== 'object') throw new Error('模型单价必须是对象');
  const result = {};
  for (const key of ['input', 'cacheRead', 'output']) {
    if (typeof price[key] !== 'number' || !Number.isFinite(price[key]) || price[key] < 0 || price[key] > 1000000) {
      throw new Error(`${key} 单价必须是非负有限数字`);
    }
    result[key] = price[key];
  }
  result.cacheWrite = price.cacheWrite ?? price.input;
  if (!Number.isFinite(result.cacheWrite) || result.cacheWrite < 0 || result.cacheWrite > 1000000) {
    throw new Error('cacheWrite 单价必须是非负有限数字');
  }
  return result;
}

export function resolveRates(options, config, priceCatalog) {
  // An exact provider/model override always wins. A model-only override is
  // an explicit user choice that can be shared between their provider routes.
  const id = `${options.provider}/${options.model}`;
  const custom = config.modelRates[id] ?? config.modelRates[options.model];
  if (custom) return { ...validateRates(custom), source: '手动单价', id };
  const automatic = priceCatalog?.resolve(options.provider, options.model, config);
  if (automatic) return { ...automatic, ...validateRates(automatic), id };
  const rate = BUILTIN_RATES[id];
  if (!rate) throw new Error(`尚未取得 ${id} 的可用美元单价，请同步价格、检查来源绑定和汇率，或设置手动单价。`);
  return { ...validateRates(rate), source: '内置参考价 · 2026-10-13', id };
}

export function priceUsage(usage, rates) {
  if (!usage || typeof usage !== 'object') throw new Error('模型没有返回有效的 token 用量');
  let total = 0;
  // DSH explicitly defines these as disjoint counts. Do not subtract cache
  // hits from inputTokens a second time or double charge reasoningTokens.
  for (const [field, rate] of [['inputTokens', rates.input], ['outputTokens', rates.output],
    ['cacheReadTokens', rates.cacheRead], ['cacheWriteTokens', rates.cacheWrite]]) {
    const n = usage[field] ?? (field.startsWith('cache') ? 0 : NaN);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`无效 token 用量：${field}`);
    total += n * rate / 1000000;
  }
  if (!Number.isFinite(total)) throw new Error('费用无法计算');
  return Math.ceil(total * 1000000 - 1e-8) / 1000000;
}

function estimateOutputReservation(options, config, recentRecords) {
  // Learn from real completed calls only. Estimated/failed calls would feed
  // our own fallback or truncated output back into the next prediction.
  const samples = recentRecords.map((record, index) => ({ record, index }))
    .filter(({ record }) => record?.provider === options.provider && record?.model === options.model
      && typeof record?.provider === 'string' && typeof record?.model === 'string'
      && record.status === 'completed'
      && Number.isSafeInteger(record.usage?.outputTokens) && record.usage.outputTokens >= 0)
    .sort((a, b) => (b.record.at ?? 0) - (a.record.at ?? 0) || b.index - a.index)
    .slice(0, 20).map(({ record }) => record.usage.outputTokens).sort((a, b) => a - b);
  const historical = samples.length >= 5;
  const estimate = historical
    ? Math.max(256, Math.ceil(samples[Math.ceil(samples.length * 0.9) - 1] * 1.25))
    : config.outputReservationTokens;
  if (!Number.isSafeInteger(estimate) || estimate <= 0) throw new Error('输出预留 token 数量无效或超出安全范围');
  // A smaller native request limit can reduce the hold. Missing or larger
  // limits require no special treatment; never fill or rewrite maxTokens.
  const outputTokens = Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0
    ? Math.min(estimate, options.maxTokens) : estimate;
  return { outputTokens, outputSource: historical ? 'history' : 'fallback', outputSampleCount: samples.length };
}

export function estimateReservation(options, rates, config, { contextWindow } = {}, estimatedInputTokens = undefined, recentRecords = []) {
  const strict = config.reservationMode === 'context';
  const estimate = strict ? null : estimatedInputTokens === undefined
    ? estimateRequestTokens(options) : estimatedInputTokens;
  const measured = Number.isSafeInteger(estimate) && estimate > 0;
  if (!measured && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)) {
    throw new Error(strict
      ? '严格预留需要模型上下文容量，请补全 DSH 模型配置，或切换为按本次输入估算。'
      : '无法估算本次输入，且模型没有公开上下文容量。请补全 DSH 模型配置或使用支持估算的输入格式。');
  }
  const inputTokens = Math.ceil((measured ? estimate : contextWindow) * config.inputTokenMultiplier);
  if (!Number.isSafeInteger(inputTokens)) throw new Error('输入预留 token 数量超出安全范围');
  const output = estimateOutputReservation(options, config, recentRecords);
  const costUsd = (inputTokens * Math.max(rates.input, rates.cacheRead, rates.cacheWrite)
    + output.outputTokens * rates.output) / 1000000;
  return { costUsd: Math.ceil(costUsd * 1000000 - 1e-8) / 1000000, inputTokens, ...output,
    source: measured ? 'request' : strict ? 'context' : 'context-fallback' };
}

export function pricingModels(config, priceCatalog, availableModels = []) {
  const models = new Map(Object.entries(BUILTIN_RATES).map(([id, rate]) => [id,
    { id, ...rate, source: '内置参考价 · 2026-10-13' }]));
  for (const model of priceCatalog?.models(config) ?? []) models.set(model.id, model);
  for (const model of availableModels) {
    if (!model?.provider || !model?.id) continue;
    const automatic = priceCatalog?.resolve(model.provider, model.id, config);
    if (automatic) models.set(automatic.id, automatic);
  }
  for (const [id, rate] of Object.entries(config.modelRates)) {
    models.set(id, { id, ...rate, source: '手动单价' });
  }
  for (const id of models.keys()) {
    const separator = id.indexOf('/');
    if (separator < 1 || Object.hasOwn(config.modelRates, id)) continue;
    const model = id.slice(separator + 1);
    if (!Object.hasOwn(config.modelRates, model)) continue;
    models.set(id, { id, ...validateRates(config.modelRates[model]), source: `手动单价 · ${model}`,
      manualFrom: model, currency: 'USD', available: true,
      notes: ['沿用同名模型的手动单价；精确服务/模型单价优先。'] });
  }
  return [...models.values()];
}
