import { readFileSync, statSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DOCUMENT_SOURCES, fetchDocumentSource } from './prices/documents.js';
import { CATALOG_SOURCES, fetchCatalogSource } from './prices/catalogs.js';

const HOUR = 3_600_000;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_MODELS = 5000;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const HOSTS = new Set([
  'developers.openai.com', 'platform.openai.com', 'openai.com',
  'platform.claude.com', 'docs.anthropic.com', 'docs.mistral.ai',
  'api-docs.deepseek.com', 'ai.google.dev', 'docs.bigmodel.cn',
  'docs.z.ai', 'platform.kimi.com', 'platform.minimax.cn',
  'platform.minimax.io', 'www.siliconflow.cn', 'www.siliconflow.com',
  'siliconflow.cn', 'siliconflow.com', 'docs.cohere.com', 'cohere.com',
  'openrouter.ai', 'prices.azure.com', 'pricing.us-east-1.amazonaws.com',
]);
const CREDENTIAL_SOURCES = [
  { id: 'xai', label: 'xAI', url: 'https://docs.x.ai/developers/rest-api-reference/inference/models', kind: 'api', currency: 'USD' },
  { id: 'bailian', label: '阿里云百炼', url: 'https://help.aliyun.com/zh/model-studio/list-models', kind: 'api', currency: 'CNY' },
  { id: 'volcengine', label: '火山方舟', url: 'https://docs.volcengine.com/docs/ark/list-model-activations-api?lang=en', kind: 'api', currency: 'CNY' },
  { id: 'gcp', label: 'Google Cloud / Vertex AI', url: 'https://docs.cloud.google.com/billing/docs/how-to/get-pricing-information-api', kind: 'api', currency: 'USD' },
];

function descriptors(value) {
  return Array.isArray(value) ? value : Object.values(value ?? {});
}

const documents = descriptors(DOCUMENT_SOURCES);
const catalogs = descriptors(CATALOG_SOURCES);
const SOURCES = new Map([...documents, ...catalogs, ...CREDENTIAL_SOURCES].map(source => [source.id, {
  ...source, supported: !CREDENTIAL_SOURCES.some(item => item.id === source.id),
  parser: documents.some(item => item.id === source.id) ? fetchDocumentSource : fetchCatalogSource,
}]));

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && !Object.keys(value).some(key => BLOCKED_KEYS.has(key));
}

function validId(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
    && !value.split('/').some(part => BLOCKED_KEYS.has(part));
}

function validateEntries(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_MODELS) throw new Error('价格目录为空或超出数量限制');
  const seen = new Set();
  return input.map(entry => {
    if (!plain(entry) || !validId(entry.model) || seen.has(entry.model)
      || !['USD', 'CNY'].includes(entry.currency) || !plain(entry.rates)) {
      throw new Error('价格目录包含无效模型、重复型号或币种');
    }
    seen.add(entry.model);
    const rates = {};
    const notes = [];
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      const value = entry.rates[field] ?? (field.startsWith('cache') ? entry.rates.input : undefined);
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
        throw new Error('价格目录包含无效单价');
      }
      rates[field] = value;
      if (entry.rates[field] == null) notes.push(`${field === 'cacheRead' ? '缓存读取' : '缓存写入'}未单列，按输入单价保守估算`);
    }
    if (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || entry.aliases.length > 32
      || !entry.aliases.every(alias => validId(alias)))) throw new Error('价格目录包含无效模型别名');
    if (entry.notes !== undefined && (!Array.isArray(entry.notes) || entry.notes.length > 24
      || !entry.notes.every(note => typeof note === 'string' && note.length <= 1000
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(note)))) {
      throw new Error('价格目录包含无效计价说明');
    }
    return { model: entry.model, aliases: [...new Set(entry.aliases ?? [])], currency: entry.currency,
      rates, notes: [...new Set([...(entry.notes ?? []), ...notes])] };
  });
}

function timestamp(value, now) {
  return Number.isSafeInteger(value) && value >= 0 && value <= now + 300_000;
}

function decodeCache(text, now) {
  if (Buffer.byteLength(text) > MAX_CACHE_BYTES) throw new Error('价格缓存超出大小限制');
  const document = JSON.parse(text);
  if (!plain(document) || document.schema !== 1 || !plain(document.sources)
    || Object.keys(document.sources).length > 64) throw new Error('价格缓存格式无效');
  const result = new Map();
  for (const [id, item] of Object.entries(document.sources)) {
    if (!SOURCES.get(id)?.supported) continue;
    if (!plain(item) || !timestamp(item.checkedAt, now)) throw new Error('价格缓存时间无效');
    const checkedAt = item.checkedAt;
    const lastAttemptAt = timestamp(item.lastAttemptAt, now) ? item.lastAttemptAt : checkedAt;
    result.set(id, { checkedAt, lastAttemptAt, entries: validateEntries(item.entries) });
  }
  return result;
}

function configHours(value, fallback, min = 1, max = 8760) {
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function exchangeRate(config) {
  const value = config.pricingCnyPerUsd;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000 ? value : null;
}

function routes(config) {
  const configured = config.pricingRoutes ?? { 'deepseek-official': 'deepseek' };
  if (!plain(configured)) return [];
  return Object.entries(configured).filter(([provider, source]) => validId(provider, 200)
    && !/[\s/]/.test(provider) && typeof source === 'string' && SOURCES.has(source));
}

function modelMappings(config, provider) {
  if (!plain(config.pricingModelAliases)) return [];
  const prefix = `${provider}/`;
  return Object.entries(config.pricingModelAliases).filter(([id, model]) => id.startsWith(prefix)
    && validId(id.slice(prefix.length)) && validId(model));
}

function exactEntry(record, model) {
  const exact = record.entries.find(entry => entry.model === model);
  if (exact) return exact;
  const matches = record.entries.filter(entry => entry.aliases.includes(model));
  return matches.length === 1 ? matches[0] : null;
}

function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('价格来源地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !HOSTS.has(url.hostname)) throw new Error('价格请求只能访问允许的官方 HTTPS 来源');
  return url;
}

function errorSummary(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return '价格同步已取消或请求超时';
  // Never expose fetch errors, request URLs, headers or arbitrary parser output.
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/^(价格|官方来源|响应|重定向|无法取得|来源暂不支持)/.test(message) && message.length <= 160
    && !/https?:\/\/|authorization|api.?key|token=/i.test(message)) return message;
  return '官方来源读取或价格解析失败，保留上次有效缓存';
}

async function lockRecord(file) {
  const metadata = await stat(file);
  const raw = metadata.size <= 4096 ? await readFile(file, 'utf8')
    : `invalid:${metadata.size}:${metadata.mtimeMs}`;
  let owner;
  try { owner = JSON.parse(raw); } catch { /* incomplete legacy lock */ }
  if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
    try { process.kill(owner.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return { raw, dead: true }; }
    return { raw, dead: false };
  }
  return { raw, dead: Date.now() - metadata.mtimeMs > 30_000 };
}

async function acquireRecovery(lockFile) {
  let file = `${lockFile}.recovery`;
  for (let generation = 0; generation < 32; generation++) {
    let handle;
    const data = JSON.stringify({ pid: process.pid, token: randomUUID() });
    try {
      handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(data); }
      catch (error) {
        await handle.close().catch(() => {});
        await unlink(file).catch(() => {});
        throw error;
      }
      return { file, handle, data };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let record;
      try { record = await lockRecord(file); }
      catch (readError) {
        if (readError.code === 'ENOENT') continue;
        throw readError;
      }
      if (!record.dead) return null;
      // A dead recovery record is immutable. All contenders derive the same
      // next lock instead of racing to unlink and replace a possibly live one.
      const key = createHash('sha256').update(`${file}\0${record.raw}`).digest('hex').slice(0, 32);
      file = `${lockFile}.recovery.${key}`;
    }
  }
  throw new Error('价格缓存遗留恢复锁过多，请稍后重试');
}

async function releaseRecovery(recovery) {
  if (!recovery) return;
  await recovery.handle.close().catch(() => {});
  try { if (await readFile(recovery.file, 'utf8') === recovery.data) await unlink(recovery.file); }
  catch { /* another process cannot acquire this slot before its release */ }
}

export class PriceCatalog {
  constructor({ file, getConfig, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    if (typeof file !== 'string' || !file) throw new Error('价格缓存文件路径无效');
    this.file = file;
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cache = new Map();
    this.attempts = new Map();
    this.inflight = new Map();
    this.controllers = new Set();
    this.started = false;
    this.timer = null;
    this.saveTail = Promise.resolve();
    try {
      if (statSync(file).size > MAX_CACHE_BYTES) throw new Error('价格缓存超出大小限制');
      this.cache = decodeCache(readFileSync(file, 'utf8'), this.now());
    } catch (error) {
      // A malformed price cache must not prevent the quota restriction loading.
      if (error.code !== 'ENOENT') this.cacheError = '本地价格缓存无效，等待重新同步';
    }
  }

  currentConfig() {
    try { return this.getConfig() ?? {}; } catch { return {}; }
  }

  async fetchText(value, retried = false) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 20_000);
    timeout.unref?.();
    try {
      let url = safeUrl(value);
      for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await this.fetchImpl(url.href, { method: 'GET', redirect: 'manual',
          signal: controller.signal, headers: { Accept: '*/*',
            'User-Agent': 'dsh-quota-plan/0.2 price-catalog' } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel?.();
          if (!location || redirects === 3) throw new Error('重定向次数超出限制');
          url = safeUrl(new URL(location, url).href);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel?.();
          throw new Error(`官方来源返回 HTTP ${Number(response.status) || 0}`);
        }
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
          await response.body?.cancel?.();
          throw new Error('响应超过 12 MB 大小限制');
        }
        if (!response.body?.getReader) {
          const body = await response.text();
          if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('响应超过 12 MB 大小限制');
          return body;
        }
        const reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        try {
          for (;;) {
            const { value: chunk, done } = await reader.read();
            if (done) break;
            bytes += chunk.byteLength;
            if (bytes > MAX_BODY_BYTES) {
              await reader.cancel();
              throw new Error('响应超过 12 MB 大小限制');
            }
            chunks.push(Buffer.from(chunk));
          }
        } finally { reader.releaseLock(); }
        return Buffer.concat(chunks, bytes).toString('utf8');
      }
      throw new Error('重定向次数超出限制');
    } catch (error) {
      const code = error?.cause?.code ?? error?.code;
      if (!retried && !controller.signal.aborted
        && ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(code)) {
        // A dropped public GET connection is safe to retry once. Changed
        // schemas, authorization errors and timeouts do not loop indefinitely.
        return await this.fetchText(value, true);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  async fetchJson(url) {
    const body = await this.fetchText(url);
    try { return JSON.parse(body); } catch { throw new Error('官方来源返回的 JSON 无效'); }
  }

  async refresh({ sourceIds, force = false } = {}) {
    const config = this.currentConfig();
    const selected = sourceIds ?? [...new Set(routes(config).map(([, source]) => source))];
    if (!Array.isArray(selected) || selected.length > 16
      || !selected.every(id => typeof id === 'string' && SOURCES.has(id))) {
      throw new Error('价格来源必须是已知来源列表，且最多选择 16 个');
    }
    if (typeof force !== 'boolean') throw new Error('force 必须是布尔值');
    const ids = [...new Set(selected)];
    const outcomes = await Promise.allSettled(ids.map(id => this.refreshSource(id, config, force)));
    if (outcomes.some(result => result.status === 'fulfilled' && result.value)) {
      this.saveTail = this.saveTail.catch(() => {}).then(() => this.save());
      try { await this.saveTail; this.cacheError = null; }
      catch { this.cacheError = '价格已同步，但本地缓存保存失败'; }
    }
    this.schedule();
    return this.status(this.currentConfig());
  }

  refreshSource(id, config, force) {
    if (this.inflight.has(id)) return this.inflight.get(id);
    const source = SOURCES.get(id);
    if (!source.supported) return Promise.resolve(false);
    const now = this.now();
    const previous = this.cache.get(id);
    const interval = configHours(config.pricingRefreshHours, 24) * HOUR;
    const attempt = this.attempts.get(id);
    if (!force && ((previous && now - previous.checkedAt < interval && !attempt?.error)
      || (attempt?.error && now - attempt.at < Math.min(interval, HOUR)))) return Promise.resolve(false);
    this.attempts.set(id, { at: now, error: null });
    const task = (async () => {
      // Defer parsing until the promise has been registered, including parsers
      // which reject synchronously before making their first HTTP request.
      await Promise.resolve();
      try {
        const entries = validateEntries(await source.parser(id, {
          fetchText: url => this.fetchText(url), fetchJson: url => this.fetchJson(url), now: () => this.now(),
        }));
        this.cache.set(id, { entries, checkedAt: this.now(), lastAttemptAt: now });
        return true;
      } catch (error) {
        this.attempts.set(id, { at: now, error: errorSummary(error) });
        return false;
      } finally { this.inflight.delete(id); }
    })();
    this.inflight.set(id, task);
    return task;
  }

  convert(entry, source, checkedAt, config) {
    const conversion = entry.currency === 'CNY' ? exchangeRate(config) : 1;
    if (!conversion) return null;
    const rates = Object.fromEntries(Object.entries(entry.rates).map(([key, value]) => [key, value / conversion]));
    if (Object.values(rates).some(value => !Number.isFinite(value) || value > 1_000_000)) return null;
    return { ...rates, source: `${source.label} · 自动同步`, sourceId: source.id, sourceUrl: source.url,
      checkedAt, currency: 'USD', originalCurrency: entry.currency,
      notes: [...entry.notes, ...(entry.currency === 'CNY' ? [`按 1 USD = ${conversion} CNY 换算`] : [])] };
  }

  resolve(provider, model, config = this.currentConfig(), now = this.now()) {
    if (config.autoPricingEnabled === false || !validId(provider, 200) || !validId(model)) return null;
    const sourceId = routes(config).find(([key]) => key === provider)?.[1];
    const source = SOURCES.get(sourceId);
    const record = this.cache.get(sourceId);
    if (!source?.supported || !record || now < record.checkedAt - 300_000
      || now - record.checkedAt > configHours(config.pricingMaxAgeHours, 168) * HOUR) return null;
    const id = `${provider}/${model}`;
    const mapped = modelMappings(config, provider).find(([request]) => request === id)?.[1];
    const entry = exactEntry(record, mapped ?? model);
    if (!entry) return null;
    const converted = this.convert(entry, source, record.checkedAt, config);
    return converted ? { ...converted, id, catalogModel: entry.model,
      ...(mapped ? { mappedModel: mapped, notes: [...converted.notes, `显式型号映射：${model} → ${mapped}`] } : {}) } : null;
  }

  modelRow(id, entry, source, checkedAt, config, mappedModel) {
    const converted = this.convert(entry, source, checkedAt, config);
    const row = converted ? { id, ...converted, available: true }
      : { id, input: null, output: null, cacheRead: null, cacheWrite: null,
        available: false, waitingForExchangeRate: entry.currency === 'CNY' && !exchangeRate(config),
        currency: entry.currency, originalRates: { ...entry.rates }, source: `${source.label} · 等待汇率`,
        sourceId: source.id, sourceUrl: source.url, checkedAt,
        notes: [...entry.notes, '需配置 1 USD 对应的 CNY 汇率后才能用于额度计算'] };
    return { ...row, catalogModel: entry.model, ...(mappedModel
      ? { mappedModel, notes: [...row.notes, `显式型号映射：${id} → ${mappedModel}`] } : {}) };
  }

  models(config = this.currentConfig()) {
    if (config.autoPricingEnabled === false) return [];
    const now = this.now();
    const maximumAge = configHours(config.pricingMaxAgeHours, 168) * HOUR;
    const result = new Map();
    for (const [provider, sourceId] of routes(config)) {
      const record = this.cache.get(sourceId);
      const source = SOURCES.get(sourceId);
      if (!source?.supported || !record || now - record.checkedAt > maximumAge || now < record.checkedAt - 300_000) continue;
      for (const entry of record.entries) {
        const id = `${provider}/${entry.model}`;
        result.set(id, this.modelRow(id, entry, source, record.checkedAt, config));
      }
      for (const [id, mapped] of modelMappings(config, provider)) {
        const entry = exactEntry(record, mapped);
        // An explicit mapping wins over a same-named catalog row. Missing
        // mapping targets must not fall back to a possibly unrelated price.
        if (entry) result.set(id, this.modelRow(id, entry, source, record.checkedAt, config, mapped));
        else result.delete(id);
      }
    }
    return [...result.values()];
  }

  nextSync(config, now = this.now()) {
    if (!this.started || config.autoPricingEnabled === false) return null;
    const interval = configHours(config.pricingRefreshHours, 24) * HOUR;
    const due = [...new Set(routes(config).map(([, id]) => id))].filter(id => SOURCES.get(id)?.supported)
      .map(id => {
        const attempt = this.attempts.get(id);
        if (attempt?.error) return attempt.at + Math.min(interval, HOUR);
        const record = this.cache.get(id);
        return record ? record.checkedAt + interval : now + 1500;
      });
    return due.length ? Math.max(now + 1000, Math.min(...due)) : null;
  }

  status(config = this.currentConfig()) {
    const now = this.now();
    const maximumAge = configHours(config.pricingMaxAgeHours, 168) * HOUR;
    const bound = new Set(routes(config).map(([, id]) => id));
    const enabled = config.autoPricingEnabled !== false;
    const sources = [...SOURCES.values()].map(source => {
      const record = this.cache.get(source.id);
      const attempt = this.attempts.get(source.id);
      const waitingForExchangeRate = Boolean(record?.entries.some(entry => entry.currency === 'CNY') && !exchangeRate(config));
      let state = source.supported ? 'idle' : 'credentials-required';
      if (source.supported) {
        if (this.inflight.has(source.id)) state = 'refreshing';
        else if (attempt?.error) state = 'error';
        else if (record && now - record.checkedAt > maximumAge) state = 'stale';
        else if (waitingForExchangeRate) state = 'exchange-rate-required';
        else if (record) state = 'ready';
      }
      return { id: source.id, label: source.label, url: source.url, kind: source.kind, currency: source.currency,
        supported: source.supported, bound: bound.has(source.id), state,
        lastAttemptAt: attempt?.at ?? record?.lastAttemptAt ?? null, lastSuccessAt: record?.checkedAt ?? null,
        error: attempt?.error ?? null, modelCount: record?.entries.length ?? 0, waitingForExchangeRate };
    });
    return { enabled, refreshing: this.inflight.size > 0, sources, nextSyncAt: this.nextSync(config, now),
      ...(this.cacheError ? { cacheError: this.cacheError } : {}) };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.schedule(1500);
  }

  schedule(delay) {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.started) return;
    const config = this.currentConfig();
    const next = this.nextSync(config);
    // Recheck configuration periodically, including when automatic pricing is
    // disabled; no network is performed until a bound source is enabled.
    const wait = delay ?? (next === null ? 60_000 : Math.min(60_000, Math.max(1000, next - this.now())));
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!this.started) return;
      if (this.currentConfig().autoPricingEnabled !== false) {
        try { await this.refresh(); } catch { /* source failures are in status */ }
      }
      if (this.started && !this.timer) this.schedule();
    }, wait);
    this.timer.unref?.();
  }

  stop() {
    this.started = false;
    clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.controllers) controller.abort();
  }

  async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const lockFile = `${this.file}.lock`;
    const lockToken = randomUUID();
    const lockData = JSON.stringify({ pid: process.pid, token: lockToken });
    let lock;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        lock = await open(lockFile, 'wx', 0o600);
        try { await lock.writeFile(lockData); }
        catch (error) {
          await lock.close().catch(() => {});
          await unlink(lockFile).catch(() => {});
          lock = null;
          throw error;
        }
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Serialize dead-owner recovery so two processes cannot both remove
        // the stale lock and accidentally unlink the other's replacement.
        let recovery;
        try {
          recovery = await acquireRecovery(lockFile);
          if (recovery) {
            const owner = await lockRecord(lockFile);
            if (owner.dead) await unlink(lockFile).catch(() => {});
          }
        } catch (staleError) {
          if (!['ENOENT', 'EEXIST'].includes(staleError.code)) throw staleError;
        } finally { await releaseRecovery(recovery); }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (!lock) throw new Error('价格缓存正在被其它进程更新');
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      let disk = new Map();
      try {
        if ((await stat(this.file)).size <= MAX_CACHE_BYTES) disk = decodeCache(await readFile(this.file, 'utf8'), this.now());
      } catch { /* invalid or absent disk cache is replaced with validated data */ }
      for (const [id, record] of this.cache) {
        if (!disk.has(id) || disk.get(id).checkedAt <= record.checkedAt) disk.set(id, record);
      }
      const sources = Object.create(null);
      for (const [id, record] of disk) {
        const source = SOURCES.get(id);
        sources[id] = { label: source.label, url: source.url, kind: source.kind, currency: source.currency,
          checkedAt: record.checkedAt, lastAttemptAt: record.lastAttemptAt, entries: record.entries };
      }
      const encoded = JSON.stringify({ schema: 1, sources });
      if (Buffer.byteLength(encoded) > MAX_CACHE_BYTES) throw new Error('价格缓存超出大小限制');
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.file);
      // Import other processes' newer source snapshots after the atomic merge.
      for (const [id, record] of disk) {
        if (!this.cache.has(id) || this.cache.get(id).checkedAt < record.checkedAt) this.cache.set(id, record);
      }
    } finally {
      await unlink(temporary).catch(() => {});
      await lock.close().catch(() => {});
      try { if (await readFile(lockFile, 'utf8') === lockData) await unlink(lockFile); } catch { /* already released */ }
    }
  }
}
