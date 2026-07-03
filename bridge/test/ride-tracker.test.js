// ride-tracker.test.js — shift/ride/tip lifecycle, timestamp-derived timers,
// restart resume (the store is the truth), idempotency, and monthly-seed math.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonRideStore } from '../src/ride/json-store.js';
import { createRideTracker, normalizeCents, fmtUsd, fmtMSS, fmtHMMSS } from '../src/ride/tracker.js';

const BASE = new Date('2026-07-03T02:00:00Z').getTime(); // 9:00 PM Jul 2, America/Chicago

function makeCfg(over = {}) {
  return {
    ride: {
      timezone: 'America/Chicago',
      statsTickSec: 3600, // effectively off; unref'd anyway
      shiftStartsAt: '9:00 PM',
      privacy: { lat: null, lng: null, radiusM: 0 },
      heat: { binM: 250 },
      path: { minMoveM: 40, maxPoints: 500 },
      ...over,
    },
  };
}

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-test-'));
  return createJsonRideStore(path.join(dir, 'ride.json'));
}

async function makeTracker({ store = tmpStore(), cfg = makeCfg(), start = BASE } = {}) {
  let t = start;
  const clock = { advance: (ms) => { t += ms; }, now: () => t };
  const tracker = await createRideTracker({ cfg, store, now: clock.now });
  const events = [];
  tracker.setBroadcast((type, data) => events.push({ type, data }));
  return { tracker, clock, store, events, cfg };
}

test('full shift lifecycle: timers, stats, ticker, chat lines', async () => {
  const { tracker, clock, events } = await makeTracker();

  const s0 = tracker.stats();
  assert.equal(s0.shift.status, 'off');
  assert.equal(s0.shift.startsAt, '9:00 PM');

  const sh = await tracker.startShift({});
  assert.equal(sh.ok, true);
  assert.equal(tracker.stats().shift.status, 'live');
  assert.ok(tracker.stats().idleStartedAt, 'idle interval opens with the shift');

  clock.advance(5 * 60_000); // 5 min idle
  tracker.onTelemetry({ lat: 37.21, lng: -93.29, speedMph: 0, state: 'online', outsideF: 60 });
  const r1 = await tracker.startRide({});
  assert.equal(r1.ok, true);
  assert.equal(r1.ride.n, 1);
  assert.equal(tracker.stats().idleStartedAt, null, 'idle closes when a ride opens');

  clock.advance(18 * 60_000); // 18 min ride
  tracker.onTelemetry({ lat: 37.25, lng: -93.25, speedMph: 20, state: 'driving', outsideF: 60 });
  const e1 = await tracker.endRide({ earnings: '12.47' });
  assert.equal(e1.ok, true);
  assert.equal(e1.ride.fareCents, 1247);
  assert.equal(e1.ride.durSec, 18 * 60);
  assert.match(e1.chatText, /RIDE #1 COMPLETE · 18:00 · \$12\.47/);
  assert.ok(tracker.stats().idleStartedAt, 'idle reopens after dropoff');

  const s1 = tracker.stats();
  assert.equal(s1.today.earningsCents, 1247);
  assert.equal(s1.today.rides, 1);
  assert.equal(s1.today.rideSec, 18 * 60);
  assert.equal(s1.today.idleSec, 5 * 60);

  const tip = await tracker.addTip({ amount: 3 });
  assert.equal(tip.ok, true);
  assert.equal(tip.tip.amountCents, 300);
  assert.equal(tip.ride.n, 1, 'chat tip defaults to the last completed ride');
  assert.equal(tracker.stats().today.earningsCents, 1547);
  assert.equal(tracker.ticker()[0].tipCents, 300);

  clock.advance(4 * 60_000);
  await tracker.startRide({});
  clock.advance(10 * 60_000);
  await tracker.endRide({ fareCents: 900 });

  const blockedEnd = await tracker.endShift({});
  assert.equal(blockedEnd.ok, true); // no open ride — allowed
  const sum = blockedEnd.summary;
  assert.equal(sum.rides, 2);
  assert.equal(sum.earningsCents, 1247 + 300 + 900);
  assert.equal(sum.rideSec, 28 * 60);
  assert.equal(sum.idleSec, 9 * 60);
  assert.equal(sum.shiftSec, 37 * 60);
  assert.match(blockedEnd.chatText, /SHIFT COMPLETE · 0:37:00 · \$24\.47 · 2 rides/);

  const types = events.map((e) => e.type);
  for (const t of ['shift_started', 'ride_started', 'ride_ended', 'tip_added', 'shift_ended']) {
    assert.ok(types.includes(t), `broadcasts ${t}`);
  }
});

test('guards: no shift, double start, open ride blocks shift end', async () => {
  const { tracker, clock } = await makeTracker();
  assert.equal((await tracker.startRide({})).code, 'no_shift');
  await tracker.startShift({});
  const again = await tracker.startShift({});
  assert.equal(again.already, true, 'double start_shift is a no-op, not an error');
  await tracker.startRide({});
  assert.equal((await tracker.startRide({})).code, 'ride_open');
  assert.equal((await tracker.endShift({})).code, 'ride_open');
  clock.advance(1000);
  assert.equal((await tracker.endRide({ earnings: 'not-a-number' })).code, 'bad_fare');
  assert.equal((await tracker.endRide({ earnings: 5 })).ok, true);
  assert.equal((await tracker.endRide({ earnings: 5 })).code, 'no_ride');
});

test('idempotency: same key replays the original result, no duplicate records', async () => {
  const { tracker, clock, store } = await makeTracker();
  await tracker.startShift({});
  const a = await tracker.startRide({ idempotencyKey: 'k1' });
  const b = await tracker.startRide({ idempotencyKey: 'k1' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.replayed, true);
  assert.equal(b.ride.id, a.ride.id);
  assert.equal((await store.listRides()).length, 1);

  clock.advance(60_000);
  const e1 = await tracker.endRide({ idempotencyKey: 'k2', fareCents: 1000 });
  const e2 = await tracker.endRide({ idempotencyKey: 'k2', fareCents: 1000 });
  assert.equal(e2.replayed, true);
  assert.equal(e1.ride.id, e2.ride.id);
  assert.equal(tracker.stats().today.earningsCents, 1000, 'fare counted once');

  const t1 = await tracker.addTip({ idempotencyKey: 'k3', amountCents: 500 });
  const t2 = await tracker.addTip({ idempotencyKey: 'k3', amountCents: 500 });
  assert.equal(t2.replayed, true);
  assert.equal(t1.tip.id, t2.tip.id);
  assert.equal(tracker.stats().today.earningsCents, 1500, 'tip counted once');
});

test('restart mid-ride: a new tracker on the same store resumes timers from timestamps', async () => {
  const store = tmpStore();
  const { tracker, clock } = await makeTracker({ store });
  await tracker.startShift({});
  clock.advance(10 * 60_000);
  tracker.onTelemetry({ lat: 37.2, lng: -93.3, speedMph: 25, state: 'driving' });
  await tracker.startRide({});
  clock.advance(7 * 60_000);
  await tracker.endRide({ fareCents: 1500 });
  await tracker.addTip({ amountCents: 200 });
  clock.advance(2 * 60_000);
  await tracker.startRide({});
  clock.advance(3 * 60_000);
  tracker.stop();

  // "restart": brand-new tracker, same store, clock carried forward
  const t2 = await createRideTracker({
    cfg: makeCfg(), store, now: clock.now,
  });
  t2.setBroadcast(() => {});
  const s = t2.stats();
  assert.equal(s.shift.status, 'live');
  assert.equal(s.ride.n, 2, 'open ride resumes');
  assert.equal(Math.round((clock.now() - new Date(s.ride.startedAt)) / 1000), 3 * 60, 'ride timer derives from stored timestamp');
  assert.equal(s.today.earningsCents, 1700);
  assert.equal(s.today.rides, 1);
  assert.equal(s.today.rideSec, 10 * 60, '7 completed + 3 open');
  assert.equal(s.today.idleSec, 12 * 60);
  assert.equal(s.month.earningsCents, 1700, 'no double counting after restart mid-shift');

  clock.advance(60_000);
  const e = await t2.endRide({ fareCents: 800 });
  assert.equal(e.ride.durSec, 4 * 60);
  await t2.endShift({});
  assert.equal(t2.stats().month.earningsCents, 2500);
  t2.stop();
});

test('monthly seed: month stats = seed + tracked, to the cent', async () => {
  const { tracker, clock } = await makeTracker();
  const seeded = await tracker.seedMonth({ month: '2026-07', earnings: '1842.75', rides: 131, shiftSeconds: 90 * 3600 });
  assert.equal(seeded.ok, true);
  let m = tracker.stats().month;
  assert.equal(m.earningsCents, 184275);
  assert.equal(m.rides, 131);
  assert.equal(m.shiftSec, 90 * 3600);

  await tracker.startShift({});
  await tracker.startRide({});
  clock.advance(10 * 60_000);
  await tracker.endRide({ earnings: 12.5 });
  m = tracker.stats().month;
  assert.equal(m.earningsCents, 184275 + 1250);
  assert.equal(m.rides, 132);
  await tracker.endShift({});
  m = tracker.stats().month;
  assert.equal(m.earningsCents, 185525);
  assert.equal(m.shiftSec, 90 * 3600 + 10 * 60);
  tracker.stop();
});

test('day rollover at 4 AM local: a 9 PM - 2 AM shift stays one "day"', async () => {
  const { tracker, clock } = await makeTracker(); // starts 9:00 PM Chicago
  await tracker.startShift({});
  await tracker.startRide({});
  clock.advance(30 * 60_000);
  await tracker.endRide({ fareCents: 2000 });
  clock.advance(4.5 * 3600_000); // now ~2:00 AM Chicago — past midnight, before 4 AM
  const s = tracker.stats();
  assert.equal(s.today.rides, 1, 'pre-midnight ride still counts today');
  assert.equal(s.today.earningsCents, 2000);
  tracker.stop();
});

test('tip on an already-committed shift still lands in month totals', async () => {
  const { tracker, clock } = await makeTracker();
  await tracker.startShift({});
  await tracker.startRide({});
  clock.advance(60_000);
  const ride = (await tracker.endRide({ fareCents: 1000 })).ride;
  await tracker.endShift({});
  assert.equal(tracker.stats().month.earningsCents, 1000);
  const tip = await tracker.addTip({ amountCents: 400, rideId: ride.id });
  assert.equal(tip.ok, true);
  assert.equal(tracker.stats().month.earningsCents, 1400);
  assert.equal(tracker.stats().today.earningsCents, 1400);
  tracker.stop();
});

test('resend summary rebroadcasts the last ride/shift summary', async () => {
  const { tracker, clock, events } = await makeTracker();
  assert.equal((await tracker.resendSummary()).ok, false);
  await tracker.startShift({});
  await tracker.startRide({});
  clock.advance(60_000);
  await tracker.endRide({ fareCents: 700 });
  events.length = 0;
  const r = await tracker.resendSummary();
  assert.equal(r.ok, true);
  assert.equal(events[0].type, 'ride_ended');
  assert.equal(events[0].data.resent, true);
  tracker.stop();
});

test('normalizeCents + formatters', () => {
  assert.equal(normalizeCents(1247, undefined), 1247);
  assert.equal(normalizeCents(undefined, '14.75'), 1475);
  assert.equal(normalizeCents(undefined, '$1,234.50'), 123450);
  assert.equal(normalizeCents(12.5, undefined), null, 'cents must be integers');
  assert.equal(normalizeCents(undefined, 'abc'), null);
  assert.equal(fmtUsd(123456), '$1,234.56');
  assert.equal(fmtUsd(5), '$0.05');
  assert.equal(fmtMSS(754), '12:34');
  assert.equal(fmtHMMSS(3723), '1:02:03');
});
