import { text, tables, numeric, maxRate, tokenMultiplier, dollarRates, finish } from './catalogs-html.js';

const AZURE_URL = 'https://prices.azure.com/api/retail/prices?' + new URLSearchParams({
  '$filter': "contains(productName,'OpenAI') and armRegionName eq 'eastus2' and priceType eq 'Consumption'",
});
const BEDROCK_URL = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json';
const BEDROCK_SERVICE_URL = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockService/current/us-east-1/index.json';
const COHERE_PAGES = ['command-a', 'command-r', 'command-r-plus'];

export const CATALOG_SOURCES = Object.freeze([
  { id: 'deepseek', label: 'DeepSeek', url: 'https://api-docs.deepseek.com/quick_start/pricing/', kind: 'html', currency: 'USD' },
  { id: 'google', label: 'Gemini Developer API', url: 'https://ai.google.dev/gemini-api/docs/pricing?hl=en', kind: 'html', currency: 'USD' },
  { id: 'siliconflow-cn', label: '硅基流动 · 中国站', url: 'https://www.siliconflow.cn/pricing', kind: 'html', currency: 'CNY' },
  { id: 'siliconflow', label: 'SiliconFlow · 国际站', url: 'https://www.siliconflow.com/pricing', kind: 'html', currency: 'USD' },
  { id: 'cohere', label: 'Cohere', url: 'https://docs.cohere.com/docs/command-a', kind: 'html', currency: 'USD' },
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1/models', kind: 'json', currency: 'USD' },
  { id: 'azure', label: 'Azure OpenAI · East US 2', url: AZURE_URL, kind: 'json', currency: 'USD' },
  { id: 'bedrock', label: 'AWS Bedrock · US East 1', url: BEDROCK_URL, kind: 'json', currency: 'USD' },
]);

function parseDeepSeek(html) {
  const entries = [];
  for (const grid of tables(html)) {
    const header = grid.find(row => row.some(cell => /^MODEL$/i.test(cell)));
    if (!header) continue;
    for (let column = 0; column < header.length; column++) {
      const model = header[column]?.match(/\bdeepseek-[a-z\d.-]+/i)?.[0];
      if (!model) continue;
      const rates = {};
      for (const row of grid) {
        const label = row.slice(0, column).join(' ');
        const values = dollarRates(row[column] ?? '');
        if (!values.length) continue;
        const key = /OUTPUT TOKENS/i.test(label) ? 'output' : /INPUT TOKENS/i.test(label)
          ? /CACHE HIT/i.test(label) ? 'cacheRead' : 'input' : undefined;
        if (key) maxRate(rates, key, Math.max(...values));
      }
      // Cache misses/write-through use the normal input meter at DeepSeek.
      if (rates.input !== undefined) rates.cacheWrite = rates.input;
      const aliases = [];
      if (model === 'deepseek-flash') {
        // Accept aliases only while the official page explicitly documents them.
        for (const alias of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
          if (new RegExp(`<code>\\s*${alias}\\s*<\\/code>`).test(html)) aliases.push(alias);
        }
      }
      entries.push({ model, aliases, currency: 'USD', rates, notes: ['官方高峰价；不按时段折扣降低额度预留'] });
    }
  }
  return entries;
}

function parseGemini(html, now) {
  const entries = [];
  // A model section may contain Standard, Batch, Flex and Priority tables. Only
  // Standard is usable for the normal synchronous requests this plugin meters.
  const sections = [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2\b|$)/gi)];
  for (const section of sections) {
    const heading = text(section[1]);
    if (/live|transcrib|audio|tts|image|video|embedding|lyria|robotics/i.test(heading)) continue;
    const firstTable = section[2].search(/<table\b/i);
    if (firstTable < 0) continue;
    const intro = section[2].slice(0, firstTable);
    const models = [...intro.matchAll(/<code\b[^>]*>\s*(gemini-[a-z\d.-]+)\s*<\/code>/gi)].map(m => m[1]);
    if (!models.length) continue;
    const tier = [...intro.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)].at(-1);
    if (tier && !/^standard$/i.test(text(tier[1]))) continue;
    const table = tables(section[2].slice(firstTable))[0];
    if (!table) continue;
    const header = table.find(row => row.some(cell => /Paid Tier/i.test(cell)));
    const paid = header?.findIndex(cell => /Paid Tier.*(?:1M|million).*USD/i.test(cell.replace(/\n/g, ' '))) ?? -1;
    if (paid < 0) continue;
    const rates = {};
    let hasStorage = false;
    for (const row of table) {
      const label = row[0] ?? '';
      const key = /^Input price/i.test(label) ? 'input' : /^Output price/i.test(label) ? 'output'
        : /^Context cach(?:ing|e) price/i.test(label) ? 'cacheRead' : undefined;
      if (!key) continue;
      const cell = row[paid] ?? '';
      const values = dollarRates(cell, now, { textOnly: true });
      if (values.length) maxRate(rates, key, Math.max(...values));
      if (key === 'cacheRead' && /storage price|per hour/i.test(cell)) hasStorage = true;
    }
    for (const model of new Set(models)) entries.push({ model, currency: 'USD', rates: { ...rates }, notes: [
      'Developer API 标准付费档；按当前生效的最高上下文 token 费率估算',
      ...(hasStorage ? ['显式缓存的存储时间费不属于 token 单价；需另行计费'] : []),
    ] });
  }
  return entries;
}

function flightData(html) {
  // Flight chunks are JSON strings, not JavaScript programs. Decode strings and
  // locate the one published pricing array without executing the enclosing JS.
  let data = '';
  for (const match of html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g)) {
    data += JSON.parse(match[1]);
  }
  const marker = '"pricingApiItems":';
  const start = data.indexOf(marker);
  if (start < 0) throw new Error('硅基流动官方页面缺少 pricingApiItems 价格数组');
  const offset = data.indexOf('[', start + marker.length);
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (let i = offset; i >= 0 && i < data.length; i++) {
    const ch = data[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return JSON.parse(data.slice(offset, i + 1));
  }
  throw new Error('硅基流动官方价格数组不完整');
}

function parseSiliconFlowChina(html) {
  const models = new Map();
  const keys = { 'input-tokens': 'input', 'output-tokens': 'output', 'cached-input-tokens': 'cacheRead' };
  for (const item of flightData(html)) {
    const key = keys[item.componentCode];
    const factor = tokenMultiplier(item.unitZhCnName);
    const n = numeric(item.realTimePriceCnyUnit);
    if (!key || factor === undefined || n === undefined || item.payloadBizText !== 'online') continue;
    if (!item.playgroundName || /batch|priority|reserved|provisioned/i.test(`${item.coordinateDesc} ${item.skuName}`)) continue;
    const entry = models.get(item.playgroundName) ?? { model: item.playgroundName, currency: 'CNY', rates: {}, notes: [
      '中国站公开在线 API 价；K token 已换算为百万 token；采用各时间和上下文阶梯最高价',
    ] };
    maxRate(entry.rates, key, numeric(n * factor));
    models.set(item.playgroundName, entry);
  }
  return [...models.values()];
}

function parseSiliconFlowInternational(html) {
  const entries = [];
  if (!/Prices shown are per 1 million tokens/i.test(text(html))) throw new Error('SiliconFlow 国际页缺少百万 token 价格单位');
  // Framer renders both desktop and mobile cards. Desktop cards have a fixed
  // input/cache/output order; do not use media cards with per-image prices.
  const cards = html.split(/<div\b[^>]*data-framer-name="LLM - Desktop"[^>]*>/i).slice(1);
  for (const card of cards) {
    const end = card.search(/>Details<|data-framer-name="LLM - Mobile"|data-framer-name="LLM - Desktop"/i);
    const body = card.slice(0, end < 0 ? 12000 : end);
    const model = text(body.match(/data-framer-name="modelName"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '').trim();
    if (!model || /\s/.test(model)) continue;
    const rates = dollarRates(text(body));
    if (rates.length !== 2 && rates.length !== 3) continue;
    entries.push({ model, currency: 'USD', rates: {
      input: rates[0], output: rates.at(-1), ...(rates.length === 3 ? { cacheRead: rates[1] } : {}),
    }, notes: ['国际站公开在线 API 价；按页面精确型号匹配，不推测 Pro/厂商前缀别名'] });
  }
  return entries;
}

function parseCohere(html) {
  const content = text(html).replace(/\s+/g, ' ');
  const model = content.match(/Model ID\s+(command-[a-z\d.-]+)/i)?.[1];
  const pricing = content.match(/Pricing\s+Input\s+\$\s*([\d.]+)\s*\/\s*1M tokens\s+Output\s+\$\s*([\d.]+)\s*\/\s*1M tokens/i);
  if (!model || !pricing) return [];
  return [{ model, currency: 'USD', rates: { input: numeric(pricing[1]), output: numeric(pricing[2]) }, notes: [
    '来自官方具体模型文档；仅此版本，缓存单价未公布',
  ] }];
}

function parseOpenRouter(data) {
  const entries = [];
  for (const item of data.data ?? []) {
    if (!item.id || !item.architecture?.output_modalities?.includes('text')) continue;
    const price = item.pricing;
    if (!price) continue;
    const rates = {};
    for (const tier of [price, ...(Array.isArray(price.overrides) ? price.overrides : [])]) {
      for (const [field, key] of [['prompt', 'input'], ['completion', 'output'], ['input_cache_read', 'cacheRead'],
        ['input_cache_write', 'cacheWrite'], ['input_cache_write_1h', 'cacheWrite']]) {
        const n = numeric(tier[field]);
        if (n !== undefined) maxRate(rates, key, numeric(n * 1000000));
      }
    }
    entries.push({ model: item.id, currency: 'USD', rates, notes: [
      'OpenRouter 路由目录价；已取公开上下文/TTL 条件最高费率；指定供应商可能另有价格',
      ...(Object.keys(price).some(key => /request|search|image|audio/.test(key) && Number(price[key]) > 0)
        ? ['目录另有非文本 token 费用，此处未包含'] : []),
    ] });
  }
  return entries;
}

function azureItem(item, now) {
  const sku = String(item.skuName ?? '').toLowerCase();
  const meter = String(item.meterName ?? '');
  const product = String(item.productName ?? '');
  if (item.currencyCode !== 'USD' || item.type !== 'Consumption' || item.armRegionName !== 'eastus2') return undefined;
  const effective = Date.parse(item.effectiveStartDate);
  if (!Number.isFinite(effective) || effective > now || !/token/i.test(meter)) return undefined;
  if (/media|provisioned|priority|fine.?tun|\bFT\b/i.test(product)) return undefined;
  if (/batch|priority|flex|\bpp\b|\bft\b|rft|training|hosting|grader|realtime|\brt\b|audio|\baud\b|image|\bimg\b|tts|transcrib/i.test(sku)) return undefined;
  const factor = tokenMultiplier(item.unitOfMeasure);
  const amount = numeric(item.retailPrice);
  if (factor === undefined || amount === undefined) return undefined;
  const key = /\b(?:cache[d]?|cchd|cd)\s+(?:wr|write)\b/.test(sku) ? 'cacheWrite'
    : /\b(?:cache[d]?|cchd|cd)\b/.test(sku) ? 'cacheRead'
      : /\b(?:output|outpt?|outp|opt)\b/.test(sku) ? 'output'
        : /\b(?:input|inpt?|inp)\b/.test(sku) ? 'input' : undefined;
  if (!key) return undefined;
  const scope = /\b(?:glbl|global|gl)\b/.test(sku) ? 'global'
    : /\b(?:dz|dzone|data\s*zone)\b/.test(sku) ? 'data-zone'
      : /\b(?:regnl|regional|rgnl)\b/.test(sku) ? 'regional' : undefined;
  if (!scope) return undefined;
  let model = sku.replace(/\b(?:cache[d]?|cchd|cd|wr|write|input|inpt?|inp|output|outpt?|outp|opt|shortco|longco|loco|std|standard|glbl|global|gl|dz|dzone|data\s*zone|regnl|regional|rgnl)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // Compact meter abbreviations such as "54" are ambiguous; retain only
  // explicit published model names/versions instead of guessing an API ID.
  if (/^[56](?:\.\d+)?(?:-|\s|$)/.test(model)) model = `gpt ${model}`;
  if (!/^(?:gpt\s*-?\s*[\d]|o[134](?:-|\s|$))/.test(model)) return undefined;
  model = model.replace(/^gpt\s*-?\s*/, 'gpt-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/-$/, '');
  return { model: `${model}@eastus2/${scope}`, key, price: numeric(amount * factor), notes: [
    `仅 Azure eastus2 / ${scope} 部署；${product}；保守采用已公布上下文阶梯最高价`,
    '需使用带地域和部署类型的完整型号；不会套用于其它地域或原厂 API',
  ] };
}

async function fetchAzure(fetchJson, now) {
  const entries = new Map();
  let url = AZURE_URL;
  for (let page = 0; url && page < 6; page++) {
    const data = await fetchJson(url);
    for (const item of data.Items ?? []) {
      const parsed = azureItem(item, now);
      if (!parsed) continue;
      const entry = entries.get(parsed.model) ?? { model: parsed.model, currency: 'USD', rates: {}, notes: parsed.notes };
      maxRate(entry.rates, parsed.key, parsed.price);
      entries.set(parsed.model, entry);
    }
    if (!data.NextPageLink) { url = undefined; break; }
    const next = new URL(data.NextPageLink);
    if (next.protocol !== 'https:' || next.hostname !== 'prices.azure.com' || next.pathname !== '/api/retail/prices') throw new Error('Azure 价表分页地址无效');
    url = next.href;
  }
  if (url) throw new Error('Azure 价表超过 6 页，保留旧价格并等待缩小查询范围');
  return [...entries.values()];
}

function parseBedrock(data, now) {
  const entries = new Map();
  for (const [sku, product] of Object.entries(data.products ?? {})) {
    const attr = product.attributes ?? {};
    const usage = String(attr.usagetype ?? '');
    const details = Object.values(attr).join(' ');
    if (attr.regionCode !== 'us-east-1' || !attr.model) continue;
    if (/batch|priority|flex|reserved|provisioned|custom model|training|embedding|rerank|\b(?:audio|video|image)\b/i.test(details)) continue;
    const key = /cache[- ]write|prompt cache write/i.test(details) ? 'cacheWrite'
      : /cache[- ]read|prompt cache read/i.test(details) ? 'cacheRead'
        : /output[- ]token/i.test(details) ? 'output' : /input[- ]token/i.test(details) ? 'input' : undefined;
    if (!key) continue;
    const route = /cross-region-global/i.test(usage) ? 'global' : /cross-region/i.test(usage) ? 'cross-region' : /mantle/i.test(usage) ? 'mantle-standard' : 'regional';
    const explicit = usage.match(/^USE1-([a-z][\w-]*\.[\w.:-]+?)-(?:mantle-)?(?:input|output|cache)(?:-|$)/)?.[1];
    const base = explicit ?? String(attr.model).trim();
    const model = `${base}@us-east-1/${route}`;
    const entry = entries.get(model) ?? { model, currency: 'USD', rates: {}, notes: [
      `仅 AWS us-east-1 / ${route} 按量推理；采用公开上下文/缓存阶梯最高价`,
      '区域和路由已保留在型号中；未猜测带日期版本的 Bedrock 模型 ID',
    ] };
    for (const term of Object.values(data.terms?.OnDemand?.[sku] ?? {})) {
      const effective = Date.parse(term.effectiveDate);
      if (!Number.isFinite(effective) || effective > now) continue;
      for (const dimension of Object.values(term.priceDimensions ?? {})) {
        const multiplier = tokenMultiplier(dimension.unit);
        const amount = numeric(dimension.pricePerUnit?.USD);
        if (multiplier === undefined || amount === undefined) continue;
        maxRate(entry.rates, key, numeric(amount * multiplier));
      }
    }
    entries.set(model, entry);
  }
  return [...entries.values()];
}

export async function fetchCatalogSource(id, { fetchText, fetchJson, now = Date.now() }) {
  const source = CATALOG_SOURCES.find(item => item.id === id);
  if (!source) throw new Error(`未知官方价格源：${id}`);
  const at = typeof now === 'function' ? now() : Number(now);
  let entries;
  if (id === 'deepseek') entries = parseDeepSeek(await fetchText(source.url));
  else if (id === 'google') entries = parseGemini(await fetchText(source.url), at);
  else if (id === 'siliconflow-cn') entries = parseSiliconFlowChina(await fetchText(source.url));
  else if (id === 'siliconflow') entries = parseSiliconFlowInternational(await fetchText(source.url));
  else if (id === 'cohere') {
    const pages = await Promise.all(COHERE_PAGES.map(page => fetchText(`https://docs.cohere.com/docs/${page}`)));
    entries = pages.flatMap(parseCohere);
  } else if (id === 'openrouter') entries = parseOpenRouter(await fetchJson(source.url));
  else if (id === 'azure') entries = await fetchAzure(fetchJson, at);
  else if (id === 'bedrock') {
    // Region-specific files stay small; never fetch the very large global offer.
    const data = await Promise.all([fetchJson(BEDROCK_URL), fetchJson(BEDROCK_SERVICE_URL)]);
    entries = data.flatMap(value => parseBedrock(value, at));
  }
  return finish(entries, id);
}
