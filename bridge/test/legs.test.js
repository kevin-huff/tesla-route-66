import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoute } from '../src/legs.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TEST_DIR, '../..');

function route() {
  return loadRoute({
    legsPath: path.join(REPO, 'config/legs.json'),
    landmarksPath: path.join(REPO, 'planning/landmarks.json'),
  });
}

const ALL_ENDS = [
  'stay_amarillo', 'stay_flagstaff', 'stay_maricopa',
  'stay_elpaso', 'stay_garland', 'springfield_home',
];

test('loads six legs + six nodes + ordered route', () => {
  const r = route();
  assert.equal(r.totalLegs, 6);
  assert.equal(Object.keys(r.nodes).length, 6);
  assert.ok(r.route.length > 50); // all landmarks across legs
  assert.ok(r.landmark('cadillac_ranch'));
  assert.equal(r.landmark('cadillac_ranch').leg, 2);
});

test('currentLeg derives from visited end landmarks (restart-proof)', () => {
  const r = route();
  assert.equal(r.currentLeg([]), 1);
  assert.equal(r.currentLeg(['stay_amarillo']), 2);
  assert.equal(r.currentLeg(['stay_amarillo', 'stay_flagstaff']), 3);
  assert.equal(r.currentLeg(ALL_ENDS), 6); // capped at totalLegs
});

test('legStatus indexes 1:1 to the six leg paths', () => {
  const r = route();
  assert.deepEqual(r.legStatus([]), [
    'current', 'future', 'future', 'future', 'future', 'future',
  ]);
  assert.deepEqual(r.legStatus(['stay_amarillo', 'stay_flagstaff']), [
    'done', 'done', 'current', 'future', 'future', 'future',
  ]);
});

test('vehicle SVG projection lands on node coords at leg endpoints', () => {
  const r = route();
  const FLG = r.nodes.FLG;
  const MCP = r.nodes.MCP;

  // at Flagstaff, start of leg 3 -> svg ~ FLG node
  const atStart = r.computeMapState({
    lat: FLG.lat, lng: FLG.lng,
    visited: ['stay_amarillo', 'stay_flagstaff'], speedMph: 60,
  });
  assert.equal(atStart.currentLeg, 3);
  assert.ok(Math.abs(atStart.vehicle.svgX - FLG.svg[0]) < 3);
  assert.ok(Math.abs(atStart.vehicle.svgY - FLG.svg[1]) < 3);
  assert.ok(atStart.vehicle.progress < 0.02);

  // at Maricopa, end of leg 3 -> svg ~ MCP node, progress ~1
  const atEnd = r.computeMapState({
    lat: MCP.lat, lng: MCP.lng,
    visited: ['stay_amarillo', 'stay_flagstaff'], speedMph: 0,
  });
  assert.ok(Math.abs(atEnd.vehicle.svgX - MCP.svg[0]) < 3);
  assert.ok(Math.abs(atEnd.vehicle.svgY - MCP.svg[1]) < 3);
  assert.ok(atEnd.vehicle.progress > 0.98);
  assert.equal(atEnd.distToNextMi, 0);
  assert.equal(atEnd.etaText, '--:--'); // speed 0 -> no eta
});

test('next waypoint + STANDBY tag at leg 3', () => {
  const r = route();
  const m = r.computeMapState({
    lat: r.nodes.FLG.lat, lng: r.nodes.FLG.lng,
    visited: ['stay_amarillo', 'stay_flagstaff'], speedMph: 60,
  });
  assert.equal(m.nextWaypoint.name, 'MARICOPA, AZ');
  assert.equal(m.nextWaypoint.tag, 'STANDBY');
});

test('Maricopa standby active only between arrival and leg-4 start', () => {
  const r = route();
  const base = { lat: r.nodes.MCP.lat, lng: r.nodes.MCP.lng, speedMph: 0 };
  // arrived (leg-3 end visited), leg 4 not started -> standby active
  const parked = r.computeMapState({ ...base, visited: ['stay_amarillo', 'stay_flagstaff', 'stay_maricopa'] });
  assert.equal(parked.standby.active, true);
  // once picacho_peak (leg-4 start) is hit -> standby ends
  const rolling = r.computeMapState({ ...base, visited: ['stay_amarillo', 'stay_flagstaff', 'stay_maricopa', 'picacho_peak'] });
  assert.equal(rolling.standby.active, false);
});
