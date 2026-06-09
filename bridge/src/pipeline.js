// pipeline.js — the source-agnostic processing chain.
// One TelemetrySnapshot in -> normalize, geofence, leg state, logbook, edge events ->
// mutate `state` -> broadcast every WS message type through `hub`. Factored out of the
// boot path so tests can drive it with a mock hub and a timer-free source.

import { splitHeader } from './legs.js';
import { createGeofence } from './geofence.js';
import { deriveLogbook } from './logbook.js';
import { haversine } from './geo.js';
import { kmToMi, kmhToMph, cToF, mToFt, degToCompass, round, clamp } from './units.js';

const pad2 = (n) => String(n).padStart(2, '0');
const fmtLat = (lat) => `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}`;
const fmtLng = (lng) => `${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`;

function fmtTime(tz) {
  const d = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
    }).formatToParts(d);
    const g = (ty) => parts.find((p) => p.type === ty)?.value || '';
    return `${g('month')}·${g('day')} · ${g('hour')}:${g('minute')} ${g('timeZoneName')}`;
  } catch {
    return d.toISOString().slice(5, 16).replace('T', ' ');
  }
}

export function createPipeline({ cfg, route, store, state, hub }) {
  const geofence = createGeofence(route, store);
  let lastLogbookStr = '';
  let lastHeadingDeg = 0;
  let txClearTimer = null;

  function buildTransmission(lm) {
    const { sig, place } = splitHeader(lm.header, lm.name);
    return {
      id: lm.id, sig, place, header: lm.header, body: lm.body, type_: lm.type,
      lat: lm.lat, lng: lm.lng, latText: fmtLat(lm.lat), lngText: fmtLng(lm.lng),
      leg: lm.leg, legLabel: `LEG ${pad2(lm.leg)} · ${place.replace(',', '')}`,
      timeText: fmtTime(cfg.trip.timezone), signal: 5, radiusM: lm.radius_m,
    };
  }

  function scheduleTxClear(id, body) {
    clearTimeout(txClearTimer);
    const typeMs = (body?.length || 120) * 22;
    txClearTimer = setTimeout(() => hub.broadcast('transmission:clear', { id }), typeMs + 8000);
    if (txClearTimer && txClearTimer.unref) txClearTimer.unref();
  }

  function nearestSupercharger(lat, lng) {
    if (lat == null) return null;
    let best = null;
    let bd = Infinity;
    for (const lm of route.route) {
      if (lm.type !== 'supercharger') continue;
      const d = haversine(lat, lng, lm.lat, lm.lng);
      if (d < bd) { bd = d; best = lm; }
    }
    return best ? { name: best.name, distMi: round(kmToMi(bd / 1000), 0) } : null;
  }

  function onLandmarkEnter(lm) {
    const tx = buildTransmission(lm);
    state.lastTransmission = tx;
    store.get().lastTransmission = tx;
    hub.broadcast('transmission', tx);
    hub.broadcast('event:landmarkEntered', {
      id: lm.id, name: lm.name, type_: lm.type, leg: lm.leg, header: lm.header,
    });
    scheduleTxClear(lm.id, tx.body);

    const leg = route.legs.find((l) => l.end_landmark_id === lm.id);
    if (leg) {
      const visited = new Set(store.get().visited);
      const done = route.legs.filter((l) => visited.has(l.end_landmark_id)).length;
      store.get().legsDone = done;
      const next = route.legByNum(leg.leg + 1);
      hub.broadcast('event:legComplete', {
        leg: leg.leg, title: leg.title, nextLeg: next ? leg.leg + 1 : null,
        isStandby: !!leg.standby, legsDone: done, totalLegs: route.totalLegs,
      });
    }
    store.flush(); // must-not-lose
  }

  function checkLowBattery(t, snap) {
    const s = store.get();
    const thr = cfg.thresholds;
    if (t.warn && s.lowBatteryArmed) {
      hub.broadcast('event:lowBattery', {
        batteryPct: t.batteryPct, usableBatteryPct: t.usableBatteryPct, rangeMi: t.rangeMi,
        severity: t.usableBatteryPct <= thr.criticalBatteryPct ? 'critical' : 'warn',
        threshold: thr.lowBatteryPct, nearestSupercharger: nearestSupercharger(snap.lat, snap.lng),
      });
      s.lowBatteryArmed = false;
      store.flush();
    } else if (!t.warn && !s.lowBatteryArmed &&
               t.usableBatteryPct >= thr.lowBatteryPct + thr.lowBatteryRearmPct) {
      s.lowBatteryArmed = true; // hysteresis re-arm
    }
  }

  function processTick(snap) {
    const s = store.get();

    if (snap.odometerKm != null) {
      if (s.odometerBaselineKm == null) s.odometerBaselineKm = snap.odometerKm;
      s.lastOdometerKm = snap.odometerKm;
    }
    if (snap.elevationM != null) {
      if (s.elevationBaselineM == null) s.elevationBaselineM = snap.elevationM;
      if (s.lastElevationM != null && snap.elevationM > s.lastElevationM) {
        s.elevationAccumFt += mToFt(snap.elevationM - s.lastElevationM);
      }
      s.lastElevationM = snap.elevationM;
    }
    if (s.tripStartedAt == null) s.tripStartedAt = new Date().toISOString();
    if (s.tripName == null) s.tripName = cfg.trip.name;

    // --- telemetry normalize -> display units ---
    const t = state.telemetry;
    t.batteryPct = Math.round(snap.batteryLevel);
    t.usableBatteryPct = Math.round(snap.usableBatteryLevel ?? snap.batteryLevel);
    t.rangeMi = round(kmToMi(snap.estRangeKm));
    let mph = clamp(round(kmhToMph(snap.speedKmh)), 0, cfg.thresholds.speedMaxPlausibleMph);
    if (snap.state !== 'driving') mph = 0;
    t.speedMph = mph;
    const hdg = snap.headingDeg != null ? snap.headingDeg : lastHeadingDeg;
    if (snap.headingDeg != null) lastHeadingDeg = snap.headingDeg;
    t.headingDeg = round(hdg);
    t.heading = degToCompass(hdg || 0);
    t.cabinF = round(cToF(snap.insideTempC));
    t.outsideF = round(cToF(snap.outsideTempC));
    t.lat = snap.lat;
    t.lng = snap.lng;
    t.state = snap.state;
    t.pluggedIn = !!snap.pluggedIn;
    t.chargerKw = round(snap.chargerPowerKw || 0, 1);
    t.battSegments = Math.round((t.batteryPct / 100) * 14);
    t.warn = t.usableBatteryPct <= cfg.thresholds.lowBatteryPct && !t.pluggedIn;
    t.statusText = t.warn ? 'CHARGE CRITICAL' : 'ALL SYSTEMS NOMINAL';

    for (const lm of geofence.check(snap.lat, snap.lng)) onLandmarkEnter(lm);

    const map = route.computeMapState({
      lat: snap.lat, lng: snap.lng, speedMph: t.speedMph, visited: s.visited,
    });
    if (snap.standbyHint) map.standby.active = true;
    Object.assign(state.map, map);

    Object.assign(state.logbook, deriveLogbook(route, store, cfg));

    checkLowBattery(t, snap);

    hub.broadcast('telemetry', t);
    hub.broadcast('map', state.map);
    const lbStr = JSON.stringify(state.logbook);
    if (lbStr !== lastLogbookStr) {
      hub.broadcast('logbook', state.logbook);
      lastLogbookStr = lbStr;
    }

    store.save();
  }

  function onLoopReset() {
    store.reset();
    geofence.reset();
    lastLogbookStr = '';
    state.lastTransmission = null;
  }

  // resume derived state so a client connecting before the first tick sees real values
  Object.assign(state.logbook, deriveLogbook(route, store, cfg));
  state.lastTransmission = store.get().lastTransmission;

  return { processTick, onLoopReset, geofence };
}
