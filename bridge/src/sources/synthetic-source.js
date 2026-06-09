// synthetic-source.js — a stationary "looks alive" source: the car parked at a fixed
// point with gentle jitter. Useful for quickly checking overlay rendering without route
// motion. Not the default; the replay source is. Emits the same TelemetrySnapshot shape.

import { EventEmitter } from 'node:events';

export function createSyntheticSource({ route, config }) {
  const emitter = new EventEmitter();
  const demo = config.demo;
  const here = route.landmark('sc_tulsa') || route.route[0];
  let timer = null;

  function tickOnce() {
    const batt = 72 + (Math.random() - 0.5) * 0.4;
    emitter.emit('telemetry', {
      batteryLevel: Math.round(batt),
      usableBatteryLevel: Math.round(batt) - 1,
      speedKmh: 0,
      lat: here.lat,
      lng: here.lng,
      estRangeKm: (batt / 100) * 480,
      insideTempC: 21,
      outsideTempC: 34 + (Math.random() - 0.5),
      odometerKm: 12000,
      elevationM: 240,
      state: 'online',
      chargerPowerKw: 0,
      pluggedIn: false,
      headingDeg: 247,
      standbyHint: false,
    });
  }

  return {
    on: (...a) => emitter.on(...a),
    tickOnce,
    start: () => { if (!timer) timer = setInterval(tickOnce, demo.tickMs); },
    stop: () => { if (timer) clearInterval(timer); timer = null; },
    pause: () => {},
    resume: () => {},
    seek: () => {},
  };
}
