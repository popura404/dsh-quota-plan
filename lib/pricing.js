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
  maxOutputTokens: 8192, inputTokenMultiplier: 1.25, modelRates: {},
});

function positive(value, key, max = 1000000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new Error(`${key} 必须是大于 0 且不超过 ${max} 的数字`);
  }
}

export function validateConfig(input, previous = DEFAULT_CONFIG) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是 JSON 对象');
  const allowed = new Set(Object.keys(DEFAULT_CONFIG));
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`未知配置项：${key}`);
  const config = { ...previous, ...input };
  for (const key of ['enabled', 'fiveHourEnabled']) {
    if (typeof config[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
  }
  positive(config.fiveHourLimitUsd, '5 小时额度');
  positive(config.weeklyLimitUsd, '每周额度');
  positive(config.maxOutputTokens, '输出 token 上限', 1000000);
  if (!Number.isSafeInteger(config.maxOutputTokens)) throw new Error('输出 token 上限必须是整数');
  if (!Number.isFinite(config.inputTokenMultiplier) || config.inputTokenMultiplier < 1 || config.inputTokenMultiplier > 10) {
    throw new Error('输入预留倍数必须在 1 至 10 之间');
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
  return { ...config, modelRates: rates };
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

export function resolveRates(options, config) {
  // An exact provider/model override always wins. A model-only override is
  // an explicit user choice that can be shared between their provider routes.
  const id = `${options.provider}/${options.model}`;
  const custom = config.modelRates[id] ?? config.modelRates[options.model];
  const rate = custom ?? BUILTIN_RATES[id];
  if (!rate) throw new Error(`尚未配置 ${id} 的美元单价，请在额度设置中添加后再使用。`);
  return { ...validateRates(rate), source: custom ? '手动单价' : '官方高峰价 · 2026-10-13', id };
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

export function estimateReservation(options, rates, config, { contextWindow } = {}) {
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0) {
    throw new Error('本次请求没有明确的输出 token 上限，已停止调用。请在 DSH 模型设置中配置输出上限。');
  }
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error('该模型没有公开上下文 token 上限，无法预留最高费用，已停止调用。请在 DSH 模型配置中补全上下文容量。');
  }
  if (options.maxTokens > config.maxOutputTokens) {
    throw new Error(`本次输出上限 ${options.maxTokens} 超过额度设置的 ${config.maxOutputTokens}，已停止调用。请降低 DSH 模型输出上限或调整额度设置。`);
  }
  // Token meters in DSH are heuristics. Reserve the entire model context
  // capacity as an input upper bound, including images and tool schemas.
  // Extra cache-write premiums and a configurable margin are included.
  const inputTokens = Math.ceil(contextWindow * config.inputTokenMultiplier);
  const costUsd = (inputTokens * Math.max(rates.input, rates.cacheRead, rates.cacheWrite)
    + options.maxTokens * rates.output) / 1000000;
  return { costUsd: Math.ceil(costUsd * 1000000) / 1000000, inputTokens, outputTokens: options.maxTokens };
}

export function pricingModels(config) {
  const keys = new Set([...Object.keys(BUILTIN_RATES), ...Object.keys(config.modelRates)]);
  return [...keys].map(id => ({ id, ...(config.modelRates[id] ?? BUILTIN_RATES[id]),
    source: config.modelRates[id] ? '手动单价' : '官方高峰价 · 2026-10-13' }));
}
