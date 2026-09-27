import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, renameSync, fsyncSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BudgetEngine } from './budget.js';
import { DEFAULT_CONFIG, validateConfig } from './pricing.js';

function acquireLock(lock) {
  const deadline = Date.now() + 1000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let lastError;
  do {
    try { return openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const recovery = lock + '.recovery';
      let recoveryFd;
      try {
        recoveryFd = openSync(recovery, 'wx', 0o600);
        let owner;
        try { owner = JSON.parse(readFileSync(lock, 'utf8')); }
        catch (readError) { if (readError.code !== 'ENOENT') throw new Error('额度账本锁无效或正在写入。'); }
        if (owner) {
          let alive = true;
          if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
          }
          if (alive) throw new Error('额度账本正在被另一进程更新。');
          unlinkSync(lock);
        }
        return openSync(lock, 'wx', 0o600);
      } catch (recoverError) { lastError = recoverError; }
      finally {
        if (recoveryFd !== undefined) { closeSync(recoveryFd); unlinkSync(recovery); }
      }
      // Brief contention involves another process, never another callback on
      // this JS event loop: every transaction is synchronous.
      Atomics.wait(sleeper, 0, 0, 10);
    }
  } while (Date.now() < deadline);
  const error = new Error(`额度账本锁暂时无法获取，请稍后重试：${lastError?.message ?? '锁正在恢复'}`);
  error.code = 'PLAN_LOCK_BUSY';
  throw error;
}

// A short synchronous lock covers read-modify-write, so multiple DSH processes
// using the same file never sell the same remaining dollars. Each reservation
// is persisted before its provider stream is entered.
export class QuotaStore {
  constructor(file) {
    this.file = resolve(file);
    mkdirSync(dirname(this.file), { recursive: true });
    this.transaction(() => {});
  }

  transaction(operation) {
    const lock = this.file + '.lock';
    const fd = acquireLock(lock);
    let temp;
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      let saved;
      if (existsSync(this.file)) saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (saved && saved.version !== 1) throw new Error('额度账本版本不支持，已停止请求以保护额度。');
      const config = validateConfig(saved?.config ?? {}, DEFAULT_CONFIG);
      const engine = new BudgetEngine(saved ? { state: saved.engine, config } : { config });
      // A crashed process cannot finish its stream. Preserve its possible bill
      // by charging the whole reservation, then let normal windows recover.
      // Unknown owners and live processes keep their in-flight reservation.
      for (const pending of engine.exportState().reservations) {
        const owner = pending.metadata?.ownerPid;
        if (!Number.isSafeInteger(owner) || owner <= 0) continue;
        let alive = true;
        try { process.kill(owner, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (!alive) {
          engine.commit(pending.id, { costUsd: pending.amountMicroUsd / 1000000,
            status: 'estimated', error: '原请求进程已退出，按预留上限保守结算' });
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
      if (temp && existsSync(temp)) unlinkSync(temp);
      closeSync(fd);
      unlinkSync(lock);
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
