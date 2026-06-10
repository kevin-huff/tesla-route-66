// pipeline.js — the source-agnostic processing chain.
// One TelemetrySnapshot in -> normalize, geofence, leg state, logbook, edge events ->
// mutate `state` -> broadcast every WS message type through `hub`. Factored out of the
// boot path so tests can drive it with a mock hub and a timer-free source.

import { splitHeader } from './legs.js';
import { createGeofence } from './geofence.js';
import { deriveLogbook } from './logbook.js';
import { haversine } from './geo.js';
import { kmToMi, kmhToMph, cToF, mToFt, degToCompass, round, clamp } from './units.js';
import { pad2, fmtLat, fmtLng, fmtTime } from './format.js';

// breadcrumb thinning: a point every ~300 m, capped (~466 mi of tail) — enough for the
// map overlay to repaint the driven path after an OBS refresh without bloating state.json
const TRAIL_MIN_M = 300;
const TRAIL_MAX_POINTS = 2500;

export function createPipeline({ cfg, route, store, state, hub }) {
  const geofence = createGeofence(route, store);
  // whether geofence entries feed the Transmission Card. "llm" hands the card to the LLM
  // generator instead (geofences still drive legs/logbook/events). Default keeps old behavior.
  const emitGeoTx = (cfg.transmissions?.source ?? 'geofence') !== 'llm';
  let lastLogbookStr = '';
  let lastHeadingDeg = 0;
  let lastTickWallMs = null;
  let chargeSessionKwh = 0; // running charge_energy_added; committed to the store at unplug

  function buildTransmission(lm) {
    const { sig, place } = splitHeader(lm.header, lm.name);
    return {
      id: lm.id, sig, place, header: lm.header, body: lm.body, type_: lm.type,
      lat: lm.lat, lng: lm.lng, latText: fmtLat(lm.lat), lngText: fmtLng(lm.lng),
      leg: lm.leg, legLabel: `LEG ${pad2(lm.leg)} · ${place.replace(',', '')}`,
      timeText: fmtTime(cfg.trip.timezone), signal: 5, radiusM: lm.radius_m,
    };
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

  // Broadcast a fully-formed transmission and schedule its return to idle. Shared by the
  // geofence path and the LLM generator (via the returned handle).
  function emitTransmission(tx) {
    state.lastTransmission = tx;
    store.get().lastTransmission = tx;
    hub.broadcast('transmission', tx);
    // the overlay owns auto-hide timing (transmissionDwellMs) so it works on reconnect too
  }

  function onLandmarkEnter(lm) {
    hub.broadcast('event:landmarkEntered', {
      id: lm.id, name: lm.name, type_: lm.type, leg: lm.leg, header: lm.header,
    });
    if (emitGeoTx) emitTransmission(buildTransmission(lm)); // suppressed when source === 'llm'

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
    t.chargeLimitPct = snap.chargeLimitSoc != null ? Math.round(snap.chargeLimitSoc) : null;
    t.timeToFullMin = snap.state === 'charging'
      ? Math.max(0, Math.round((snap.timeToFullChargeH || 0) * 60))
      : null;

    if (t.lat != null && t.lng != null) {
      const tr = s.trail || (s.trail = []); // tolerate stores written before trail existed
      const lastPt = tr[tr.length - 1];
      if (!lastPt || haversine(t.lat, t.lng, lastPt[1], lastPt[0]) >= TRAIL_MIN_M) {
        tr.push([round(t.lng, 5), round(t.lat, 5)]);
        if (tr.length > TRAIL_MAX_POINTS) tr.splice(0, tr.length - TRAIL_MAX_POINTS);
      }
    }

    // --- time + energy accounting (logbook) ---
    // dt: replay supplies compressed sim-seconds; live falls back to wall-clock,
    // capped so an MQTT gap (sleep, dead zone) can't dump an hour into a counter.
    const nowMs = Date.now();
    const dt = snap.dtSec != null
      ? snap.dtSec
      : lastTickWallMs != null ? Math.min(60, Math.max(0, (nowMs - lastTickWallMs) / 1000)) : 0;
    lastTickWallMs = nowMs;
    const charging = snap.state === 'charging' || (t.pluggedIn && t.chargerKw > 0.5);
    if (snap.state === 'driving' && t.speedMph > 0) s.driveSecs = (s.driveSecs || 0) + dt;
    if (charging) s.chargeSecs = (s.chargeSecs || 0) + dt;
    // charge_energy_added is per-session and monotonic while plugged in; commit at unplug
    if (charging || t.pluggedIn) {
      if ((snap.chargeEnergyAddedKwh || 0) > chargeSessionKwh) {
        chargeSessionKwh = snap.chargeEnergyAddedKwh;
      }
    } else if (chargeSessionKwh > 0) {
      s.kwhCharged = (s.kwhCharged || 0) + chargeSessionKwh;
      chargeSessionKwh = 0;
      store.flush(); // session totals are must-not-lose
    }

    for (const lm of geofence.check(snap.lat, snap.lng)) onLandmarkEnter(lm);

    const map = route.computeMapState({
      lat: snap.lat, lng: snap.lng, speedMph: t.speedMph, visited: s.visited,
    });
    if (snap.standbyHint) map.standby.active = true;
    Object.assign(state.map, map);
    if (map.routeDistM != null) s.routeDistM = map.routeDistM; // on-route progress for ROUTE COMPLETE %

    // range margin vs the next planned supercharger (holds last on-route position off-plan)
    const sc = route.nextSuperchargerAhead(map.routeDistM ?? s.routeDistM ?? null);
    t.nextSc = sc;
    t.marginMi = sc ? Math.round(t.rangeMi - sc.mi) : null;
    t.marginWarn = sc != null && !t.pluggedIn &&
      t.marginMi < (cfg.thresholds.scMarginWarnMi ?? 40);

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
    lastTickWallMs = null;
    chargeSessionKwh = 0;
    state.lastTransmission = null;
  }

  // resume derived state so a client connecting before the first tick sees real values
  Object.assign(state.logbook, deriveLogbook(route, store, cfg));
  state.lastTransmission = store.get().lastTransmission;

  return { processTick, onLoopReset, geofence, emitTransmission };
}
