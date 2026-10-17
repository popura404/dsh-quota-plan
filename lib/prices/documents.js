// These parsers read public documentation as data. MDX is never evaluated.
export const DOCUMENT_SOURCES = [
  { id: 'openai', label: 'OpenAI', url: 'https://developers.openai.com/api/docs/pricing.md', kind: 'markdown', currency: 'USD' },
  { id: 'anthropic', label: 'Claude', url: 'https://platform.claude.com/docs/en/about-claude/pricing.md', kind: 'markdown', currency: 'USD' },
  { id: 'mistral', label: 'Mistral', url: 'https://docs.mistral.ai/inference/pricing.md', kind: 'markdown', currency: 'USD' },
  { id: 'bigmodel', label: '智谱 BigModel', url: 'https://docs.bigmodel.cn/cn/guide/start/pricing.md', kind: 'markdown', currency: 'CNY' },
  { id: 'zai', label: 'Z.AI', url: 'https://docs.z.ai/guides/overview/pricing.md', kind: 'markdown', currency: 'USD' },
  { id: 'kimi', label: 'Kimi', url: 'https://platform.kimi.com/docs/pricing/chat.md', kind: 'mdx', currency: 'CNY' },
  { id: 'minimax-cn', label: 'MiniMax 中国站', url: 'https://platform.minimax.cn/docs/guides/pricing-paygo.md', kind: 'markdown', currency: 'CNY' },
  { id: 'minimax', label: 'MiniMax 国际站', url: 'https://platform.minimax.io/docs/guides/pricing-paygo.md', kind: 'markdown', currency: 'USD' },
];

const CLAUDE_MODELS_URL = 'https://platform.claude.com/docs/en/models/overview.md';
const CONSERVATIVE_NOTE = '标准按量计费；同一模型的上下文、输出长度或缓存 TTL 档位按字段最高单价保守计算。';
const STORAGE_NOTE = '价格表包含按时间计费的缓存存储；此处只同步 token 单价，未计入存储费用。';

function text(value = '') {
  return String(value)
    .replace(/~~[\s\S]*?~~/g, '')
    .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\\([_$*|])/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim());
}

function tables(document) {
  const lines = document.split('\n');
  const result = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\|/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || '') && (lines[i + 1] || '').includes('-')) {
      const header = cells(line);
      const rows = [];
      let end = i + 2;
      while (end < lines.length && /^\s*\|/.test(lines[end])) rows.push(cells(lines[end++]));
      result.push({ header, rows, start: offset });
    }
    offset += line.length + 1;
  }
  return result;
}

function rate(value) {
  const clean = text(value);
  if (/^(?:free|免费|不计费)$/i.test(clean)) return 0;
  // Per-hour cache storage, per-request tools and non-token modalities cannot
  // be represented by the four token rates exposed by the quota engine.
  if (/\/(?:\s*(?:hour|hr|minute|min|second|sec|image|page|character|chars))\b|\/小时|\/次|\/秒|\/张|\/页/i.test(clean)) return undefined;
  const match = clean.match(/^(?:[¥￥$]\s*)?(\d+(?:\.\d+)?)(?:\s*(?:[¥￥$]|元))?(?=\s|\/|$|\()/);
  if (!match) return undefined;
  const number = Number(match[1]);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function field(header) {
  const clean = text(header).toLowerCase();
  if (/storage|存储/.test(clean)) return undefined;
  if (/cache.*(?:write|写入)|caching.*write|缓存写入/.test(clean)) return 'cacheWrite';
  if (/cached input|cache (?:hits?|read)|caching read|缓存命中|缓存读取/.test(clean) && !/未命中/.test(clean)) return 'cacheRead';
  if (/\boutput\b|输出/.test(clean)) return 'output';
  if (/\binput\b|输入/.test(clean)) return 'input';
  return undefined;
}

function rowRates(header, row) {
  const result = {};
  for (let i = 0; i < header.length; i++) {
    const key = field(header[i]);
    const number = key ? rate(row[i] || '') : undefined;
    if (number !== undefined) result[key] = Math.max(result[key] ?? 0, number);
  }
  return result;
}

function merge(entries) {
  const result = new Map();
  for (const entry of entries) {
    if (!entry.model || !Number.isFinite(entry.rates?.input) || !Number.isFinite(entry.rates?.output)) continue;
    const key = `${entry.currency}:${entry.model}`;
    const existing = result.get(key);
    if (!existing) result.set(key, { ...entry, notes: [...new Set(entry.notes || [])] });
    else {
      for (const [field, value] of Object.entries(entry.rates)) existing.rates[field] = Math.max(existing.rates[field] ?? 0, value);
      existing.aliases = [...new Set([...(existing.aliases || []), ...(entry.aliases || [])])];
      existing.notes = [...new Set([...existing.notes, ...(entry.notes || []), CONSERVATIVE_NOTE])];
    }
  }
  return [...result.values()].map(entry => {
    if (entry.rates.cacheRead === undefined) entry.notes.push('来源未提供缓存读取 token 单价。');
    if (entry.rates.cacheWrite === undefined) entry.notes.push('来源未提供缓存写入 token 单价。');
    entry.notes = [...new Set(entry.notes)];
    if (!entry.aliases?.length) delete entry.aliases;
    return entry;
  });
}

function parseOpenAI(document) {
  const result = [];
  for (const table of tables(document)) {
    const names = table.header.map(text);
    if (names.some(name => /training|modality|use case/i.test(name))) continue;
    const prefix = document.slice(0, table.start);
    const markers = [...prefix.matchAll(/^\s*(?:(?:#{1,4}\s+)?(Standard|Batch|Flex|Fast(?: mode)?|Ultrafast)(?: pricing data)?|(Flagship models|Cyber models|Life sciences models|Specialized models|Finetuning))\s*$/gm)];
    const marker = markers.at(-1);
    if (marker && !/^(?:Standard|Flagship models|Cyber models|Life sciences models|Specialized models)$/i.test(marker[1] || marker[2])) continue;
    const modelIndex = names.findIndex(name => /^model$/i.test(name));
    if (modelIndex < 0) continue;
    const categoryIndex = names.findIndex(name => /^category$/i.test(name));
    for (const row of table.rows) {
      if (categoryIndex >= 0 && !/^(?:ChatGPT|Codex|Search)$/i.test(text(row[categoryIndex]))) continue;
      const rawModel = text(row[modelIndex]);
      const model = rawModel.replace(/\s+\([^)]*(?:context|tokens)[^)]*\)/gi, '').trim();
      if (!/^[a-z][a-z0-9.-]+$/.test(model)) continue;
      result.push({ model, currency: 'USD', rates: rowRates(table.header, row), notes: [CONSERVATIVE_NOTE, '仅普通 Standard token 计费，不含工具、地域附加费、Fast 或 Ultrafast 服务费。'] });
    }
  }
  return merge(result);
}

function claudeNames(document) {
  const result = new Map();
  for (const table of tables(document)) {
    // The official comparison table is transposed: model names are headers,
    // Claude API ID/alias are rows. Do not reuse Bedrock/Vertex IDs.
    const idRows = table.rows.filter(row => /^Claude API (?:ID|alias)$/i.test(text(row[0])));
    for (let i = 1; i < table.header.length; i++) {
      const label = text(table.header[i]);
      if (!/^Claude\b/.test(label)) continue;
      const ids = idRows.flatMap(row => [...(row[i] || '').matchAll(/\bclaude-[a-z0-9.-]+\b/g)].map(match => match[0]));
      if (ids.length) result.set(label, [...new Set(ids)]);
    }
  }
  return result;
}

function canonicalClaude(name) {
  const match = name.match(/^Claude ([A-Za-z]+) (\d+)(?:\.(\d+))?$/);
  if (!match) return undefined;
  const major = Number(match[2]);
  const minor = Number(match[3] || 0);
  // The official ID specification defines this exact format from generation
  // 4.6 onward, including omission of the minor segment for major releases:
  // https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
  // Do not infer the dated/reordered IDs used by earlier generations.
  if (major < 4 || (major === 4 && minor < 6)) return undefined;
  return `claude-${match[1].toLowerCase()}-${match[2]}${match[3] ? `-${match[3]}` : ''}`;
}

function parseClaude(document, overview) {
  const ids = claudeNames(overview || '');
  const section = document.split(/^## Cloud platform pricing\s*$/m)[0];
  const entries = [];
  for (const table of tables(section)) {
    if (!table.header.some(header => /Base input tokens/i.test(text(header)))) continue;
    for (const row of table.rows) {
      const name = text(row[0]).replace(/\s+\(.*$/, '').trim();
      if (!/^Claude\b/.test(name)) continue;
      const canonical = canonicalClaude(name);
      const aliases = ids.get(name) || (canonical ? [canonical] : undefined);
      entries.push({ model: aliases?.[0] || name, ...(aliases ? { aliases: [name, ...aliases.slice(1)] } : {}), currency: 'USD', rates: rowRates(table.header, row), notes: [CONSERVATIVE_NOTE, ...(aliases ? [] : ['官方价格页仅提供显示名，尚未从型号目录确认 API ID；请手动按显示名映射。']), '仅普通 Claude API 费率，不含 Fast 模式、地域附加费或工具调用费用。'] });
    }
  }
  return merge(entries);
}

function parseMistral(document) {
  const result = [];
  for (const table of tables(document)) {
    const apiIndex = table.header.findIndex(header => /^API name$/i.test(text(header)));
    const priceIndex = table.header.findIndex(header => /^Price$/i.test(text(header)));
    if (apiIndex < 0 || priceIndex < 0) continue;
    for (const row of table.rows) {
      const model = text(row[apiIndex]);
      const rates = {};
      for (const part of (row[priceIndex] || '').split(/<br\s*\/?\s*>/i)) {
        const clean = text(part);
        const match = clean.match(/^(Cached input|Input|Output)\s+\$([\d.]+)\s*\/\s*M\s+Tokens\b/i);
        if (match) rates[match[1].toLowerCase() === 'cached input' ? 'cacheRead' : match[1].toLowerCase()] = Number(match[2]);
      }
      result.push({ model, currency: 'USD', rates, notes: ['采用官方 API name 与当前公开 token 单价；若正文列出促销价，取当前促销价，不取括号中的原价。'] });
    }
  }
  return merge(result);
}

function parseSimple(document, currency, { lowercase = false, minimax = false } = {}) {
  if (minimax) {
    // Only the LLM section is supported. A video context model can also have
    // token prices, but its input materials have additional non-token fees.
    const match = document.match(/^##\s+(?:LLM|语言模型)\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/m);
    document = match?.[1] || '';
    document = document.replace(/<Tab\s+title=["'](?:Priority[^"']*|优先[^"']*)["'][^>]*>[\s\S]*?<\/Tab>/gi, '');
  }
  const entries = [];
  for (const table of tables(document)) {
    const modelIndex = table.header.findIndex(header => /^(?:Model|模型|模型名称)$/i.test(text(header)));
    if (modelIndex < 0 || !table.header.some(header => field(header) === 'input') || !table.header.some(header => field(header) === 'output')) continue;
    const storage = table.header.some(header => /storage|存储/i.test(text(header)));
    for (const row of table.rows) {
      const rawName = text(row[modelIndex]).split('\n')[0].trim();
      const model = lowercase ? rawName.toLowerCase() : rawName;
      if (!model || /\s/.test(model)) continue;
      entries.push({ model, ...(lowercase && model !== rawName ? { aliases: [rawName] } : {}), currency, rates: rowRates(table.header, row), notes: [CONSERVATIVE_NOTE, ...(storage ? [STORAGE_NOTE] : []), ...(minimax ? ['仅 Standard 按量计费；已排除 Priority 档位和删除线原价。'] : [])] });
    }
  }
  return merge(entries);
}

// Parse only the JSON-compatible literal portion of a DocTable attribute.
// No JSX, arbitrary JavaScript, template literals, calls or spread are allowed.
function literalArray(source, from) {
  const start = source.indexOf('[', from);
  if (start < 0) throw new Error('DocTable 缺少静态数组');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) {
      const raw = source.slice(start, i + 1);
      // Kimi column objects have unquoted title/width keys and trailing commas.
      const json = raw.replace(/([{,]\s*)(title|width)\s*:/g, '$1"$2":').replace(/,\s*([\]}])/g, '$1');
      return JSON.parse(json);
    }
  }
  throw new Error('DocTable 静态数组不完整');
}

function parseKimi(document) {
  const entries = [];
  for (const match of document.matchAll(/<DocTable\b([\s\S]*?)\/>/g)) {
    const component = match[1];
    const columnsAt = component.search(/\bcolumns\s*=\s*\{/);
    const rowsAt = component.search(/\brows\s*=\s*\{/);
    if (columnsAt < 0 || rowsAt < 0) continue;
    const columns = literalArray(component, columnsAt);
    const rows = literalArray(component, rowsAt);
    if (!Array.isArray(columns) || !columns.every(item => item && typeof item.title === 'string') || !Array.isArray(rows)) throw new Error('Kimi DocTable 结构变化，已停止同步');
    const header = columns.map(item => item.title);
    const modelIndex = header.findIndex(item => item === '模型');
    const unitIndex = header.findIndex(item => item === '计费单位');
    if (modelIndex < 0 || unitIndex < 0) continue;
    for (const row of rows) {
      if (!Array.isArray(row) || !row.every(item => typeof item === 'string')) throw new Error('Kimi DocTable 出现非字符串价格数据');
      if (!/^1\s*M\s+tokens$/i.test(row[unitIndex] || '')) continue;
      const model = row[modelIndex];
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(model)) continue;
      entries.push({ model, currency: 'CNY', rates: rowRates(header, row), notes: [CONSERVATIVE_NOTE, '仅静态解析官方 MDX 的 DocTable JSON 数据，未执行文档代码。'] });
    }
  }
  return merge(entries);
}

export async function fetchDocumentSource(id, { fetchText }) {
  const source = DOCUMENT_SOURCES.find(item => item.id === id);
  if (!source) throw new Error(`未知官方文档价格源：${id}`);
  const document = await fetchText(source.url);
  if (typeof document !== 'string' || /^\s*<!doctype html|^\s*<html\b/i.test(document)) throw new Error(`${source.label} 未返回 Markdown/MDX，已停止同步`);
  let entries;
  if (id === 'openai') entries = parseOpenAI(document);
  else if (id === 'anthropic') {
    let overview = '';
    try { overview = await fetchText(CLAUDE_MODELS_URL); } catch { /* Keep unmapped display names instead of guessing IDs. */ }
    entries = parseClaude(document, overview);
  } else if (id === 'mistral') entries = parseMistral(document);
  else if (id === 'kimi') entries = parseKimi(document);
  else entries = parseSimple(document, source.currency, { lowercase: id === 'bigmodel' || id === 'zai', minimax: id.startsWith('minimax') });
  if (!entries.length) throw new Error(`${source.label} 未解析到完整的输入/输出 token 价格，官方文档格式可能已变化`);
  return entries;
}
