import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../lib/pricing.js';
import { QuotaStore } from '../lib/store.js';

function ledgerFile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-store-integrity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'ledger.json');
}

function chargedLedger(file) {
  const store = new QuotaStore(file);
  store.configure({ fiveHourLimitUsd: 2, weeklyLimitUsd: 9, inputTokenMultiplier: 2 });
  assert.equal(store.reserve({ id: 'settled-request', amountUsd: 0.5 }).ok, true);
  store.commit('settled-request', { costUsd: 0.3 });
  assert.equal(store.reserve({ id: 'pending-request', amountUsd: 0.2 }).ok, true);
  return { store, saved: JSON.parse(readFileSync(file, 'utf8')) };
}

const corruptions = [
  ['null root', () => 'null'],
  ['false root', () => 'false'],
  ['zero root', () => '0'],
  ['empty string root', () => '""'],
  ['array root', () => '[]'],
  ['true root', () => 'true'],
  ['nonzero number root', () => '42'],
  ['nonempty string root', () => '"not a ledger"'],
  ['missing config', saved => { delete saved.config; return JSON.stringify(saved); }],
  ['missing engine', saved => { delete saved.engine; return JSON.stringify(saved); }],
  ['null engine', saved => JSON.stringify({ ...saved, engine: null })],
  ['unsupported version', saved => JSON.stringify({ ...saved, version: 2 })],
  ['malformed JSON', () => '{ "version": 1,'],
  ['empty file', () => ''],
];

test('existing invalid ledgers are rejected without replacing their bytes', async t => {
  for (const [name, corrupt] of corruptions) {
    await t.test(name, t => {
      const file = ledgerFile(t);
      const { saved } = chargedLedger(file);
      const original = Buffer.from(corrupt(saved));
      writeFileSync(file, original);

      assert.throws(() => new QuotaStore(file));
      assert.throws(() => new QuotaStore(file, { deferOnLockBusy: true }));
      assert.deepEqual(readFileSync(file), original);
      assert.equal(existsSync(file + '.lock'), false);
    });
  }
});

test('a missing ledger is initialized and can retain settled and pending usage', t => {
  const file = ledgerFile(t);
  assert.equal(existsSync(file), false);
  const { store } = chargedLedger(file);
  const snapshot = store.status();

  assert.equal(snapshot.used.fiveHour, 0.3);
  assert.equal(snapshot.used.weekly, 0.3);
  assert.equal(snapshot.windows.fiveHour.reservedUsd, 0.2);
  assert.equal(snapshot.windows.weekly.reservedUsd, 0.2);
  assert.equal(snapshot.pendingCount, 1);
  const restored = new QuotaStore(file).status();
  assert.deepEqual(restored.used, snapshot.used);
  assert.equal(restored.pendingCount, 1);
  assert.equal(restored.windows.fiveHour.reservedUsd, 0.2);
});

test('older configuration fields are defaulted without resetting usage or reservations', t => {
  const file = ledgerFile(t);
  const { saved } = chargedLedger(file);
  for (const config of [saved.config, saved.engine.config]) {
    for (const key of ['reservationMode', 'autoPricingEnabled', 'pricingRefreshHours',
      'pricingMaxAgeHours', 'pricingCnyPerUsd', 'pricingRoutes', 'pricingModelAliases']) {
      delete config[key];
    }
  }
  writeFileSync(file, JSON.stringify(saved));

  const snapshot = new QuotaStore(file).status();
  assert.equal(snapshot.config.reservationMode, DEFAULT_CONFIG.reservationMode);
  assert.equal(snapshot.config.pricingRefreshHours, DEFAULT_CONFIG.pricingRefreshHours);
  assert.deepEqual(snapshot.config.pricingRoutes, DEFAULT_CONFIG.pricingRoutes);
  assert.equal(snapshot.config.inputTokenMultiplier, 2);
  assert.equal(snapshot.config.fiveHourLimitUsd, 2);
  assert.equal(snapshot.config.weeklyLimitUsd, 9);
  assert.equal(snapshot.used.fiveHour, 0.3);
  assert.equal(snapshot.used.weekly, 0.3);
  assert.equal(snapshot.windows.fiveHour.reservedUsd, 0.2);
  assert.equal(snapshot.windows.weekly.reservedUsd, 0.2);
  assert.equal(snapshot.pendingCount, 1);
  assert.equal(snapshot.recent.find(record => record.id === 'settled-request').costUsd, 0.3);

  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(persisted.config.reservationMode, DEFAULT_CONFIG.reservationMode);
  assert.equal(persisted.engine.reservations[0].id, 'pending-request');
});

test('reads and writes reject a ledger damaged after construction without replacing it', async t => {
  const operations = [
    ['status', store => store.status()],
    ['configure', store => store.configure({ enabled: false })],
    ['reserve', store => store.reserve({ id: 'new-request', amountUsd: 0.1 })],
    ['commit', store => store.commit('pending-request', { costUsd: 0.1 })],
    ['cancel', store => store.cancel('pending-request', Date.now(), { definitelyUnbilled: true })],
    ['transaction', store => store.transaction(() => 'unexpected successful transaction')],
  ];
  for (const [name, operation] of operations) {
    for (const [damage, corrupt] of corruptions.filter(([name]) => ['null root', 'missing engine'].includes(name))) {
      await t.test(`${name}: ${damage}`, t => {
        const file = ledgerFile(t);
        const { store, saved } = chargedLedger(file);
        const original = Buffer.from(corrupt(saved));
        writeFileSync(file, original);

        assert.throws(() => operation(store));
        assert.deepEqual(readFileSync(file), original);
        assert.equal(existsSync(file + '.lock'), false);
      });
    }
  }
});
