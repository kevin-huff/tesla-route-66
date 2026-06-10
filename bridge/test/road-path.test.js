// road-path.test.js — invariants the road-following replay + geofences depend on:
// every landmark must map to an on-road point inside its own geofence radius, in trip
// order, and locate() must disambiguate the shared Springfield start/home coordinates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoute } from '../src/legs.js';
import { buildRoadPath, loadGeometry } from '../src/road-path.js';
import { haversine } from '../src/geo.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fixtures() {
  const route = loadRoute({
    legsPath: path.join(REPO, 'config/legs.json'),
    landmarksPath: path.join(REPO, 'planning/landmarks.json'),
  });
  const geo = loadGeometry(path.join(REPO, 'config/route-geometry.json'));
  return { route, geo };
}

test('with real geometry: every landmark lands on-road inside its geofence radius', () => {
  const { route, geo } = fixtures();
  assert.ok(geo, 'config/route-geometry.json present (run scripts/fetch-route-geometry.mjs)');
  const road = buildRoadPath(route.route, geo);

  assert.ok(road.pts.length > 3000, 'real polyline, not the landmark chain');
  route.route.forEach((lm, k) => {
    const p = road.posAt(road.lmDistM[k]);
    const d = haversine(lm.lat, lm.lng, p.lat, p.lng);
    assert.ok(d <= lm.radius_m, `${lm.id}: on-road point ${Math.round(d)}m out (radius ${lm.radius_m}m)`);
  });

  // trip order is preserved along the polyline
  for (let k = 1; k < road.lmDistM.length; k++) {
    assert.ok(road.lmDistM[k] >= road.lmDistM[k - 1], `lmDistM monotonic at ${route.route[k].id}`);
  }

  // total length matches what the generator reported
  const totalMi = road.totalM / 1609.344;
  assert.ok(Math.abs(totalMi - geo.totalMi) < 20, `total ${totalMi} mi ~ ${geo.totalMi} mi`);
});

test('without geometry: degrades to the straight landmark chain (old behavior)', () => {
  const { route } = fixtures();
  const road = buildRoadPath(route.route, null);
  assert.equal(road.pts.length, route.route.length);
  route.route.forEach((lm, k) => {
    const p = road.posAt(road.lmDistM[k]);
    assert.ok(haversine(lm.lat, lm.lng, p.lat, p.lng) < 1, `${lm.id} exact`);
  });
});

test('locate() separates Springfield start from Springfield home via minM', () => {
  const { route, geo } = fixtures();
  const road = buildRoadPath(route.route, geo);
  const spr = route.landmark('springfield_start');

  const atStart = road.locate(spr.lat, spr.lng, { minM: 0 });
  assert.ok(atStart.offM < 500);
  assert.ok(atStart.distM < 5000, 'start resolves near distance 0');

  // hint past Branson (leg 6) -> the same coords resolve to the END of the loop
  road.locate(36.673, -93.227, { minM: road.distById.get('sc_branson') - 10000 });
  const atHome = road.locate(spr.lat, spr.lng, { minM: road.distById.get('sc_branson') });
  assert.ok(atHome.offM < 500);
  assert.ok(road.totalM - atHome.distM < 5000, 'home resolves near the loop end');
});

test('computeMapState reports road miles (not crow-flies) when geometry is attached', () => {
  const { route, geo } = fixtures();
  const FLG = route.nodes.FLG;
  const visited = ['stay_amarillo', 'stay_flagstaff'];

  const straight = route.computeMapState({ lat: FLG.lat, lng: FLG.lng, visited, speedMph: 60 });
  route.attachRoadPath(buildRoadPath(route.route, geo));
  const road = route.computeMapState({ lat: FLG.lat, lng: FLG.lng, visited, speedMph: 60 });

  // leg 3 is ~188 road miles vs ~147 straight-line
  assert.ok(straight.distToNextMi < 160, `straight ${straight.distToNextMi}`);
  assert.ok(road.distToNextMi > 175 && road.distToNextMi < 200, `road ${road.distToNextMi}`);
});
