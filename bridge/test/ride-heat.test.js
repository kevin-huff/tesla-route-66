// ride-heat.test.js — grid binning: aggregation, bin geometry, analytics filters.

import test from 'node:test';
import assert from 'node:assert/strict';
import { binPickups } from '../src/ride/heat.js';
import { haversine } from '../src/geo.js';

const P = (lat, lng, iso) => ({ lat, lng, startedAt: iso });

test('nearby pickups aggregate into one bin; far ones split', () => {
  const pickups = [
    P(37.2090, -93.2923, '2026-06-01T02:00:00Z'),
    P(37.20901, -93.29231, '2026-06-02T02:00:00Z'), // ~2m away — same 250m bin
    P(37.20899, -93.29229, '2026-06-03T02:00:00Z'),
    P(37.2290, -93.2923, '2026-06-04T02:00:00Z'), // ~2.2km north — different bin
  ];
  const r = binPickups(pickups, { binM: 250 });
  assert.equal(r.total, 4);
  assert.equal(r.max, 3);
  assert.equal(r.cells.length, 2);
  const big = r.cells.find((c) => c.n === 3);
  assert.ok(haversine(big.lat, big.lng, 37.2091, -93.2923) < 250, 'bin center lands near its points');
});

test('no raw point dump: bins are centers + counts only', () => {
  const r = binPickups([P(37.21, -93.29, '2026-06-01T02:00:00Z')], { binM: 250 });
  assert.deepEqual(Object.keys(r.cells[0]).sort(), ['lat', 'lng', 'n']);
});

test('from/to/dow/hour analytics filters', () => {
  const pickups = [
    // Fri 2026-06-05 21:00 Chicago = 2026-06-06T02:00Z
    P(37.21, -93.29, '2026-06-06T02:00:00.000Z'),
    // Sat 2026-06-06 23:00 Chicago = 2026-06-07T04:00Z
    P(37.22, -93.28, '2026-06-07T04:00:00.000Z'),
    // Mon 2026-06-08 10:00 Chicago
    P(37.23, -93.27, '2026-06-08T15:00:00.000Z'),
  ];
  const tz = 'America/Chicago';
  assert.equal(binPickups(pickups, { from: '2026-06-07T00:00:00Z', timezone: tz }).total, 2);
  assert.equal(binPickups(pickups, { to: '2026-06-07T00:00:00Z', timezone: tz }).total, 1);
  assert.equal(binPickups(pickups, { dow: '5,6', timezone: tz }).total, 2, 'Fri+Sat');
  assert.equal(binPickups(pickups, { hour: '21,22,23', timezone: tz }).total, 2, 'late-night hours');
  assert.equal(binPickups(pickups, { dow: '1', hour: '10', timezone: tz }).total, 1);
  assert.equal(binPickups(pickups, { dow: 'junk', timezone: tz }).total, 3, 'bad filter ignored');
});

test('binM controls resolution', () => {
  const pickups = [
    P(37.2090, -93.2923, '2026-06-01T02:00:00Z'),
    P(37.20984, -93.2923, '2026-06-01T02:00:00Z'), // ~94m apart
  ];
  assert.equal(binPickups(pickups, { binM: 100 }).cells.length, 2);
  assert.equal(binPickups(pickups, { binM: 500 }).cells.length, 1);
});
