// ride-privacy.test.js — the acceptance criterion: NO in-zone coordinate ever
// appears in any overlay-facing payload (snapshot, WS events, route segments,
// heat bins, NAV position). The PWA's private views stay unfiltered.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { haversine } from '../src/geo.js';
import { createPrivacyZone } from '../src/ride/privacy.js';
import { createJsonRideStore } from '../src/ride/json-store.js';
import { createRideTracker } from '../src/ride/tracker.js';

const HOME = { lat: 37.1885, lng: -93.311, radiusM: 800 };
const BASE = new Date('2026-07-03T02:00:00Z').getTime();

function cfgWithZone() {
  return {
    ride: {
      timezone: 'America/Chicago',
      statsTickSec: 3600,
      privacy: { ...HOME },
      heat: { binM: 250 },
      path: { minMoveM: 10, maxPoints: 500 },
    },
  };
}

async function makeTracker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-priv-'));
  const store = createJsonRideStore(path.join(dir, 'ride.json'));
  let t = BASE;
  const clock = { advance: (ms) => { t += ms; }, now: () => t };
  const tracker = await createRideTracker({ cfg: cfgWithZone(), store, now: clock.now });
  const events = [];
  tracker.setBroadcast((type, data) => events.push({ type, data }));
  return { tracker, clock, store, events };
}

const distFromHome = (lat, lng) => haversine(lat, lng, HOME.lat, HOME.lng);

// recursively scan a payload for anything that looks like an in-zone coordinate
function assertNoInZoneCoords(obj, where) {
  if (obj == null || typeof obj !== 'object') return;
  if (typeof obj.lat === 'number' && typeof obj.lng === 'number') {
    assert.ok(
      distFromHome(obj.lat, obj.lng) >= HOME.radiusM - 1,
      `${where}: in-zone {lat:${obj.lat}, lng:${obj.lng}} leaked (${Math.round(distFromHome(obj.lat, obj.lng))}m from home)`,
    );
  }
  if (Array.isArray(obj) && obj.length === 2 && typeof obj[0] === 'number' && typeof obj[1] === 'number'
      && Math.abs(obj[1]) <= 90 && Math.abs(obj[0]) <= 180) {
    // [lng, lat] geometry point
    assert.ok(
      distFromHome(obj[1], obj[0]) >= HOME.radiusM - 1,
      `${where}: in-zone geometry point [${obj[0]}, ${obj[1]}] leaked`,
    );
  }
  for (const k of Object.keys(obj)) assertNoInZoneCoords(obj[k], `${where}.${k}`);
}

test('zone primitives: inside / clamp / filterPath', () => {
  const zone = createPrivacyZone(HOME);
  assert.equal(zone.enabled, true);
  assert.equal(zone.inside(HOME.lat, HOME.lng), true);
  assert.equal(zone.inside(37.209, -93.2923), false); // downtown, ~3km away

  const c = zone.clamp(HOME.lat + 0.001, HOME.lng); // ~111m from center
  const d = distFromHome(c.lat, c.lng);
  assert.ok(Math.abs(d - HOME.radiusM) < 2, `clamped to boundary (got ${d}m)`);
  const passthrough = zone.clamp(37.209, -93.2923);
  assert.equal(passthrough.lat, 37.209, 'outside points untouched');

  // path passing through the zone splits into two runs, no chord across home
  const pts = [
    [1, 37.170, -93.311], // south of home, outside
    [2, HOME.lat, HOME.lng], // inside — dropped
    [3, 37.207, -93.311], // north of home, outside
  ];
  const runs = zone.filterPath(pts);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].length, 1);
  assert.equal(runs[1].length, 1);
});

test('publicPosition clamps to the zone edge while home; snapshot stays clean', async () => {
  const { tracker } = await makeTracker();
  tracker.onTelemetry({ lat: HOME.lat, lng: HOME.lng, speedMph: 0, state: 'online' });
  const pos = tracker.publicPosition();
  assert.equal(pos.clamped, true);
  assert.ok(distFromHome(pos.lat, pos.lng) >= HOME.radiusM - 1);
  assertNoInZoneCoords(tracker.publicSnapshot(), 'snapshot');
  tracker.stop();
});

test('a full shift that starts and ends AT HOME leaks nothing overlay-facing', async () => {
  const { tracker, clock, events } = await makeTracker();

  // drive: home -> downtown (ride) -> back home
  const drive = [
    [HOME.lat, HOME.lng],
    [HOME.lat + 0.004, HOME.lng], // still inside (444m)
    [HOME.lat + 0.012, HOME.lng], // outside
    [37.205, -93.30],
    [37.209, -93.2923], // downtown pickup
  ];
  await tracker.startShift({});
  for (const [lat, lng] of drive) {
    tracker.onTelemetry({ lat, lng, speedMph: 25, state: 'driving' });
    clock.advance(30_000);
  }
  await tracker.startRide({}); // pickup downtown (outside)
  const rideLeg = [[37.215, -93.285], [37.22, -93.28]];
  for (const [lat, lng] of rideLeg) {
    tracker.onTelemetry({ lat, lng, speedMph: 30, state: 'driving' });
    clock.advance(30_000);
  }
  await tracker.endRide({ fareCents: 1250 });
  // deadhead home, ending INSIDE the zone
  const back = [[37.21, -93.30], [HOME.lat + 0.012, HOME.lng], [HOME.lat, HOME.lng]];
  for (const [lat, lng] of back) {
    tracker.onTelemetry({ lat, lng, speedMph: 25, state: 'driving' });
    clock.advance(30_000);
  }
  // one more ride whose pickup is INSIDE the zone (worst case)
  await tracker.startRide({});
  clock.advance(60_000);
  tracker.onTelemetry({ lat: 37.209, lng: -93.2923, speedMph: 20, state: 'driving' });
  await tracker.endRide({ fareCents: 800 });
  await tracker.endShift({});

  // 1. every WS event payload is clean
  for (const e of events) assertNoInZoneCoords(e.data, `event:${e.type}`);

  // 2. stream route: no in-zone points; tail against the zone is flagged for the fade
  const route = await tracker.routeToday({});
  assert.ok(route.segments.length > 0, 'route has segments');
  assertNoInZoneCoords(route.segments, 'route');
  assert.ok(
    route.segments.some((s) => s.fadeStart || s.fadeEnd),
    'segments bordering the zone carry fade flags',
  );

  // 3. stream heat: the in-zone pickup is dropped, not clamped into a bin
  const heat = await tracker.heat({});
  assertNoInZoneCoords(heat.cells, 'heat');
  assert.equal(heat.total, 1, 'only the downtown pickup remains');

  // 4. snapshot clean
  assertNoInZoneCoords(tracker.publicSnapshot(), 'snapshot');

  // 5. private (PWA) views DO keep raw data
  const privRoute = await tracker.routeToday({ privateView: true });
  const privPts = privRoute.segments.flatMap((s) => s.pts);
  assert.ok(
    privPts.some(([lng, lat]) => distFromHome(lat, lng) < HOME.radiusM),
    'private route retains in-zone points',
  );
  const privHeat = await tracker.heat({ privateView: true });
  assert.equal(privHeat.total, 2, 'private heat keeps the home pickup');
  const privRides = tracker.ridesTodayList(true);
  assert.ok(privRides.some((r) => r.pickup && distFromHome(r.pickup.lat, r.pickup.lng) < HOME.radiusM));
  // and the public ride list carries no coordinates at all
  for (const r of tracker.ridesTodayList(false)) {
    assert.equal(r.pickup, undefined);
    assert.equal(r.dropoff, undefined);
  }
  tracker.stop();
});
