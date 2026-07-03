import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLogbook } from '../src/logbook.js';

const cfg = { trip: { avgIceTankRangeMi: 29, iceMpg: 25, gasPriceUsdPerGal: 3.2 } };

const route = {
  totalLegs: 2,
  legs: [
    { leg: 1, end_landmark_id: 'stay_a' },
    { leg: 2, end_landmark_id: 'stay_b' },
  ],
  route: [
    { id: 'start', type: 'origin', states: ['MO'] },
    { id: 'sc_one', type: 'supercharger', states: ['OK'] },
    { id: 'stay_a', type: 'stay', states: ['TX'] },
    { id: 'sc_two', type: 'supercharger', states: ['NM'] },
    { id: 'stay_b', type: 'stay', states: ['AZ'] },
  ],
  roadPath: { totalM: 1000000 },
};

const storeWith = (s) => ({ get: () => ({ visited: [], ...s }) });

test('states union: visited landmark codes + pg statesSeen, deduped', () => {
  const lb = deriveLogbook(route, storeWith({
    visited: ['start', 'sc_one'],
    statesSeen: ['MO', 'KS'], // KS crossed without a landmark — pg geocoding caught it
  }), cfg);
  assert.equal(lb.states, 3); // MO, OK, KS
});

test('states falls back to landmark-derived alone when statesSeen is absent', () => {
  const lb = deriveLogbook(route, storeWith({ visited: ['start', 'stay_a'] }), cfg);
  assert.equal(lb.states, 2);
});

test('superchargers prefers the pg fast-charge stop count when present', () => {
  const lb = deriveLogbook(route, storeWith({
    visited: ['sc_one'], // only one landmark SC hit...
    fastChargeStops: 5, // ...but TeslaMate saw five fast-charge stops (off-plan chargers)
  }), cfg);
  assert.equal(lb.superchargers, 5);
});

test('superchargers never drops below the visited-landmark count', () => {
  const lb = deriveLogbook(route, storeWith({
    visited: ['sc_one', 'sc_two'],
    fastChargeStops: 1, // stale/lagging pg count must not undercount the overlay
  }), cfg);
  assert.equal(lb.superchargers, 2);
});

test('superchargers uses visited landmarks when pg has never polled (demo)', () => {
  const lb = deriveLogbook(route, storeWith({
    visited: ['sc_one', 'sc_two'],
    fastChargeStops: null,
  }), cfg);
  assert.equal(lb.superchargers, 2);
});
