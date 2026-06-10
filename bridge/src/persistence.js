// persistence.js — cross-day state store. ONE JSON file, atomic temp->rename.
// Must survive bridge/OBS/PC restarts AND the one-week Maricopa standby:
//   - trip-start odometer/elevation baselines (so miles/elevation are deltas)
//   - the set of visited landmark ids (so geofences don't re-fire after a restart)
//   - cumulative counters + states seen + low-battery arm flag
// flush() writes synchronously for must-not-lose events (geofence fire, leg change);
// save() debounces ~1/s for routine telemetry-driven updates.

import fs from 'node:fs';
import path from 'node:path';

export function defaultStore(totalLegs = 6) {
  return {
    version: 1,
    tripName: null,
    tripStartedAt: null,
    odometerBaselineKm: null,
    lastOdometerKm: null,
    elevationBaselineM: null,
    elevationAccumFt: 0,
    lastElevationM: null,
    visited: [], // landmark ids (once-per-trip latch)
    trail: [], // breadcrumb [lng,lat] points, thinned + capped (map overlay seed)
    statesSeen: [], // 2-letter codes
    superchargers: 0,
    legsDone: 0,
    kwhCharged: 0, // committed charge-session energy (charge_energy_added at unplug)
    driveSecs: 0, // accumulated while state=driving (sim-time in demo)
    chargeSecs: 0, // accumulated while charging
    routeDistM: 0, // last on-route distance along the loop (road-path locate)
    totalLegs,
    lowBatteryArmed: true,
    lastTransmission: null,
  };
}

export function createStore(filePath, totalLegs = 6) {
  const dir = path.dirname(filePath);
  let created = false;
  let data = load();

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { ...defaultStore(totalLegs), ...parsed };
    } catch {
      created = true;
      return defaultStore(totalLegs);
    }
  }

  function writeSync() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath); // atomic on same filesystem
    dirty = false;
  }

  let dirty = false;
  let timer = null;

  function save() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (dirty) writeSync();
    }, 1000);
    if (timer.unref) timer.unref();
  }

  return {
    wasCreated: () => created,
    get: () => data,
    set: (patch) => {
      Object.assign(data, patch);
      save();
    },
    save, // debounced
    flush: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      writeSync();
    },
    reset: () => {
      data = defaultStore(totalLegs);
      writeSync();
    },
  };
}
