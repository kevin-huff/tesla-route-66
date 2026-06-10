// overlays.test.js — execute each overlay's real wiring (overlay-config + telemetry-client
// + the component's inline script) in a minimal fake-DOM sandbox, then push live-contract
// frames through window.R66.dispatch and assert the DOM updates. This is the cross-side
// contract check: if the bridge and an overlay disagree on a field name, a test here fails.
// (Syntax errors in any overlay JS also fail here, since the scripts are executed.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const OVERLAYS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../overlays');

function fakeEl(tag = 'div') {
  const classes = new Set();
  const el = {
    tagName: tag, _text: '', _html: '', children: [], style: {}, attributes: {}, dataset: {}, offsetWidth: 0,
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    set innerHTML(v) { this._html = String(v); if (v === '') this.children = []; },
    get innerHTML() { return this._html; },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    get className() { return [...classes].join(' '); },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : f; if (on) classes.add(c); else classes.delete(c); return on; },
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => { el.attributes[k] = String(v); if (k === 'class') el.className = v; },
    getAttribute: (k) => el.attributes[k],
    appendChild: (c) => { el.children.push(c); return c; },
    insertAdjacentText: () => {},
    remove: () => {},
    querySelector: () => null,
  };
  return el;
}

function loadOverlay(file, { search = '' } = {}) {
  const html = fs.readFileSync(path.join(OVERLAYS, file), 'utf8');
  const byId = {};
  const byKey = {};
  for (const m of html.matchAll(/id="([^"]+)"/g)) byId[m[1]] = fakeEl();
  for (const m of html.matchAll(/<span\b([^>]*\bdata-key="([^"]+)"[^>]*)>/g)) {
    const attrs = m[1];
    const e = fakeEl('span');
    e.dataset.key = m[2];
    const to = /data-to="([^"]*)"/.exec(attrs);
    if (to) e.dataset.to = to[1];
    if (/data-comma/.test(attrs)) e.dataset.comma = '1';
    byKey[m[2]] = e;
  }

  const body = fakeEl('body');
  const documentElement = fakeEl('html');
  const document = {
    readyState: 'loading',
    body,
    documentElement,
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => {
      const k = /\[data-key="([^"]+)"\]/.exec(sel);
      if (k) return byKey[k[1]] || null;
      const i = /^#(.+)$/.exec(sel);
      if (i) return byId[i[1]] || null;
      return null;
    },
    querySelectorAll: () => [],
    createElement: (t) => fakeEl(t),
    addEventListener: () => {},
  };

  const location = { search, protocol: 'http:', host: 'localhost:8787' };
  // unref'd timers: overlays schedule repeating work (page rotation, demo feeds) that
  // must not pin the test subprocess's event loop open after the assertions finish
  const bgTimeout = (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); if (t.unref) t.unref(); return t; };
  const bgInterval = (fn, ms, ...a) => { const t = setInterval(fn, ms, ...a); if (t.unref) t.unref(); return t; };
  const sandbox = {
    document, location, console,
    setTimeout: bgTimeout, clearTimeout, setInterval: bgInterval, clearInterval,
    performance: { now: () => Date.now() },
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    URLSearchParams,
    WebSocket: function () { this.send = () => {}; this.close = () => {}; },
    Math, JSON, Number, String, Array, Object, Date, parseInt, parseFloat, isNaN,
  };
  sandbox.window = sandbox; // browser-like: window === global, so `window.X = …` clobbers a same-named function X
  vm.createContext(sandbox);

  for (const m of html.matchAll(/<script(?:\s+src="([^"]+)")?\s*>([\s\S]*?)<\/script>/g)) {
    const src = m[1];
    if (src && /^https?:/.test(src)) continue;
    if (src && /^vendor\//.test(src)) continue; // vendored libs (maplibre) are environment, not contract
    const code = src ? fs.readFileSync(path.join(OVERLAYS, src), 'utf8') : m[2];
    vm.runInContext(code, sandbox, { filename: src || `${file}#inline` });
  }

  return { sandbox, byId, byKey, document, win: sandbox };
}

test('telemetry overlay maps live telemetry fields to the DOM', () => {
  const { byId, document, win } = loadOverlay('telemetry.html');
  const frame = {
    batteryPct: 47, usableBatteryPct: 46, rangeMi: 151, speedMph: 55, heading: 'NE', headingDeg: 45,
    cabinF: 68, outsideF: 88, battSegments: 7, warn: false, statusText: 'ALL SYSTEMS NOMINAL',
    state: 'driving', pluggedIn: false,
  };
  win.R66.dispatch('telemetry', frame); // first frame -> count-up reveal
  win.R66.dispatch('telemetry', { ...frame }); // second -> direct set (synchronous)
  assert.equal(byId.batt.textContent, '47');
  assert.equal(byId.range.textContent, '151');
  assert.equal(byId.cabin.textContent, '68');
  assert.equal(byId.outside.textContent, '88');
  assert.equal(byId.heading.textContent, 'NE');
  assert.ok(!document.body.classList.contains('warn'));

  win.R66.dispatch('telemetry', { ...frame, warn: true, statusText: 'CHARGE CRITICAL' });
  assert.ok(document.body.classList.contains('warn'));
  assert.equal(byId.statustext.textContent, 'CHARGE CRITICAL');
  assert.ok(byId.console.classList.contains('panel--warn'));
});

test('map overlay updates footer, badge, and coordinate chip', () => {
  const { byId, win } = loadOverlay('map.html');
  win.R66.dispatch('map', {
    currentLeg: 4, totalLegs: 6,
    legStatus: ['done', 'done', 'done', 'current', 'future', 'future'],
    vehicle: { lat: 32.27, lng: -110.97, onLeg: 4, progress: 0.3 },
    nextWaypoint: { name: 'EL PASO, TX', tag: '' },
    distToNextMi: 123, etaText: '2:05', standby: { active: false, node: 'MCP' },
  });
  assert.equal(byId.curleg.textContent, '04');
  assert.equal(byId.dist.textContent, '123');
  assert.equal(byId.eta.textContent, '2:05');
  assert.ok(byId.nextwp.innerHTML.includes('EL PASO'));
  assert.equal(byId.plantext.textContent, 'FLIGHT PLAN ACTIVE');

  win.R66.dispatch('telemetry', { lat: 32.2705, lng: -110.9743, headingDeg: 118, heading: 'ESE' });
  assert.ok(byId.coords.textContent.includes('32.27050°N'));
  assert.ok(byId.coords.textContent.includes('110.97430°W'));
  assert.equal(byId.hdg.textContent, 'HDG 118° ESE');

  // Maricopa standby week flips the flight-plan badge
  win.R66.dispatch('map', {
    currentLeg: 4, totalLegs: 6,
    legStatus: ['done', 'done', 'done', 'current', 'future', 'future'],
    vehicle: { lat: 33.07, lng: -112.02, onLeg: 4, progress: 0 },
    nextWaypoint: { name: 'EL PASO, TX', tag: '' },
    distToNextMi: 443, etaText: '--:--', standby: { active: true, node: 'MCP' },
  });
  assert.equal(byId.plantext.textContent, 'STANDBY · MARICOPA, AZ');
});

test('logbook overlay maps both pages of counters + punchrow', () => {
  const { byKey, byId, win } = loadOverlay('logbook.html');
  win.R66.dispatch('logbook', {
    states: 6, superchargers: 12, miles: 2500, stationsBypassed: 86, elevationFt: 9000,
    legsDone: 4, totalLegs: 6,
    routePct: 71, waypoints: 44, totalWaypoints: 58, days: 11,
    kwhCharged: 540, gasSaved: 320, driveHrs: 38.4, chargeHrs: 5.2,
  });
  // PG 1 · THE TRIP
  assert.equal(byKey.miles.dataset.to, 2500);
  assert.equal(byKey.routePct.dataset.to, 71);
  assert.equal(byKey.waypoints.dataset.to, 44);
  assert.equal(byKey.states.dataset.to, 6);
  assert.equal(byKey.days.dataset.to, 11);
  assert.equal(byId.wptotal.textContent, '/58');
  // PG 2 · POWERTRAIN
  assert.equal(byKey.kwhCharged.dataset.to, 540);
  assert.equal(byKey.superchargers.dataset.to, 12);
  assert.equal(byKey.gasSaved.dataset.to, 320);
  assert.equal(byKey.driveHrs.dataset.to, 38.4);
  assert.equal(byKey.chargeHrs.dataset.to, 5.2);
  // rotation starts on page 1
  assert.ok(byId.page1.classList.contains('active'));
  assert.ok(!byId.page2.classList.contains('active'));
  assert.ok(byId.pagesub.textContent.includes('THE TRIP'));
  // punchrow
  assert.equal(byId.punch.children.length, 6);
  assert.ok(byId.punch.children[3].classList.contains('filled'));
  assert.ok(!byId.punch.children[4].classList.contains('filled'));
});

test('logbook ?page=2 pins the POWERTRAIN page', () => {
  const { byId } = loadOverlay('logbook.html', { search: '?page=2' });
  assert.ok(byId.page2.classList.contains('active'));
  assert.ok(!byId.page1.classList.contains('active'));
  assert.ok(byId.pagesub.textContent.includes('POWERTRAIN'));
});

test('transmission overlay populates the card from a geofence event', () => {
  const { byId, document, win } = loadOverlay('transmission.html');
  assert.ok(document.body.classList.contains('idle')); // starts hidden
  win.R66.dispatch('transmission', {
    id: 'sc_tulsa', sig: 'POWER CYCLE', place: 'TULSA, OK', body: 'Topping up in Tulsa.',
    latText: '36.1037°N', lngText: '95.9121°W', legLabel: 'LEG 01 · TULSA OK',
    timeText: '06·03 · 14:22 CDT', signal: 5,
  });
  assert.equal(byId.sig.textContent, 'POWER CYCLE');
  assert.equal(byId.place.textContent, '— TULSA, OK');
  assert.ok(byId.coordmeta.textContent.includes('36.1037°N'));
  assert.ok(byId.legmeta.innerHTML.includes('<b>01</b>'));
  assert.ok(!document.body.classList.contains('idle')); // un-hidden on receive

  win.R66.dispatch('transmission:clear', { id: 'sc_tulsa' });
  assert.ok(document.body.classList.contains('idle'));
});

test('alerts overlay shows a live alert with the right glyph', () => {
  const { byId, document, win } = loadOverlay('alerts.html');
  win.R66.dispatch('alert', {
    kind: 'sub', kicker: 'TRANSMISSION LOCKED · SUBSCRIBER', name: '@route_runner',
    detail: '<b>12</b> MONTHS · TIER <b>2</b>',
  });
  assert.equal(byId.name.textContent, '@route_runner');
  assert.ok(byId.detail.innerHTML.includes('<b>12</b>'));
  assert.ok(byId.sym.innerHTML.includes('sym-fill')); // sub = filled diamond
  assert.ok(document.body.classList.contains('show'));
});
