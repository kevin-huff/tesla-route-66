// replay-source.js — DEMO engine. Drives a virtual Tesla along the REAL road geometry
// (config/route-geometry.json via road-path.js; straight landmark-to-landmark lines when
// the file is absent), emitting a normalized (metric) TelemetrySnapshot each tick — the
// SAME shape the live MQTT source emits, so the whole pipeline is source-agnostic.
//
// It lands exactly on every landmark's on-road point (so every geofence fires), follows
// real curves with true per-segment headings, dwells + charges at superchargers, dwells
// asleep at the Maricopa STANDBY node, scripts one sub-threshold battery dip on the
// high-desert climb (to exercise the klaxon), and on completing the loop emits 'loop'
// so the orchestrator can reset the trip and run it again.
//
// tickOnce() advances exactly one step and is timer-free, so tests can fast-forward a
// whole loop synchronously.

import { EventEmitter } from 'node:events';
import { buildRoadPath, loadGeometry } from '../road-path.js';

const NODE_ELEV_M = { SPR: 390, AMA: 1099, FLG: 2106, MCP: 355, ELP: 1140, GAR: 170 };
const FULL_RANGE_KM = 480; // ~298 mi at 100%
const START_ODOM_KM = 12000;
const DRAIN_PER_MI = 0.25;
const CHARGE_TARGET = 90;
const CHARGE_PER_TICK = 6;
const SCRIPT_LOW_FROM = 'continental_divide'; // force a dip on the long high-desert climb
const SCRIPT_LOW_UNTIL = 'sc_holbrook'; // ...recovered at the next Supercharger
const DWELL_TYPES = new Set(['supercharger', 'stay', 'standby', 'origin']);

export function createReplaySource({ route, store, config, roadPath }) {
  const emitter = new EventEmitter();
  const pts = route.route;
  const last = pts.length - 1;
  const demo = config.demo;
  const simSecPerTick = (demo.tickMs / 1000) * demo.timeCompression;
  const road = roadPath ||
    buildRoadPath(pts, config.paths?.routeGeometry ? loadGeometry(config.paths.routeGeometry) : null);
  const elevAt = buildElevations(route);

  let i, distM, phase, dwellTicks, batt, cumKm, headingDeg, scriptedLow;
  let chargeSessionKwh = 0; // per-supercharger-session energy, like TeslaMate's charge_energy_added
  let paused = false;
  let timer = null;

  function init() {
    const visited = new Set(store.get().visited);
    let start = pts.findIndex((lm) => !visited.has(lm.id));
    if (start < 0) start = 0; // trip complete -> fresh loop
    i = start;
    distM = road.lmDistM[i];
    batt = demo.startBatteryPct;
    cumKm = store.get().lastOdometerKm ?? START_ODOM_KM;
    headingDeg = road.posAt(distM).headingDeg;
    scriptedLow = false;
    arrive();
  }

  function arrive() {
    const lm = pts[i];
    if (lm.id === SCRIPT_LOW_FROM) scriptedLow = true;
    if (lm.id === SCRIPT_LOW_UNTIL) scriptedLow = false;
    if (DWELL_TYPES.has(lm.type)) {
      phase = 'dwell';
      dwellTicks = dwellFor(lm);
      if (lm.type === 'supercharger') chargeSessionKwh = 0; // fresh session counter
    } else {
      phase = 'drive';
    }
  }

  function dwellFor(lm) {
    if (lm.type === 'standby') {
      return Math.max(4, Math.round((demo.standbyDwellSec * 1000) / demo.tickMs));
    }
    if (lm.type === 'supercharger') return 8;
    return 4; // stay / origin
  }

  function elevNow() {
    const a = elevAt[i];
    const b = elevAt[Math.min(last, i + 1)];
    const fromM = road.lmDistM[i];
    const toM = road.lmDistM[Math.min(last, i + 1)];
    const f = toM > fromM ? (distM - fromM) / (toM - fromM) : 0;
    return a + (b - a) * f;
  }

  function timeToFullH() {
    if (batt >= CHARGE_TARGET) return 0;
    return (Math.ceil((CHARGE_TARGET - batt) / CHARGE_PER_TICK) * simSecPerTick) / 3600;
  }

  function tickOnce() {
    let speedMph = 0;
    let state = 'online';
    let pluggedIn = false;
    let chargerKw = 0;

    if (phase === 'dwell') {
      const lm = pts[i];
      if (lm.type === 'supercharger') {
        state = 'charging';
        pluggedIn = true;
        chargerKw = 150;
        if (batt < CHARGE_TARGET) chargeSessionKwh += (chargerKw * simSecPerTick) / 3600;
        batt = Math.min(CHARGE_TARGET, batt + CHARGE_PER_TICK); // gradual charge ramp
      } else if (lm.type === 'standby') {
        state = 'asleep';
        batt = Math.max(batt, CHARGE_TARGET); // charged through the Maricopa week
      } else {
        batt = Math.max(batt, CHARGE_TARGET); // stay / origin: parked overnight on shore power
      }
      if (--dwellTicks <= 0) phase = 'drive';
      emitTick(speedMph, state, pluggedIn, chargerKw);
      return;
    }

    // driving — walk the road polyline toward the next landmark's on-road point
    const targetM = road.lmDistM[Math.min(last, i + 1)];
    const stepM = demo.cruiseMph * 0.44704 * simSecPerTick; // mph -> m/s
    const movedM = Math.min(stepM, Math.max(0, targetM - distM));
    distM += movedM;
    const arrived = targetM - distM < 0.01;
    cumKm += movedM / 1000;
    speedMph = demo.cruiseMph;
    state = 'driving';
    headingDeg = road.posAt(distM).headingDeg;

    if (scriptedLow) batt = 11 + (Math.random() - 0.5); // hold ~11% -> klaxon
    else batt = Math.max(3, batt - DRAIN_PER_MI * (movedM / 1609.344));

    if (arrived) {
      if (i >= last) {
        emitTick(speedMph, state, pluggedIn, chargerKw); // final HOME tick
        emitter.emit('loop');
        if (demo.loop) init();
        else stop();
        return;
      }
      i += 1;
      distM = road.lmDistM[i]; // land exactly on the landmark's on-road point
      arrive();
    }
    emitTick(speedMph, state, pluggedIn, chargerKw);
  }

  function emitTick(speedMph, state, pluggedIn, chargerKw) {
    const { lat, lng } = road.posAt(distM);
    const elev = elevNow();
    const batteryLevel = Math.round(batt);
    emitter.emit('telemetry', {
      batteryLevel,
      usableBatteryLevel: Math.max(0, batteryLevel - 1),
      speedKmh: speedMph / 0.621371 + (speedMph > 0 ? (Math.random() - 0.5) * 3 : 0),
      lat,
      lng,
      estRangeKm: (batt / 100) * FULL_RANGE_KM,
      insideTempC: 21 + (Math.random() - 0.5) * 0.6,
      outsideTempC: outsideTempC(elev),
      odometerKm: cumKm,
      elevationM: elev,
      state,
      chargerPowerKw: chargerKw,
      pluggedIn,
      headingDeg,
      standbyHint: state === 'asleep',
      chargeEnergyAddedKwh: chargeSessionKwh,
      timeToFullChargeH: state === 'charging' ? timeToFullH() : 0,
      chargeLimitSoc: CHARGE_TARGET,
      dtSec: simSecPerTick, // compressed sim-time per tick, so drive/charge hours accrue honestly
    });
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { if (!paused) tickOnce(); }, demo.tickMs);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  init();

  return {
    on: (...a) => emitter.on(...a),
    start,
    stop,
    tickOnce,
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    seek: (leg) => {
      const leg0 = route.legByNum(leg);
      if (!leg0) return;
      const idx = pts.findIndex((lm) => lm.leg === leg);
      if (idx >= 0) { i = idx; distM = road.lmDistM[idx]; arrive(); }
    },
  };
}

function outsideTempC(elevM) {
  const t = 36 - (elevM - 300) / 120 + (Math.random() - 0.5);
  return Math.max(12, Math.min(42, t));
}

function buildElevations(route) {
  const out = [];
  const legOf = new Map();
  route.route.forEach((lm, idx) => {
    if (!legOf.has(lm.leg)) legOf.set(lm.leg, []);
    legOf.get(lm.leg).push(idx);
  });
  for (const leg of route.legs) {
    const idxs = legOf.get(leg.leg) || [];
    const from = NODE_ELEV_M[leg.from] ?? 400;
    const to = NODE_ELEV_M[leg.to] ?? 400;
    idxs.forEach((idx, k) => {
      const t = idxs.length > 1 ? k / (idxs.length - 1) : 0;
      out[idx] = from + (to - from) * t;
    });
  }
  for (let k = 0; k <= route.route.length - 1; k++) if (out[k] == null) out[k] = 400;
  return out;
}
