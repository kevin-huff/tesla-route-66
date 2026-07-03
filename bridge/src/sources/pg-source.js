// pg-source.js — OPTIONAL Postgres accuracy poller. The pipeline derives most logbook
// counters from MQTT + geofences; this poller refines the two TeslaMate knows better:
//   - fastChargeStops: DC fast-charge stops since trip start (catches off-plan chargers
//     the landmark list doesn't know — Sand Springs, Joplin). Same-address sessions
//     within an hour collapse into one stop (stall moves aren't a new dock).
//   - statesSeen: 2-letter codes from the geocoded addresses of trip drives (catches
//     states crossed without hitting a landmark geofence).
// Also confirms DB connectivity for /healthz and keeps the all-time session count as a
// cross-check. Only started when postgres is configured with a real password.

const STATE_CODES = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS',
  Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA',
  Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT',
  Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND',
  Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX',
  Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV',
  Wisconsin: 'WI', Wyoming: 'WY', 'District of Columbia': 'DC',
};

// fast-charge stops since trip start: sessions with any fast_charger_present reading,
// grouped into "stops" — a new stop starts when the address changes or >60 min passes.
const FAST_STOPS_SQL = `
  WITH fast AS (
    SELECT cp.address_id, cp.start_date, cp.end_date
    FROM charging_processes cp
    WHERE cp.car_id = $1
      AND cp.start_date >= ($2::timestamptz AT TIME ZONE 'UTC')
      AND EXISTS (SELECT 1 FROM charges c
                  WHERE c.charging_process_id = cp.id AND c.fast_charger_present)
  ), ordered AS (
    SELECT *, lag(end_date)   OVER (ORDER BY start_date) AS prev_end,
              lag(address_id) OVER (ORDER BY start_date) AS prev_addr
    FROM fast
  )
  SELECT count(*)::int AS stops FROM ordered
  WHERE prev_end IS NULL OR address_id IS DISTINCT FROM prev_addr
     OR start_date - prev_end > interval '60 minutes'`;

// distinct geocoded address states touched by trip drives (TeslaMate stores full names)
const STATES_SQL = `
  SELECT DISTINCT a.state
  FROM drives d
  JOIN addresses a ON a.id = d.start_address_id OR a.id = d.end_address_id
  WHERE d.car_id = $1 AND a.state IS NOT NULL
    AND d.start_date >= ($2::timestamptz AT TIME ZONE 'UTC')`;

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
      const carId = cfg.vehicle.carId;
      const r = await pool.query(
        'select count(*)::int as charges from charging_processes where car_id = $1',
        [carId],
      );
      hub.setHealth({ pg: 'ok' });
      const patch = {};
      const charges = r.rows[0] && r.rows[0].charges;
      if (charges != null) patch.pgChargeCount = charges; // all-time cross-check

      // trip-window refinements need the trip-start timestamp the pipeline persists
      const since = store.get().tripStartedAt;
      if (since) {
        const [stops, states] = await Promise.all([
          pool.query(FAST_STOPS_SQL, [carId, since]),
          pool.query(STATES_SQL, [carId, since]),
        ]);
        const n = stops.rows[0] && stops.rows[0].stops;
        if (n != null) patch.fastChargeStops = n;
        const codes = states.rows
          .map((row) => STATE_CODES[row.state])
          .filter(Boolean);
        if (codes.length) {
          patch.statesSeen = [...new Set([...(store.get().statesSeen || []), ...codes])].sort();
        }
      }
      store.set(patch);
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
