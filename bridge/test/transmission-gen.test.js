import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransmissionGenerator, parseTransmission, capBody, ANGLES } from '../src/transmission-gen.js';

const baseCfg = {
  trip: { timezone: 'America/Chicago' },
  transmissions: {
    source: 'llm', intervalSec: 300, drivingOnly: true, minMoveMi: 3,
    llm: { baseUrl: 'http://x/v1', model: 'm' },
  },
};

const fakeState = (o = {}) => ({
  telemetry: {
    lat: o.lat ?? 35.18, lng: o.lng ?? -101.98, state: o.state ?? 'driving',
    heading: o.heading ?? 'WSW', speedMph: o.speedMph ?? 63,
  },
  map: { currentLeg: o.leg ?? 2 },
});

const reply = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

test('parseTransmission handles JSON, code fences, and plain-text fallback', () => {
  assert.deepEqual(parseTransmission('{"place":"SHAMROCK, TX","body":"Neon."}'), { place: 'SHAMROCK, TX', body: 'Neon.' });
  assert.deepEqual(parseTransmission('```json\n{"place":"ADRIAN, TX","body":"Midpoint."}\n```'), { place: 'ADRIAN, TX', body: 'Midpoint.' });
  const r = parseTransmission('Just prose, no json here.');
  assert.equal(r.place, null);
  assert.ok(r.body.includes('prose'));
});

test('capBody leaves short bodies and trims long ones to a sentence boundary', () => {
  assert.equal(capBody('Short one.'), 'Short one.');
  const long = 'Neon and chrome on the old road. '.repeat(20); // ~660 chars
  const out = capBody(long, 360);
  assert.ok(out.length <= 360, `length ${out.length}`);
  assert.ok(out.endsWith('.'), 'ends at a sentence boundary');
});

test('generator caps an over-long model body', async () => {
  const orig = globalThis.fetch;
  const huge = 'The road runs on and on. '.repeat(40); // ~1000 chars
  globalThis.fetch = reply(`{"place":"x","body":"${huge.trim()}"}`);
  try {
    let tx = null;
    await createTransmissionGenerator({ cfg: baseCfg, state: fakeState(), hub: { setHealth() {} }, emit: (t) => { tx = t; } }).generateNow();
    assert.ok(tx.body.length <= 360, `body length ${tx.body.length}`);
  } finally { globalThis.fetch = orig; }
});

test('generator calls the LLM and emits a fully-formed transmission', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = reply('{"place":"cadillac ranch, tx","body":"Ten Cadillacs nose-down."}');
  try {
    let tx = null;
    const gen = createTransmissionGenerator({ cfg: baseCfg, state: fakeState(), hub: { setHealth() {} }, emit: (t) => { tx = t; } });
    await gen.tick();
    assert.ok(tx, 'emitted');
    assert.equal(tx.place, 'CADILLAC RANCH, TX'); // uppercased
    assert.equal(tx.sig, 'INCOMING TRANSMISSION');
    assert.equal(tx.header, 'INCOMING TRANSMISSION // CADILLAC RANCH, TX');
    assert.ok(tx.body.includes('Cadillacs'));
    assert.equal(tx.type_, 'llm');
    assert.equal(tx.leg, 2);
    assert.ok(tx.latText.includes('°N'));
    assert.ok(tx.id.startsWith('llm-'));
  } finally { globalThis.fetch = orig; }
});

test('drivingOnly skips (no LLM call) when the car is parked/asleep', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...a) => { calls += 1; return reply('{"place":"X","body":"y"}')(...a); };
  try {
    let tx = null;
    for (const s of ['parked', 'asleep', 'offline']) {
      const gen = createTransmissionGenerator({ cfg: baseCfg, state: fakeState({ state: s }), hub: { setHealth() {} }, emit: (t) => { tx = t; } });
      await gen.tick();
    }
    assert.equal(calls, 0);
    assert.equal(tx, null);
  } finally { globalThis.fetch = orig; }
});

test('charging counts as on-the-road: a docked car still transmits (once — move gate holds)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = reply('{"place":"SHAMROCK, TX","body":"Docked at the U-Drop Inn."}');
  try {
    let tx = null;
    const gen = createTransmissionGenerator({ cfg: baseCfg, state: fakeState({ state: 'charging' }), hub: { setHealth() {} }, emit: (t) => { tx = t; } });
    await gen.tick();
    assert.ok(tx, 'charging emits');
    tx = null;
    await gen.tick(); // same spot — minMoveMi gate blocks a repeat while docked
    assert.equal(tx, null);
  } finally { globalThis.fetch = orig; }
});

test('each call carries an angle and avoids recently covered places', async () => {
  const orig = globalThis.fetch;
  const sent = [];
  let n = 0;
  globalThis.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    n += 1;
    return { ok: true, json: async () => ({ choices: [{ message: { content: `{"place":"PLACE ${n}","body":"b"}` } }] }) };
  };
  try {
    const gen = createTransmissionGenerator({ cfg: baseCfg, state: fakeState(), hub: { setHealth() {} }, emit: () => {} });
    await gen.generateNow();
    const first = sent[0].messages[1].content;
    assert.ok(first.includes('ANGLE for this transmission:'), 'angle instruction present');
    assert.ok(!first.includes('Recent transmissions'), 'no recent list on the first call');

    await gen.generateNow();
    const second = sent[1].messages[1].content;
    assert.ok(second.includes('Recent transmissions already covered: PLACE 1'), 'recent places fed back');
    assert.deepEqual(gen._recent(), ['PLACE 1', 'PLACE 2']);
  } finally { globalThis.fetch = orig; }
});

test('angles draw from a shuffle bag: all distinct before any repeats', async () => {
  const orig = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"place":"X","body":"y"}' } }] }) };
  };
  try {
    const gen = createTransmissionGenerator({ cfg: baseCfg, state: fakeState(), hub: { setHealth() {} }, emit: () => {} });
    for (let i = 0; i < ANGLES.length; i++) await gen.generateNow();
    const instructions = sent.map((p) => p.messages[1].content.match(/ANGLE for this transmission: (.+)/)[1]);
    assert.equal(new Set(instructions).size, ANGLES.length, 'every angle used once before repeating');
  } finally { globalThis.fetch = orig; }
});

// minimal route fixture: three waypoints strung along a road path, Amarillo-ish coords
const fakeRoute = () => ({
  route: [
    { id: 'cad', name: 'Cadillac Ranch', header: 'INCOMING TRANSMISSION // CADILLAC RANCH, TX', lat: 35.187, lng: -101.987 },
    { id: 'adr', name: 'Adrian', header: 'INCOMING TRANSMISSION // ADRIAN, TX', lat: 35.274, lng: -102.673 },
    { id: 'gle', name: 'Glenrio', header: 'INCOMING TRANSMISSION // GLENRIO, TX/NM', lat: 35.179, lng: -103.039 },
  ],
  roadPath: { distById: new Map([['cad', 10000], ['adr', 60000], ['gle', 95000]]) },
});

test('on-plan prompts carry a route fix: waypoint passed + waypoints ahead, locality rule enforced', async () => {
  const orig = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"place":"X","body":"y"}' } }] }) };
  };
  try {
    const state = fakeState();
    state.map.routeDistM = 30000; // ~12 mi past Cadillac Ranch, ~19 before Adrian
    const gen = createTransmissionGenerator({ cfg: baseCfg, state, hub: { setHealth() {} }, route: fakeRoute(), emit: () => {} });
    await gen.generateNow();
    const user = sent.messages[1].content;
    assert.ok(user.includes('already passed CADILLAC RANCH, TX (12 mi back'), `passed waypoint anchored: ${user}`);
    assert.ok(user.includes('ahead on the planned road: ADRIAN, TX in 19 mi, then GLENRIO, TX/NM in 40 mi'), `upcoming waypoints anchored: ${user}`);
    assert.ok(sent.messages[0].content.includes('Stay LOCAL'), 'system prompt carries the locality rule');
  } finally { globalThis.fetch = orig; }
});

test('off-plan prompts fall back to the nearest waypoint as a loose anchor', async () => {
  const orig = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"place":"X","body":"y"}' } }] }) };
  };
  try {
    const state = fakeState({ lat: 35.2, lng: -102.6 }); // near Adrian, but routeDistM unset (off the line)
    const gen = createTransmissionGenerator({ cfg: baseCfg, state, hub: { setHealth() {} }, route: fakeRoute(), emit: () => {} });
    await gen.generateNow();
    const user = sent.messages[1].content;
    assert.ok(user.includes('nearest planned waypoint is ADRIAN, TX'), `nearest waypoint named: ${user}`);
  } finally { globalThis.fetch = orig; }
});

test('no route handle (tests / minimal boot) means no route fix and no crash', async () => {
  const orig = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"place":"X","body":"y"}' } }] }) };
  };
  try {
    const gen = createTransmissionGenerator({ cfg: baseCfg, state: fakeState(), hub: { setHealth() {} }, emit: () => {} });
    const r = await gen.generateNow();
    assert.equal(r.ok, true);
    assert.ok(!sent.messages[1].content.includes('Route fix:'));
  } finally { globalThis.fetch = orig; }
});

test('minMoveMi skips when the car has not moved far enough since the last one', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...a) => { calls += 1; return reply('{"place":"X","body":"y"}')(...a); };
  try {
    const gen = createTransmissionGenerator({ cfg: baseCfg, state: fakeState({ lat: 35.18, lng: -101.98 }), hub: { setHealth() {} }, emit: () => {} });
    gen._setLast({ lat: 35.181, lng: -101.981 }); // ~0.1 mi, under the 3 mi gate
    await gen.tick();
    assert.equal(calls, 0);
  } finally { globalThis.fetch = orig; }
});

test('generateNow() ignores the driving/move gates and returns the result', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = reply('{"place":"adrian, tx","body":"Dead center of Route 66."}');
  try {
    let tx = null;
    const gen = createTransmissionGenerator({ cfg: baseCfg, state: fakeState({ state: 'charging' }), hub: { setHealth() {} }, emit: (t) => { tx = t; } });
    gen._setLast({ lat: 35.18, lng: -101.98 }); // would normally be blocked by minMoveMi too
    const r = await gen.generateNow();
    assert.equal(r.ok, true);
    assert.equal(r.tx.place, 'ADRIAN, TX');
    assert.ok(tx, 'still emits to the overlay');
  } finally { globalThis.fetch = orig; }
});

test('temperature is omitted unless explicitly numeric (newer Claude rejects it)', async () => {
  const orig = globalThis.fetch;
  let sent = null;
  const capture = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"place":"x","body":"y"}' } }] }) };
  };
  const cfgWith = (temperature) => ({
    ...baseCfg,
    transmissions: { ...baseCfg.transmissions, llm: { baseUrl: 'http://x/v1', model: 'm', temperature } },
  });
  try {
    globalThis.fetch = capture;
    await createTransmissionGenerator({ cfg: cfgWith(null), state: fakeState(), hub: { setHealth() {} }, emit: () => {} }).generateNow();
    assert.equal('temperature' in sent, false, 'omitted when null');

    await createTransmissionGenerator({ cfg: cfgWith(0.7), state: fakeState(), hub: { setHealth() {} }, emit: () => {} }).generateNow();
    assert.equal(sent.temperature, 0.7, 'included when numeric');
  } finally { globalThis.fetch = orig; }
});

test('an endpoint failure is swallowed and flagged in health (card holds last frame)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 502, text: async () => 'bad gateway' });
  try {
    let tx = null;
    let health = null;
    const gen = createTransmissionGenerator({ cfg: baseCfg, state: fakeState(), hub: { setHealth: (h) => { health = h; } }, emit: (t) => { tx = t; } });
    await gen.tick(); // must not throw
    assert.equal(tx, null);
    assert.deepEqual(health, { llm: 'error' });
  } finally { globalThis.fetch = orig; }
});
