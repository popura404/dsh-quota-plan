import assert from 'node:assert/strict';
import fs, { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { QuotaStore } from '../../lib/store.js';

const [mode, file, argument] = process.argv.slice(2);

async function retryBusy(operation) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { return operation(); }
    catch (error) {
      if (error.code !== 'PLAN_LOCK_BUSY' || Date.now() >= deadline) throw error;
      await delay(20);
    }
  }
}

function report(message) {
  return new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
}

try {
  if (mode === 'exit') {
    await report({ type: 'ready', pid: process.pid });
  } else if (mode === 'hold' || mode === 'crash') {
    const store = new QuotaStore(file);
    if (mode === 'crash') {
      assert.equal(store.reserve({ id: 'orphaned-request', amountUsd: 0.03,
        metadata: { ownerPid: process.pid } }).ok, true);
    }
    store.transaction(() => {
      process.send({ type: 'holding', pid: process.pid });
      const deadline = Date.now() + 20_000;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(argument)) {
        if (Date.now() >= deadline) throw new Error('Parent did not release the held transaction in time.');
        Atomics.wait(sleeper, 0, 0, 10);
      }
    });
    await report({ type: 'released' });
  } else if (mode === 'cleanup-failure') {
    const store = new QuotaStore(file);
    const originalUnlink = fs.unlinkSync;
    let failures = 0;
    fs.unlinkSync = path => {
      if (path === `${file}.lock`) {
        // Restore the real filesystem function before raising the one-shot
        // error, so the next operation can actually retry the retired lock.
        fs.unlinkSync = originalUnlink;
        syncBuiltinESMExports();
        failures++;
        throw Object.assign(new Error('Injected one-shot lock cleanup failure.'), { code: 'EACCES' });
      }
      return originalUnlink(path);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => store.status(), { code: 'EACCES' });
      assert.equal(failures, 1);
      assert.equal(existsSync(`${file}.lock`), true);
      const recovered = store.status();
      assert.equal(existsSync(`${file}.lock`), false);
      await report({ type: 'result', recovered });
    } finally {
      fs.unlinkSync = originalUnlink;
      syncBuiltinESMExports();
    }
  } else if (mode === 'contend') {
    const store = await retryBusy(() => new QuotaStore(file));
    const start = new Promise(resolve => process.once('message', resolve));
    await report({ type: 'ready', pid: process.pid });
    assert.equal((await start).type, 'start');
    const accepted = [];
    const rejected = [];
    for (let i = 0; i < 10; i++) {
      const id = `${argument}-${i}`;
      const result = await retryBusy(() => store.reserve({ id, amountUsd: 0.01,
        metadata: { ownerPid: process.pid } }));
      if (!result.ok) {
        assert.equal(result.code, 'fiveHour_limit');
        rejected.push(id);
        continue;
      }
      // Separate admission and settlement transactions exercise pending holds
      // while the other processes are competing for the same remaining funds.
      await delay(1);
      await retryBusy(() => store.commit(id, { costUsd: 0.01 }));
      accepted.push(id);
    }
    await report({ type: 'result', accepted, rejected });
  } else {
    throw new Error(`Unknown store lock worker mode: ${mode}`);
  }
  process.disconnect();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
