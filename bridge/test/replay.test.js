// Integration + contract smoke: drive the demo replay through one full loop with a
// mock hub, and assert the pipeline emits every WS message type the overlays consume,
// fires each geofence once, completes all six legs, and fires the scripted low-battery dip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { loadRoute } from '../src/legs.js';
import { createState } from '../src/state.js';
import { createStore } from '../src/persistence.js';
import { createPipeline } from '../src/pipeline.js';
import { createReplaySource } from '../src/sources/replay-source.js';
import { buildRoadPath, loadGeometry } from '../src/road-path.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function runOneLoop() {
  const cfg = loadConfig();
  cfg.demo.timeCompression = 600; // fewer ticks; landmark snapping keeps geofences exact
  cfg.demo.loop = true;
  cfg.transmissions = { ...cfg.transmissions, source: 'geofence' }; // this test exercises the geofence path
  const route = loadRoute({ legsPath: cfg.paths.legs, landmarksPath: cfg.paths.landmarks });
  // mirror the index.js boot wiring: road geometry drives the replay AND road-accurate map/logbook
  const roadPath = buildRoadPath(route.route, loadGeometry(cfg.paths.routeGeometry));
  route.attachRoadPath(roadPath);

  const fp = path.join(os.tmpdir(), `r66-replay-${process.pid}.json`);
  fs.rmSync(fp, { force: true });
  const store = createStore(fp, route.totalLegs);
  const state = createState('demo', route.totalLegs);

  const events = [];
  const hub = { broadcast: (type, data) => events.push({ type, data: JSON.parse(JSON.stringify(data)) }) };

  const pipeline = createPipeline({ cfg, route, store, state, hub });
  const source = createReplaySource({ route, store, config: cfg, roadPath });
  source.on('telemetry', pipeline.processTick);
  let looped = false;
  source.on('loop', () => { looped = true; });

  for (let n = 0; n < 50000 && !looped; n++) source.tickOnce();
  fs.rmSync(fp, { force: true });
  return { events, looped, route, state, store };
}

test('demo replay completes a full loop and emits the whole contract', () => {
  const { events, looped, route } = runOneLoop();
  assert.ok(looped, 'replay completed a loop');

  const types = new Set(events.map((e) => e.type));
  for (const t of ['telemetry', 'map', 'logbook', 'transmission',
                   'event:landmarkEntered', 'event:legComplete', 'event:lowBattery']) {
    assert.ok(types.has(t), `contract: expected a "${t}" message`);
  }

  // every landmark fires a transmission exactly once
  const txIds = events.filter((e) => e.type === 'transmission').map((e) => e.data.id);
  assert.equal(new Set(txIds).size, txIds.length, 'no duplicate transmissions');
  assert.equal(txIds.length, route.route.length, 'one transmission per landmark');

  // telemetry contract: SC margin while driving, charge fields while docked
  const teles = events.filter((e) => e.type === 'telemetry').map((e) => e.data);
  const withMargin = teles.find((t) => t.state === 'driving' && t.nextSc && t.marginMi != null);
  assert.ok(withMargin, 'driving frames carry nextSc + marginMi');
  assert.ok(withMargin.nextSc.mi >= 0 && typeof withMargin.nextSc.place === 'string');
  const docked = teles.find((t) => t.state === 'charging');
  assert.ok(docked, 'charging frames emitted');
  assert.equal(docked.chargeLimitPct, 90);
  assert.ok(docked.timeToFullMin != null && docked.timeToFullMin >= 0);
});

test('all six legs complete, once each', () => {
  const { events, route } = runOneLoop();
  const legs = events.filter((e) => e.type === 'event:legComplete').map((e) => e.data.leg);
  assert.deepEqual([...legs].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.equal(legs.length, 6, 'each leg completes exactly once');
  // leg 3 is the standby leg
  const leg3 = events.find((e) => e.type === 'event:legComplete' && e.data.leg === 3);
  assert.equal(leg3.data.isStandby, true);
});

test('scripted low-battery dip fires exactly once and the warn state is exercised', () => {
  const { events } = runOneLoop();
  const lows = events.filter((e) => e.type === 'event:lowBattery');
  assert.equal(lows.length, 1, 'one low-battery edge per trip');
  assert.ok(lows[0].data.usableBatteryPct <= 15);

  const warnTelems = events.filter((e) => e.type === 'telemetry' && e.data.warn);
  assert.ok(warnTelems.length > 0, 'telemetry warn state was emitted');
  assert.equal(warnTelems[0].data.statusText, 'CHARGE CRITICAL');
});

test('logbook counters climb over the trip', () => {
  const { events } = runOneLoop();
  const books = events.filter((e) => e.type === 'logbook').map((e) => e.data);
  const final = books[books.length - 1];
  assert.ok(final.miles > 1000, `miles logged climbed (got ${final.miles})`);
  assert.equal(final.legsDone, 6);
  assert.ok(final.superchargers >= 15);
  assert.ok(final.states >= 5);
  assert.ok(final.stationsBypassed > 0);
  assert.ok(final.elevationFt > 0);
  // THE TRIP page
  assert.equal(final.waypoints, 58, 'every waypoint logged by loop end');
  assert.equal(final.totalWaypoints, 58);
  assert.ok(final.routePct >= 95, `route % completes (got ${final.routePct})`);
  assert.ok(final.days >= 1);
  // POWERTRAIN page — sim-time + session-energy accounting
  assert.ok(final.kwhCharged > 100, `charge sessions committed (got ${final.kwhCharged} kWh)`);
  assert.ok(final.driveHrs > 30, `drive hours accrue in sim time (got ${final.driveHrs})`);
  assert.ok(final.chargeHrs > 2, `charge hours accrue (got ${final.chargeHrs})`);
  assert.ok(final.gasSaved > 100, `gas savings derived (got $${final.gasSaved})`);
});

test('map vehicle stays on the drawn flight plan (svg within canvas)', () => {
  const { events } = runOneLoop();
  const maps = events.filter((e) => e.type === 'map').map((e) => e.data);
  for (const m of maps) {
    assert.ok(m.vehicle.svgX >= 0 && m.vehicle.svgX <= 1000);
    assert.ok(m.vehicle.svgY >= 0 && m.vehicle.svgY <= 560);
    assert.equal(m.legStatus.length, 6);
  }
});
