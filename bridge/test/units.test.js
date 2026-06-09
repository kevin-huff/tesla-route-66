import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kmToMi, miToKm, kmhToMph, cToF, mToFt, degToCompass, round, clamp } from '../src/units.js';

test('distance/speed conversions', () => {
  assert.ok(Math.abs(kmToMi(100) - 62.1371) < 1e-3);
  assert.ok(Math.abs(kmhToMph(100) - 62.1371) < 1e-3);
  assert.ok(Math.abs(miToKm(62.1371) - 100) < 1e-2);
});

test('temperature conversion', () => {
  assert.equal(cToF(0), 32);
  assert.equal(cToF(100), 212);
  assert.ok(Math.abs(cToF(37) - 98.6) < 1e-9);
});

test('elevation conversion', () => {
  assert.ok(Math.abs(mToFt(1000) - 3280.84) < 1e-2);
});

test('degToCompass — 16-point', () => {
  assert.equal(degToCompass(0), 'N');
  assert.equal(degToCompass(360), 'N');
  assert.equal(degToCompass(90), 'E');
  assert.equal(degToCompass(180), 'S');
  assert.equal(degToCompass(270), 'W');
  assert.equal(degToCompass(247.5), 'WSW'); // the prototype's nominal heading
  assert.equal(degToCompass(202.5), 'SSW'); // the prototype's warn heading
  assert.equal(degToCompass(-90), 'W'); // negatives wrap
});

test('round + clamp', () => {
  assert.equal(round(3.14159, 2), 3.14);
  assert.equal(round(1846.7), 1847);
  assert.equal(clamp(150, 0, 110), 110);
  assert.equal(clamp(-5, 0, 110), 0);
});
