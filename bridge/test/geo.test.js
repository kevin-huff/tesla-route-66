import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, bearing, withinRadius, lerp, projectFraction } from '../src/geo.js';

test('haversine — identity and known degree', () => {
  assert.equal(haversine(35, -100, 35, -100), 0);
  // 1 degree of latitude ~ 111195 m
  assert.ok(Math.abs(haversine(0, 0, 1, 0) - 111195) < 100);
  // 1 degree of longitude at the equator ~ 111195 m
  assert.ok(Math.abs(haversine(0, 0, 0, 1) - 111195) < 100);
});

test('haversine — real city pair (Springfield MO -> Amarillo TX)', () => {
  const m = haversine(37.2089878, -93.2926909, 35.1927944, -101.9332132);
  // ~ 800 km great-circle
  assert.ok(m > 780000 && m < 820000, `got ${m}`);
});

test('bearing — cardinal directions', () => {
  assert.ok(Math.abs(bearing(0, 0, 1, 0) - 0) < 1e-6); // due north
  assert.ok(Math.abs(bearing(0, 0, 0, 1) - 90) < 1e-6); // due east
  assert.ok(Math.abs(bearing(0, 0, -1, 0) - 180) < 1e-6); // due south
});

test('withinRadius', () => {
  assert.equal(withinRadius(35, -100, 35, -100, 50), true);
  assert.equal(withinRadius(35, -100, 35.01, -100, 50), false); // ~1.1km away
});

test('lerp + projectFraction endpoints', () => {
  assert.equal(lerp(0, 10, 0.5), 5);
  const a = [35.2, -111.6];
  const b = [33.07, -112.0];
  assert.ok(projectFraction(a[0], a[1], a[0], a[1], b[0], b[1]) < 1e-3); // at A -> 0
  assert.ok(projectFraction(b[0], b[1], a[0], a[1], b[0], b[1]) > 1 - 1e-3); // at B -> 1
  const mid = projectFraction((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, a[0], a[1], b[0], b[1]);
  assert.ok(Math.abs(mid - 0.5) < 0.05); // midpoint ~ 0.5
});
