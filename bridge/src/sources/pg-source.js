// pg-source.js — OPTIONAL Postgres cross-check poller. The pipeline derives the logbook
// counters from MQTT + geofences (authoritative). This poller is an accuracy refinement:
// it confirms DB connectivity for /healthz and records a charge-session count from TeslaMate
// for later cross-checking. Only started when postgres is configured with a real password.

export async function startPg({ cfg, store, hub }) {
  let pgMod;
  try {
    pgMod = await import('pg');
  } catch {
    throw new Error('postgres configured but the optional "pg" package is missing — run npm install');
  }
  const { Pool } = pgMod.default || pgMod;

  const pool = new Pool({
    host: cfg.postgres.host,
    port: cfg.postgres.port,
    database: cfg.postgres.database,
    user: cfg.postgres.user,
    password: cfg.postgres.password,
    ssl: cfg.postgres.ssl ? { rejectUnauthorized: false } : false,
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  pool.on('error', (e) => { hub.setHealth({ pg: 'error' }); console.error('[r66] pg pool error:', e.message); });

  let timer = null;

  async function poll() {
    try {
      // TeslaMate's charge sessions table is `charging_processes`. Best-effort; never throws upward.
      const r = await pool.query(
        'select count(*)::int as charges from charging_processes where car_id = $1',
        [cfg.vehicle.carId],
      );
      hub.setHealth({ pg: 'ok' });
      const charges = r.rows[0] && r.rows[0].charges;
      if (charges != null) store.set({ pgChargeCount: charges }); // cross-check only; geofence count stays authoritative
    } catch (e) {
      hub.setHealth({ pg: 'down' });
      console.error('[r66] pg poll failed:', e.message);
    }
  }

  return {
    async start() {
      await poll();
      timer = setInterval(poll, (cfg.postgres.pollIntervalSec || 60) * 1000);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      pool.end().catch(() => {});
    },
  };
}
