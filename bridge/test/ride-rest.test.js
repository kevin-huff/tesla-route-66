// ride-rest.test.js — the /api/ride/* surface: dispatch, auth, error mapping,
// dollars-vs-cents bodies. Drives routes.handle() directly with stub req/res.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonRideStore } from '../src/ride/json-store.js';
import { createRideTracker } from '../src/ride/tracker.js';
import { createRideRoutes } from '../src/ride/routes.js';

const TOKEN = 'test-token-123';

async function makeApi({ token = TOKEN } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-rest-'));
  const store = createJsonRideStore(path.join(dir, 'ride.json'));
  let t = new Date('2026-07-03T02:00:00Z').getTime();
  const cfg = {
    ride: {
      timezone: 'America/Chicago', statsTickSec: 3600, authToken: token,
      privacy: { lat: null, lng: null, radiusM: 0 }, heat: { binM: 250 }, path: {},
    },
  };
  const tracker = await createRideTracker({ cfg, store, now: () => t });
  tracker.setBroadcast(() => {});
  const routes = createRideRoutes({ tracker, cfg });

  async function call(method, pathAndQuery, { body, auth } = {}) {
    const url = new URL(`http://x${pathAndQuery}`);
    const req = {
      method,
      headers: auth === undefined ? { authorization: `Bearer ${TOKEN}` } : auth ? { authorization: auth } : {},
    };
    let statusCode = null;
    let payload = null;
    const res = {};
    const helpers = {
      json: (_res, code, obj) => { statusCode = code; payload = obj; },
      readBody: async () => body || {},
    };
    const handled = await routes.handle(req, res, url, helpers);
    return { handled, statusCode, payload };
  }

  return { call, tracker, advance: (ms) => { t += ms; } };
}

test('auth: mutations and private views need the token; public GETs do not', async () => {
  const { call } = await makeApi();
  assert.equal((await call('POST', '/api/ride/shift/start', { auth: false })).statusCode, 401);
  assert.equal((await call('POST', '/api/ride/shift/start', { auth: 'Bearer wrong' })).statusCode, 401);
  assert.equal((await call('GET', '/api/ride/rides/today?private=1', { auth: false })).statusCode, 401);
  assert.equal((await call('GET', '/api/ride/stats/today', { auth: false })).statusCode, 200);
  assert.equal((await call('GET', '/api/ride/map/heat', { auth: false })).statusCode, 200);
  // query-param token works for browser-y clients
  assert.equal(
    (await call('POST', `/api/ride/shift/start?token=${TOKEN}`, { auth: false })).statusCode,
    200,
  );
});

test('full workflow over REST, chat-style dollars accepted', async () => {
  const { call, advance } = await makeApi();
  assert.equal((await call('POST', '/api/ride/shift/start')).statusCode, 200);
  assert.equal((await call('POST', '/api/ride/start')).statusCode, 200);
  advance(8 * 60_000);
  const end = await call('POST', '/api/ride/end', { body: { earnings: '14.75', source: 'chat' } });
  assert.equal(end.statusCode, 200);
  assert.equal(end.payload.ride.fareCents, 1475);
  assert.match(end.payload.chatText, /\$14\.75/);

  const tip = await call('POST', '/api/ride/tip', { body: { amount: '5', source: 'chat' } });
  assert.equal(tip.statusCode, 200);
  assert.equal(tip.payload.tip.amountCents, 500);

  const stats = await call('GET', '/api/ride/stats/today', { auth: false });
  assert.equal(stats.payload.stats.today.earningsCents, 1975);
  assert.ok(stats.payload.chatText.includes('$19.75'));

  const rides = await call('GET', '/api/ride/rides/today', { auth: false });
  assert.equal(rides.payload.rides.length, 1);
  assert.equal(rides.payload.rides[0].pickup, undefined, 'public list carries no coords');

  assert.equal((await call('POST', '/api/ride/shift/end')).statusCode, 200);
});

test('error mapping: 409 for state conflicts, 400 for bad values, 404 unknown', async () => {
  const { call } = await makeApi();
  assert.equal((await call('POST', '/api/ride/start')).statusCode, 409); // no shift
  await call('POST', '/api/ride/shift/start');
  assert.equal((await call('POST', '/api/ride/end', { body: { earnings: '5' } })).statusCode, 409); // no ride
  await call('POST', '/api/ride/start');
  assert.equal((await call('POST', '/api/ride/end', { body: {} })).statusCode, 400); // no fare
  assert.equal((await call('POST', '/api/ride/map/mode', { body: { mode: 'bogus' } })).statusCode, 400);
  assert.equal((await call('GET', '/api/ride/nope')).statusCode, 404);
});

test('map mode + seed endpoints', async () => {
  const { call } = await makeApi();
  const mode = await call('POST', '/api/ride/map/mode', { body: { mode: 'HEAT' } });
  assert.equal(mode.statusCode, 200);
  assert.equal(mode.payload.mode, 'heat');

  const seed = await call('POST', '/api/ride/seed', {
    body: { month: '2026-07', earnings: '1842.75', rides: 131, shiftSeconds: 324000 },
  });
  assert.equal(seed.statusCode, 200);
  const month = await call('GET', '/api/ride/stats/month', { auth: false });
  assert.equal(month.payload.month.earningsCents, 184275);
  assert.equal(month.payload.month.rides, 131);
});

test('auth disabled when token is unset/CHANGE_ME (dev + demo)', async () => {
  const { call } = await makeApi({ token: 'CHANGE_ME' });
  assert.equal((await call('POST', '/api/ride/shift/start', { auth: false })).statusCode, 200);
});
