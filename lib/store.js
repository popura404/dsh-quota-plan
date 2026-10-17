import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, renameSync, fsyncSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BudgetEngine } from './budget.js';
import { DEFAULT_CONFIG, validateConfig } from './pricing.js';
import { acquireLock, releaseLock } from './store-lock.js';

// A short synchronous lock covers read-modify-write, so multiple DSH processes
// using the same file never sell the same remaining dollars. Each reservation
// is persisted before its provider stream is entered.
export class QuotaStore {
  constructor(file, { deferOnLockBusy = false } = {}) {
    this.file = resolve(file);
    mkdirSync(dirname(this.file), { recursive: true });
    try { this.transaction(() => {}); }
    catch (error) {
      // The host may finish loading during temporary contention. Every read
      // and admission still retries the lock and validates the durable ledger.
      if (!deferOnLockBusy || error.code !== 'PLAN_LOCK_BUSY') throw error;
    }
  }

  transaction(operation) {
    const lock = acquireLock(this.file + '.lock');
    let temp;
    try {
      let saved;
      try { saved = JSON.parse(readFileSync(this.file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Only an absent file starts a new ledger. Existing but incomplete data
      // must be rejected before any mutation, preserving its original bytes.
      if (saved !== undefined) {
        const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
        if (!object(saved) || !object(saved.config) || !object(saved.engine)) {
          throw new Error('额度账本结构无效，已停止请求并保留原文件。');
        }
        if (saved.version !== 1) throw new Error('额度账本版本不支持，已停止请求以保护额度。');
      }
      const config = validateConfig(saved === undefined ? {} : saved.config, DEFAULT_CONFIG);
      // Normalize both persisted configuration copies so retired settings
      // cannot survive through the engine's configuration merge on reload.
      const engine = new BudgetEngine(saved === undefined ? { config }
        : { state: { ...saved.engine, config: validateConfig(saved.engine.config, DEFAULT_CONFIG) }, config });
      // A crashed process cannot finish its stream. Preserve its possible bill
      // by charging its reservation, then let normal windows recover.
      // Unknown owners and live processes keep their in-flight reservation.
      for (const pending of engine.exportState().reservations) {
        const owner = pending.metadata?.ownerPid;
        if (!Number.isSafeInteger(owner) || owner <= 0) continue;
        let alive = true;
        try { process.kill(owner, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (!alive) {
          engine.commit(pending.id, { costUsd: pending.amountMicroUsd / 1000000,
            status: 'estimated', error: '原请求进程已退出，按本次预留保守结算' });
        }
      }
      const result = operation(engine, config);
      temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      const newFd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(newFd, JSON.stringify({ version: 1, config, engine: engine.exportState() }, null, 2));
        fsyncSync(newFd);
      } finally { closeSync(newFd); }
      renameSync(temp, this.file);
      temp = null;
      return result;
    } finally {
      try { if (temp && existsSync(temp)) unlinkSync(temp); }
      finally { releaseLock(lock); }
    }
  }

  status(now = Date.now()) {
    return this.transaction((engine, config) => ({ ...engine.snapshot(now), config: { ...config } }));
  }
  configure(input, now = Date.now()) {
    return this.transaction((engine, config) => {
      const next = validateConfig(input, config);
      engine.configure(next, now);
      Object.assign(config, next);
      return { ...engine.snapshot(now), config: { ...config } };
    });
  }
  reserve(request, now = Date.now()) { return this.transaction(engine => engine.reserve(request, now)); }
  commit(id, usage, now = Date.now()) { return this.transaction(engine => engine.commit(id, usage, now)); }
  cancel(id, now = Date.now(), options) { return this.transaction(engine => engine.cancel(id, now, options)); }
}
