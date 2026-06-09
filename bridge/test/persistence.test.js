import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, defaultStore } from '../src/persistence.js';

function tmpFile(name) {
  return path.join(os.tmpdir(), `r66-${name}-${process.pid}.json`);
}

test('defaults when file missing', () => {
  const fp = tmpFile('missing');
  try { fs.rmSync(fp, { force: true }); } catch {}
  const store = createStore(fp);
  assert.equal(store.wasCreated(), true);
  assert.deepEqual(store.get().visited, []);
  assert.equal(store.get().lowBatteryArmed, true);
});

test('flush round-trips and leaves no .tmp file', () => {
  const fp = tmpFile('roundtrip');
  try { fs.rmSync(fp, { force: true }); } catch {}
  const store = createStore(fp);
  store.get().visited.push('cadillac_ranch');
  store.set({ legsDone: 2, superchargers: 7 });
  store.flush();

  assert.ok(fs.existsSync(fp));
  assert.ok(!fs.existsSync(`${fp}.tmp`), 'no partial temp file left behind');

  const reload = createStore(fp);
  assert.equal(reload.wasCreated(), false);
  assert.deepEqual(reload.get().visited, ['cadillac_ranch']);
  assert.equal(reload.get().legsDone, 2);
  assert.equal(reload.get().superchargers, 7);

  fs.rmSync(fp, { force: true });
});

test('reload merges forward-compatible defaults onto old files', () => {
  const fp = tmpFile('merge');
  fs.writeFileSync(fp, JSON.stringify({ visited: ['joplin'] }));
  const store = createStore(fp);
  // missing keys filled from defaults
  assert.equal(store.get().lowBatteryArmed, true);
  assert.deepEqual(store.get().visited, ['joplin']);
  fs.rmSync(fp, { force: true });
});

test('defaultStore shape', () => {
  const d = defaultStore(6);
  assert.equal(d.totalLegs, 6);
  assert.equal(d.odometerBaselineKm, null);
  assert.equal(d.elevationAccumFt, 0);
});
