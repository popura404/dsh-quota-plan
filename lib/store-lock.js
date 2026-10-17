import { closeSync, fstatSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const LEGACY_LOCK_GRACE_MS = 30_000;
const LOCK_WAIT_MS = 1000;
const MAX_LOCK_BYTES = 4096;
// Only locks whose protected operation has ended enter this set. A transient
// cleanup failure must not strand a lock owned by this still-running process.
const pendingReleases = new Map();

function readLock(file) {
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd);
    const raw = stat.size <= MAX_LOCK_BYTES ? readFileSync(fd, 'utf8') : null;
    let owner;
    try { owner = JSON.parse(raw); } catch { /* An old writer may have left an incomplete lock. */ }
    let dead = false;
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') dead = true; }
    } else {
      // Only legacy locks lack a PID. Give an interrupted writer time to
      // finish; valid live owners are never displaced because of their age.
      dead = Date.now() - stat.mtimeMs > LEGACY_LOCK_GRACE_MS;
    }
    return { raw, dead, identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` };
  } finally { closeSync(fd); }
}

export function releaseLock(lock) {
  if (!lock) return;
  pendingReleases.set(lock.file, lock);
  try {
    // A unique token prevents cleanup from deleting another owner's lock.
    if (readLock(lock.file).raw === lock.data) unlinkSync(lock.file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  pendingReleases.delete(lock.file);
}

function publishLock(file) {
  const token = randomUUID();
  const data = JSON.stringify({ pid: process.pid, token });
  const candidate = `${file}.${process.pid}.${token}.tmp`;
  const fd = openSync(candidate, 'wx', 0o600);
  let lock;
  try {
    try { writeFileSync(fd, data); }
    finally { closeSync(fd); }
    // Publish complete ownership metadata atomically, without replacing an
    // existing lock. A crash before publication leaves only an unused temp
    // file; a crash afterwards leaves a lock whose dead PID can be checked.
    linkSync(candidate, file);
    lock = { file, data };
    return lock;
  } finally {
    try { unlinkSync(candidate); }
    catch (error) {
      // If cleanup fails after acquisition, do not leave an unreturned lock
      // owned by this still-running process.
      releaseLock(lock);
      throw error;
    }
  }
}

function acquireRecovery(lockFile) {
  let file = `${lockFile}.recovery`;
  for (let generation = 0; generation < 32; generation++) {
    try { return publishLock(file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let record;
    try { record = readLock(file); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!record.dead) return null;
    // Keep dead recovery records immutable. Every contender chooses the
    // same successor slot instead of racing to remove a replacement lock.
    const key = createHash('sha256').update(`${file}\0${record.identity}\0${record.raw}`).digest('hex').slice(0, 32);
    file = `${lockFile}.recovery.${key}`;
  }
  return null;
}

export function acquireLock(file) {
  for (const pending of pendingReleases.values()) {
    if (pending.file === file || pending.file === `${file}.recovery`
      || pending.file.startsWith(`${file}.recovery.`)) releaseLock(pending);
  }
  const deadline = performance.now() + LOCK_WAIT_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  do {
    try { return publishLock(file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let recovery;
    let acquired;
    try {
      recovery = acquireRecovery(file);
      if (recovery && readLock(file).dead) {
        unlinkSync(file);
        acquired = publishLock(file);
      }
    } catch (error) {
      // An owner may have just released the lock, or another process may
      // have won admission after recovery removed the dead owner's file.
      if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error;
    } finally {
      try { releaseLock(recovery); }
      catch (error) { releaseLock(acquired); throw error; }
    }
    if (acquired) return acquired;
    // All transactions are synchronous; contention is with another process.
    Atomics.wait(sleeper, 0, 0, Math.max(0, Math.min(10, deadline - performance.now())));
  } while (performance.now() < deadline);
  const error = new Error('额度账本锁暂时无法获取，请稍后重试；无持有者信息的旧锁将在 30 秒宽限期后恢复。');
  error.code = 'PLAN_LOCK_BUSY';
  throw error;
}
