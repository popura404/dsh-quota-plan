/**
 * Shared, dependency-free quota accounting. Amounts are rounded up to one
 * micro-dollar, so a sub-micro-dollar estimate can never reserve zero.
 *
 * The host must persist every mutation before forwarding a request and hold a
 * single process/file lock around this engine. Synchronous reserve() prevents
 * overselling within one process; it is not a cross-process lock.
 */
export const MICRO_USD = 1_000_000;
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  fiveHourEnabled: true,
  fiveHourLimitUsd: 4,
  weeklyLimitUsd: 20,
});

const DURATIONS = Object.freeze({ fiveHour: 5 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 });
const WINDOW_NAMES = Object.keys(DURATIONS);
const RECENT_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** Convert decimal USD to integer microUSD, conservatively rounding up. */
export function usdToMicroUsd(value, { positive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    throw new TypeError(positive ? 'Amount must be a finite positive USD number.' : 'Amount must be a finite non-negative USD number.');
  }
  const [mantissa, exponentText = '0'] = String(value).toLowerCase().split('e');
  const exponent = Number(exponentText);
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction);
  const scale = fraction.length - exponent;
  let micro;
  if (scale <= 6) {
    micro = digits * (10n ** BigInt(6 - scale));
  } else {
    const divisor = 10n ** BigInt(scale - 6);
    micro = (digits + divisor - 1n) / divisor;
  }
  if (micro > MAX_SAFE_BIGINT) throw new RangeError('USD amount exceeds the safe integer accounting range.');
  return Number(micro);
}

export function microUsdToUsd(value) {
  return value / MICRO_USD;
}

function validTime(now) {
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) {
    throw new TypeError('now must be a non-negative integer Unix timestamp in milliseconds.');
  }
  return now;
}

function validMicro(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid persisted ${label}.`);
  return value;
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function validatedConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('config must be an object.');
  const next = { ...DEFAULT_CONFIG, ...cloneJSON(config) };
  if (typeof next.enabled !== 'boolean' || typeof next.fiveHourEnabled !== 'boolean') {
    throw new TypeError('enabled and fiveHourEnabled must be booleans.');
  }
  for (const key of ['fiveHourLimitUsd', 'weeklyLimitUsd']) {
    next[key] = microUsdToUsd(usdToMicroUsd(next[key]));
  }
  return next;
}

function metadataOnly(metadata = {}) {
  const result = {};
  // Keep accounting context, never prompts, API keys, or full request bodies.
  for (const key of ['model', 'provider', 'sessionId', 'profile', 'requestId', 'purpose', 'status', 'error', 'ownerPid', 'startedAt', 'pricingSource', 'inputTokens', 'outputTokens', 'cacheHitTokens', 'cacheMissTokens', 'reservationSource', 'reservedInputTokens', 'reservedOutputTokens', 'outputReservationSource', 'outputReservationSamples']) {
    const value = metadata?.[key];
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
  }
  if (metadata?.usage && typeof metadata.usage === 'object' && !Array.isArray(metadata.usage)) {
    const usage = {};
    for (const [key, value] of Object.entries(metadata.usage)) {
      if (key.endsWith('Tokens') && Number.isSafeInteger(value) && value >= 0) usage[key] = value;
    }
    if (Object.keys(usage).length) result.usage = usage;
  }
  return result;
}

function dayKey(at) {
  return new Date(at + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function periodLabel(name) {
  return name === 'fiveHour' ? '5 小时' : '每周';
}

export class BudgetEngine {
  constructor({ config = {}, state } = {}) {
    this.config = validatedConfig(config);
    this.windows = Object.fromEntries(WINDOW_NAMES.map(name => [name, { startsAt: null, usedMicroUsd: 0 }]));
    this.reservations = new Map();
    this.recent = [];
    this.daily = new Map();
    this.lastNow = 0;
    if (state !== undefined) {
      this.importState(state);
      if (Object.keys(config).length) this.config = validatedConfig({ ...this.config, ...config });
    }
  }

  static fromState(state, config = {}) {
    return new BudgetEngine({ state, config });
  }

  /** Invalid/corrupted state is rejected; it must never silently reset a quota. */
  importState(state) {
    if (!state || state.version !== 1) throw new TypeError('Unsupported or invalid quota state version.');
    const config = validatedConfig(state.config);
    const lastNow = validTime(state.lastNow);
    const windows = {};
    for (const name of WINDOW_NAMES) {
      const value = state.windows?.[name];
      if (!value) throw new TypeError(`Missing persisted ${name} window.`);
      const startsAt = value.startsAt === null ? null : validTime(value.startsAt);
      const usedMicroUsd = validMicro(value.usedMicroUsd, `${name} usage`);
      if ((startsAt === null && usedMicroUsd !== 0) || (startsAt !== null && startsAt > lastNow)) {
        throw new TypeError(`Invalid persisted ${name} window boundary.`);
      }
      windows[name] = { startsAt, usedMicroUsd };
    }
    if (!Array.isArray(state.reservations) || !Array.isArray(state.recent) || !Array.isArray(state.daily)) {
      throw new TypeError('Missing persisted accounting collections.');
    }
    const reservations = new Map();
    let reserved = 0;
    for (const value of state.reservations) {
      if (typeof value.id !== 'string' || !value.id || reservations.has(value.id)) throw new TypeError('Invalid or duplicate persisted reservation id.');
      const amountMicroUsd = validMicro(value.amountMicroUsd, 'reservation amount');
      if (amountMicroUsd === 0) throw new TypeError('Persisted reservation amount must be positive.');
      reserved += amountMicroUsd;
      if (!Number.isSafeInteger(reserved)) throw new RangeError('Persisted reservation sum is too large.');
      const createdAt = validTime(value.createdAt);
      if (createdAt > lastNow || !['pending', 'uncertain'].includes(value.status)) throw new TypeError('Invalid persisted reservation status or timestamp.');
      reservations.set(value.id, { id: value.id, amountMicroUsd, createdAt, status: value.status, metadata: metadataOnly(value.metadata) });
    }
    if (reservations.size && WINDOW_NAMES.some(name => windows[name].startsAt === null)) {
      throw new TypeError('Pending reservations require active persisted windows.');
    }
    const recent = state.recent.slice(-RECENT_LIMIT).map(value => {
      if (typeof value.id !== 'string' || !value.id || reservations.has(value.id)) throw new TypeError('Invalid persisted settled request id.');
      const at = validTime(value.at);
      if (at > lastNow) throw new TypeError('Persisted settlement is in the future.');
      return { id: value.id, at, costMicroUsd: validMicro(value.costMicroUsd, 'settlement cost'), status: typeof value.status === 'string' ? value.status : 'completed', ...metadataOnly(value) };
    });
    if (new Set(recent.map(value => value.id)).size !== recent.length) throw new TypeError('Duplicate persisted settled request id.');
    const daily = new Map();
    for (const value of state.daily) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date) || daily.has(value.date)) throw new TypeError('Invalid persisted daily date.');
      daily.set(value.date, validMicro(value.costMicroUsd, 'daily usage'));
    }
    // Assign only after the entire state validates.
    this.config = config;
    this.windows = windows;
    this.reservations = reservations;
    this.recent = recent;
    this.daily = daily;
    this.lastNow = lastNow;
    return this;
  }

  _reservedMicroUsd() {
    let total = 0;
    for (const value of this.reservations.values()) total += value.amountMicroUsd;
    return total;
  }

  _touch(now) {
    // A clock moving backwards must not rewind a cycle or recover spent funds.
    now = Math.max(validTime(now), this.lastNow);
    this.lastNow = now;
    const reserved = this._reservedMicroUsd();
    for (const name of WINDOW_NAMES) {
      const window = this.windows[name];
      if (window.startsAt !== null && now >= window.startsAt + DURATIONS[name]) {
        window.usedMicroUsd = 0;
        // Unfinished paid/unknown requests continue to hold their reservation
        // across every rollover. No pending amount disappears on restart.
        window.startsAt = reserved > 0
          ? window.startsAt + Math.floor((now - window.startsAt) / DURATIONS[name]) * DURATIONS[name]
          : null;
      }
    }
    const oldest = dayKey(now - Math.min(now, 6 * DAY_MS));
    for (const key of this.daily.keys()) if (key < oldest || key > dayKey(now)) this.daily.delete(key);
    return now;
  }

  _startWindows(now) {
    for (const name of WINDOW_NAMES) if (this.windows[name].startsAt === null) this.windows[name].startsAt = now;
  }

  _limitMicroUsd(name) {
    return usdToMicroUsd(name === 'fiveHour' ? this.config.fiveHourLimitUsd : this.config.weeklyLimitUsd);
  }

  _enabled(name) {
    return this.config.enabled && (name === 'weekly' || this.config.fiveHourEnabled);
  }

  _record(record) {
    this.recent.push(record);
    if (this.recent.length > RECENT_LIMIT) this.recent.splice(0, this.recent.length - RECENT_LIMIT);
    if (record.costMicroUsd > 0) {
      const key = dayKey(record.at);
      const cost = (this.daily.get(key) || 0) + record.costMicroUsd;
      if (!Number.isSafeInteger(cost)) throw new RangeError('Daily accounting range exceeded.');
      this.daily.set(key, cost);
    }
  }

  reserve({ id, amountUsd, metadata = {} } = {}, now = Date.now()) {
    now = this._touch(now);
    const reject = (code, reason) => ({ ok: false, code, reason, snapshot: this.snapshot(now) });
    if (typeof id !== 'string' || !id) return reject('invalid_request', '请求必须有唯一的非空 id。');
    if (this.reservations.has(id) || this.recent.some(value => value.id === id)) return reject('duplicate_request', '该请求 id 已经预留或结算。');
    if (amountUsd === null || amountUsd === undefined) return reject('unknown_pricing', '模型价格未知，无法安全预留额度。');
    let amountMicroUsd;
    try { amountMicroUsd = usdToMicroUsd(amountUsd, { positive: true }); }
    catch (error) { return reject('invalid_amount', error.message); }
    const reserved = this._reservedMicroUsd();
    if (!Number.isSafeInteger(reserved + amountMicroUsd)) return reject('invalid_amount', '预留金额超过安全记账范围。');
    for (const name of WINDOW_NAMES) {
      const used = this.windows[name].usedMicroUsd;
      if (!Number.isSafeInteger(used + reserved + amountMicroUsd)) return reject('invalid_amount', '窗口金额超过安全记账范围。');
      if (this._enabled(name) && used + reserved + amountMicroUsd > this._limitMicroUsd(name)) {
        return reject(`${name}_limit`, `${periodLabel(name)}剩余额度不足以预留本次请求。`);
      }
    }
    this._startWindows(now);
    const reservation = { id, amountMicroUsd, createdAt: now, status: 'pending', metadata: metadataOnly(metadata) };
    this.reservations.set(id, reservation);
    return { ok: true, reservation: this._reservationView(reservation), snapshot: this.snapshot(now) };
  }

  /**
   * Settle the actual charge in the windows active at completion time. A charge
   * can exceed its estimate: preserve that bill, expose the overrun, and block
   * subsequent admissions. Estimates may undershoot; never truncate a real bill.
   */
  commit(id, { costUsd, ...metadata } = {}, now = Date.now()) {
    // Validate the charge before any mutation, retaining its hold on bad data.
    const costMicroUsd = usdToMicroUsd(costUsd);
    now = this._touch(now);
    const reservation = this.reservations.get(id);
    if (!reservation) {
      const prior = this.recent.find(value => value.id === id && value.status !== 'cancelled');
      if (prior) {
        if (prior.costMicroUsd !== costMicroUsd) throw new Error(`Request ${id} was already settled with a different charge.`);
        return { ok: true, alreadySettled: true, record: this._recordView(prior), snapshot: this.snapshot(now) };
      }
      throw new Error(`No pending reservation for request ${id}.`);
    }
    const remainingReserved = this._reservedMicroUsd() - reservation.amountMicroUsd;
    for (const name of WINDOW_NAMES) if (!Number.isSafeInteger(this.windows[name].usedMicroUsd + costMicroUsd + remainingReserved)) throw new RangeError('Window accounting range exceeded.');
    const key = dayKey(now);
    if (!Number.isSafeInteger((this.daily.get(key) || 0) + costMicroUsd)) throw new RangeError('Daily accounting range exceeded.');
    this._startWindows(now);
    this.reservations.delete(id);
    for (const name of WINDOW_NAMES) this.windows[name].usedMicroUsd += costMicroUsd;
    const details = { ...reservation.metadata, ...metadataOnly(metadata) };
    const record = { ...details, id, at: now, status: details.status || 'completed', costMicroUsd };
    this._record(record);
    return { ok: true, record: this._recordView(record), overReservationUsd: microUsdToUsd(Math.max(0, costMicroUsd - reservation.amountMicroUsd)), snapshot: this.snapshot(now) };
  }

  /**
   * Only a known unbilled request may release a hold. A timeout or broken stream
   * may already be paid, so ordinary cancel() keeps an 'uncertain' reservation.
   * If its actual charge is known, settle with commit(...,{status:'failed'}).
   */
  cancel(id, now = Date.now(), { definitelyUnbilled = false } = {}) {
    now = this._touch(now);
    const reservation = this.reservations.get(id);
    if (!reservation) return { ok: false, code: 'unknown_reservation', reason: '找不到待处理的预留。', snapshot: this.snapshot(now) };
    if (!definitelyUnbilled) {
      reservation.status = 'uncertain';
      return { ok: true, released: false, reservation: this._reservationView(reservation), snapshot: this.snapshot(now) };
    }
    this.reservations.delete(id);
    const record = { ...reservation.metadata, id, at: now, status: 'cancelled', costMicroUsd: 0 };
    this._record(record);
    return { ok: true, released: true, record: this._recordView(record), snapshot: this.snapshot(now) };
  }

  configure(config, now = Date.now()) {
    const next = validatedConfig({ ...this.config, ...config });
    now = this._touch(now);
    // Lowering a limit never rewrites the ledger or removes in-flight holds.
    this.config = next;
    return this.snapshot(now);
  }

  _recordView(record) {
    const { costMicroUsd, ...rest } = record;
    return { ...cloneJSON(rest), costUsd: microUsdToUsd(costMicroUsd) };
  }

  _reservationView(reservation) {
    return { ...cloneJSON(reservation.metadata), id: reservation.id, at: reservation.createdAt, status: reservation.status, costUsd: 0, reservedUsd: microUsdToUsd(reservation.amountMicroUsd) };
  }

  snapshot(now = Date.now()) {
    now = this._touch(now);
    const reserved = this._reservedMicroUsd();
    const windows = {};
    let blockedReason = null;
    let blockCode = null;
    for (const name of WINDOW_NAMES) {
      const value = this.windows[name];
      const limit = this._limitMicroUsd(name);
      const occupied = value.usedMicroUsd + reserved;
      const enabled = this._enabled(name);
      windows[name] = {
        enabled,
        limitUsd: microUsdToUsd(limit),
        usedUsd: microUsdToUsd(value.usedMicroUsd),
        reservedUsd: microUsdToUsd(reserved),
        remainingUsd: microUsdToUsd(Math.max(0, limit - occupied)),
        percent: limit === 0 ? (occupied === 0 ? 0 : 100) : Math.round((occupied / limit) * 10000) / 100,
        startsAt: value.startsAt,
        resetsAt: value.startsAt === null ? null : value.startsAt + DURATIONS[name],
      };
      if (!blockedReason && enabled && occupied >= limit) {
        blockCode = `${name}_limit`;
        blockedReason = `${periodLabel(name)}额度已用完。`;
      }
    }
    const recent = [...this.recent.map(value => this._recordView(value)), ...Array.from(this.reservations.values(), value => this._reservationView(value))]
      .sort((a, b) => b.at - a.at).slice(0, RECENT_LIMIT);
    const daily = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = dayKey(Math.max(0, now - offset * DAY_MS));
      if (!daily.some(value => value.date === date)) daily.push({ date, costUsd: microUsdToUsd(this.daily.get(date) || 0) });
    }
    const dimensions = {};
    for (const [key, property] of Object.entries({ limits: 'limitUsd', used: 'usedUsd', reserved: 'reservedUsd', remaining: 'remainingUsd', percent: 'percent', resetsAt: 'resetsAt' })) {
      dimensions[key] = Object.fromEntries(WINDOW_NAMES.map(name => [name, windows[name][property]]));
    }
    return { windows, ...dimensions, blockedReason, blockCode, config: cloneJSON(this.config), recent, daily, dailyTimeZone: 'Asia/Shanghai', pendingCount: this.reservations.size, at: now };
  }

  exportState() {
    return cloneJSON({
      version: 1,
      config: this.config,
      windows: this.windows,
      reservations: Array.from(this.reservations.values()),
      recent: this.recent,
      daily: Array.from(this.daily, ([date, costMicroUsd]) => ({ date, costMicroUsd })),
      lastNow: this.lastNow,
    });
  }
}
