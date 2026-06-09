import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoute } from '../src/legs.js';
import { createStore } from '../src/persistence.js';
import { createGeofence } from '../src/geofence.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const route = () =>
  loadRoute({
    legsPath: path.join(REPO, 'config/legs.json'),
    landmarksPath: path.join(REPO, 'planning/landmarks.json'),
  });

test('geofence fires once per entry, with hysteresis + persisted visited latch', () => {
  const r = route();
  const fp = path.join(os.tmpdir(), `r66-gf-${process.pid}.json`);
  fs.rmSync(fp, { force: true });
  const store = createStore(fp);
  store.get().visited.push('stay_amarillo'); // leg 1 done -> we're on leg 2
  const gf = createGeofence(r, store);
  const cad = r.landmark('cadillac_ranch'); // leg 2

  // first entry -> fires exactly once
  let fired = gf.check(cad.lat, cad.lng);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].id, 'cadillac_ranch');

  // still inside the radius -> no re-fire (hysteresis)
  assert.equal(gf.check(cad.lat, cad.lng).length, 0);

  // leave the radius
  assert.equal(gf.check(0, 0).length, 0);

  // re-enter the SAME landmark this trip -> visited latch blocks it
  assert.equal(gf.check(cad.lat, cad.lng).length, 0);

  // simulate a restart: persist, reload store + a fresh geofence
  store.flush();
  const store2 = createStore(fp);
  assert.deepEqual(store2.get().visited, ['stay_amarillo', 'cadillac_ranch']);
  const gf2 = createGeofence(r, store2);
  assert.equal(gf2.check(cad.lat, cad.lng).length, 0, 'no re-fire after restart');

  // a different, unvisited landmark on the current leg still fires
  const scAma = r.landmark('sc_amarillo'); // leg 2
  const f2 = gf2.check(scAma.lat, scAma.lng);
  assert.equal(f2.length, 1);
  assert.equal(f2[0].id, 'sc_amarillo');

  fs.rmSync(fp, { force: true });
});

test('HOME fires even though it shares a place_id with START (keyed on id, leg-scoped)', () => {
  const r = route();
  const start = r.landmark('springfield_start');
  const home = r.landmark('springfield_home');
  assert.equal(start.place_id, home.place_id); // same place_id...
  assert.notEqual(start.id, home.id); // ...different id
  assert.equal(start.lat, home.lat); // ...and identical coords

  const fp = path.join(os.tmpdir(), `r66-gf-home-${process.pid}.json`);
  fs.rmSync(fp, { force: true });
  const store = createStore(fp);
  // all five prior leg-ends visited -> we are on leg 6, arriving home
  for (const id of ['stay_amarillo', 'stay_flagstaff', 'stay_maricopa', 'stay_elpaso', 'stay_garland']) {
    store.get().visited.push(id);
  }
  const gf = createGeofence(r, store);

  // at the shared Springfield coords on leg 6, HOME fires; START (leg 1) is not re-fired
  const fired = gf.check(home.lat, home.lng).map((l) => l.id);
  assert.ok(fired.includes('springfield_home'));
  assert.ok(!fired.includes('springfield_start'));

  fs.rmSync(fp, { force: true });
});
