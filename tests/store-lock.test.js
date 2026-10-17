import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { QuotaStore } from '../lib/store.js';

const workerFile = fileURLToPath(new URL('./fixtures/store-lock-worker.mjs', import.meta.url));
const CHILD_TIMEOUT = 30_000;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-store-lock-'));
  const file = join(directory, 'ledger.json');
  const children = [];
  t.after(async () => {
    for (const child of children) if (!child.exited) child.process.kill('SIGKILL');
    await Promise.all(children.map(child => child.completion));
    rmSync(directory, { recursive: true, force: true });
  });

  const store = new QuotaStore(file);
  store.configure({ fiveHourLimitUsd: 0.47, weeklyLimitUsd: 1 });
  assert.equal(store.reserve({ id: 'prior-charge', amountUsd: 0.1 }).ok, true);
  store.commit('prior-charge', { costUsd: 0.07 });

  function launch(mode, argument = '') {
    const process = fork(workerFile, [mode, file, argument], {
      execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const messages = [];
    const listeners = new Set();
    let output = '';
    const child = { process, exited: false };
    children.push(child);
    for (const stream of [process.stdout, process.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => { output = (output + chunk).slice(-16_000); });
    }
    process.on('message', message => {
      messages.push(message);
      for (const notify of [...listeners]) notify();
    });
    process.on('error', error => {
      child.error = error;
      for (const notify of [...listeners]) notify();
    });
    child.completion = new Promise(resolve => process.once('close', (code, signal) => {
      child.exited = true;
      child.result = { code, signal, output };
      for (const notify of [...listeners]) notify();
      resolve(child.result);
    }));
    child.message = type => new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${mode}/${type}. ${output}`)), CHILD_TIMEOUT);
      function finish(error, message) {
        clearTimeout(timer);
        listeners.delete(check);
        if (error) reject(error); else resolve(message);
      }
      function check() {
        const index = messages.findIndex(message => message?.type === type);
        if (index >= 0) finish(null, messages.splice(index, 1)[0]);
        else if (child.error) finish(child.error);
        else if (child.exited) finish(new Error(`Worker exited before ${type}: ${JSON.stringify(child.result)}`));
      }
      listeners.add(check);
      check();
    });
    child.succeeded = async () => {
      const result = await child.completion;
      assert.equal(result.code, 0, result.output);
      assert.equal(result.signal, null, result.output);
    };
    return child;
  }
  return { directory, file, store, launch };
}

function age(file) {
  const past = new Date(Date.now() - 60_000);
  utimesSync(file, past, past);
}

function assertDead(pid) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

function assertPriorCharge(status, expected = 0.07) {
  assert.equal(status.used.fiveHour, expected);
  assert.equal(status.used.weekly, expected);
  assert.equal(status.pendingCount, 0);
  const prior = status.recent.find(record => record.id === 'prior-charge');
  assert.equal(prior?.costUsd, 0.07);
}

test('an aged empty legacy lock is recovered without resetting prior charges', { timeout: CHILD_TIMEOUT }, t => {
  const { file } = fixture(t);
  writeFileSync(`${file}.lock`, '');
  age(`${file}.lock`);

  assertPriorCharge(new QuotaStore(file).status());
  assert.equal(existsSync(`${file}.lock`), false);
});

test('a recent ownerless lock blocks writes until its recovery grace period has elapsed', { timeout: CHILD_TIMEOUT }, t => {
  const { file } = fixture(t);
  const before = readFileSync(file, 'utf8');
  writeFileSync(`${file}.lock`, '');

  // The plugin keeps this same store instance after a temporarily busy start.
  const restored = new QuotaStore(file, { deferOnLockBusy: true });
  assert.throws(() => restored.status(), { code: 'PLAN_LOCK_BUSY' });
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(readFileSync(`${file}.lock`, 'utf8'), '');

  age(`${file}.lock`);
  assertPriorCharge(restored.status());
});

test('a dead owner lock and an aged empty recovery lock can both be recovered', { timeout: CHILD_TIMEOUT }, async t => {
  const { file, launch } = fixture(t);
  const child = launch('exit');
  const { pid } = await child.message('ready');
  await child.succeeded();
  assertDead(pid);
  writeFileSync(`${file}.lock`, JSON.stringify({ pid }));
  writeFileSync(`${file}.lock.recovery`, '');
  age(`${file}.lock.recovery`);

  assertPriorCharge(new QuotaStore(file).status());
  assert.equal(existsSync(`${file}.lock`), false);
});

test('a live transaction owner is never displaced even when its lock looks old', { timeout: CHILD_TIMEOUT }, async t => {
  const { file, directory, launch } = fixture(t);
  const release = join(directory, 'release-live-owner');
  const child = launch('hold', release);
  const { pid } = await child.message('holding');
  assert.doesNotThrow(() => process.kill(pid, 0));
  const before = readFileSync(file, 'utf8');
  const locked = readFileSync(`${file}.lock`, 'utf8');
  age(`${file}.lock`);

  const competing = new QuotaStore(file, { deferOnLockBusy: true });
  assert.throws(() => competing.status(), { code: 'PLAN_LOCK_BUSY' });
  assert.throws(() => competing.reserve({ id: 'must-not-enter', amountUsd: 0.01 }), { code: 'PLAN_LOCK_BUSY' });
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(readFileSync(`${file}.lock`, 'utf8'), locked);

  writeFileSync(release, 'release');
  await child.message('released');
  await child.succeeded();
  assertPriorCharge(competing.status());
});

test('concurrent processes preserve every charge and cannot oversell the same funds', { timeout: CHILD_TIMEOUT }, async t => {
  const { file, launch } = fixture(t);
  const children = Array.from({ length: 6 }, (_, index) => launch('contend', `worker-${index}`));
  await Promise.all(children.map(child => child.message('ready')));
  // All constructors have finished. Make their first admissions compete to
  // recover the same abandoned main lock and abandoned recovery slot.
  writeFileSync(`${file}.lock`, '');
  age(`${file}.lock`);
  writeFileSync(`${file}.lock.recovery`, '');
  age(`${file}.lock.recovery`);
  for (const child of children) child.process.send({ type: 'start' });
  const results = await Promise.all(children.map(child => child.message('result')));
  await Promise.all(children.map(child => child.succeeded()));
  const accepted = results.flatMap(result => result.accepted);
  const rejected = results.flatMap(result => result.rejected);
  assert.equal(accepted.length, 40);
  assert.equal(new Set(accepted).size, 40);
  assert.equal(rejected.length, 20);

  const status = new QuotaStore(file).status();
  assertPriorCharge(status, 0.47);
  assert.equal(status.remaining.fiveHour, 0);
  assert.deepEqual(new Set(status.recent.map(record => record.id)), new Set(['prior-charge', ...accepted]));
  assert.equal(status.recent.filter(record => record.id !== 'prior-charge').every(record => record.costUsd === 0.01), true);
});

test('the same store retries a one-shot cleanup failure without losing prior charges', { timeout: CHILD_TIMEOUT }, async t => {
  const { file, launch } = fixture(t);
  const child = launch('cleanup-failure');
  const { recovered } = await child.message('result');
  await child.succeeded();
  assertPriorCharge(recovered);
  assertPriorCharge(new QuotaStore(file).status());
});

test('a process killed during a transaction leaves a recoverable lock and its pending bill is charged once', { timeout: CHILD_TIMEOUT }, async t => {
  const { file, directory, launch } = fixture(t);
  const child = launch('crash', join(directory, 'never-release-crashed-owner'));
  const { pid } = await child.message('holding');
  assert.equal(existsSync(`${file}.lock`), true);
  assert.equal(child.process.kill('SIGKILL'), true);
  await child.completion;
  assertDead(pid);
  assert.equal(existsSync(`${file}.lock`), true);

  for (let attempt = 0; attempt < 2; attempt++) {
    const status = new QuotaStore(file).status();
    assertPriorCharge(status, 0.1);
    const orphaned = status.recent.filter(record => record.id === 'orphaned-request');
    assert.equal(orphaned.length, 1);
    assert.equal(orphaned[0].costUsd, 0.03);
    assert.equal(orphaned[0].status, 'estimated');
    assert.equal(existsSync(`${file}.lock`), false);
  }
});
