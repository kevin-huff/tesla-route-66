// mqtt-source.js — LIVE source. Subscribes to TeslaMate's per-field MQTT topics, keeps a
// running metric snapshot, and feeds the SAME TelemetrySnapshot shape the replay emits, so
// the pipeline is identical for demo and live. Optional Postgres poller (pg-source) runs
// alongside for cumulative cross-checks when configured.
//
// TeslaMate topics live under `teslamate/cars/<carId>/`. We map the relevant ones; values
// arrive as strings (and are retained), so a late connect immediately repopulates the snapshot.

const TOPIC_MAP = {
  battery_level: (s, v) => { s.batteryLevel = num(v); },
  usable_battery_level: (s, v) => { s.usableBatteryLevel = num(v); },
  speed: (s, v) => { s.speedKmh = num(v) || 0; },
  latitude: (s, v) => { s.lat = num(v); },
  longitude: (s, v) => { s.lng = num(v); },
  est_battery_range_km: (s, v) => { s.estRangeKm = num(v) || 0; },
  inside_temp: (s, v) => { s.insideTempC = num(v); },
  outside_temp: (s, v) => { s.outsideTempC = num(v); },
  odometer: (s, v) => { s.odometerKm = num(v); },
  elevation: (s, v) => { s.elevationM = num(v); },
  heading: (s, v) => { s.headingDeg = num(v); },
  state: (s, v) => { s.state = String(v); },
  charger_power: (s, v) => { s.chargerPowerKw = num(v) || 0; },
  plugged_in: (s, v) => { s.pluggedIn = v === 'true' || v === true; },
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function startLiveSources({ cfg, route, store, hub, onTick }) {
  let mqttMod;
  try {
    mqttMod = await import('mqtt');
  } catch {
    throw new Error('live mode needs the optional "mqtt" package — run: cd bridge && npm install');
  }
  const mqtt = mqttMod.default || mqttMod;
  const base = String(cfg.mqtt.topicBase).replace(/\/+$/, '');

  const snap = {
    batteryLevel: null, usableBatteryLevel: null, speedKmh: 0, lat: null, lng: null,
    estRangeKm: 0, insideTempC: 0, outsideTempC: 0, odometerKm: null, elevationM: null,
    state: 'online', chargerPowerKw: 0, pluggedIn: false, headingDeg: null,
  };
  let dirty = false;
  let emitTimer = null;

  const client = mqtt.connect(cfg.mqtt.url, {
    username: cfg.mqtt.username || undefined,
    password: cfg.mqtt.password || undefined,
    reconnectPeriod: cfg.mqtt.reconnectMs || 4000,
  });

  client.on('connect', () => {
    hub.setHealth({ mqtt: 'connected' });
    client.subscribe(`${base}/#`);
    console.log(`[r66] mqtt connected ${cfg.mqtt.url} (${base}/#)`);
  });
  client.on('reconnect', () => hub.setHealth({ mqtt: 'reconnecting' }));
  client.on('close', () => hub.setHealth({ mqtt: 'down' }));
  client.on('offline', () => hub.setHealth({ mqtt: 'offline' }));
  client.on('error', (e) => { hub.setHealth({ mqtt: 'error' }); console.error('[r66] mqtt error:', e.message); });
  client.on('message', (topic, payload) => {
    const key = topic.slice(base.length + 1);
    const fn = TOPIC_MAP[key];
    if (fn) { fn(snap, payload.toString()); dirty = true; }
  });

  // optional Postgres cross-check poller (skipped unless configured with a real password)
  let pg = null;
  if (cfg.postgres && cfg.postgres.password && cfg.postgres.password !== 'CHANGE_ME') {
    try {
      const { startPg } = await import('./pg-source.js');
      pg = await startPg({ cfg, store, hub });
    } catch (e) {
      console.error('[r66] postgres disabled:', e.message);
    }
  }

  return {
    start() {
      // throttle to ~2 Hz; only emit once we have a position + battery
      emitTimer = setInterval(() => {
        if (dirty && snap.lat != null && snap.batteryLevel != null) {
          dirty = false;
          onTick({ ...snap });
        }
      }, 500);
      if (pg && pg.start) pg.start();
    },
    stop() {
      if (emitTimer) clearInterval(emitTimer);
      try { client.end(true); } catch {}
      if (pg && pg.stop) pg.stop();
    },
  };
}
