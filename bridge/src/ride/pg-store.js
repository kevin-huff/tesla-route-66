// ride/pg-store.js — Postgres ride-tracker store for live mode. Lives in its OWN
// schema (default "ride_tracker") on the same instance as TeslaMate; never touches
// TeslaMate's tables. Interface-identical to json-store.js. DDL is bootstrapped at
// init() so a fresh database works with zero manual setup.

const DDL = (S) => `
  CREATE SCHEMA IF NOT EXISTS ${S};
  CREATE TABLE IF NOT EXISTS ${S}.shifts (
    id          serial PRIMARY KEY,
    started_at  timestamptz NOT NULL,
    ended_at    timestamptz,
    notes       text
  );
  CREATE TABLE IF NOT EXISTS ${S}.rides (
    id          serial PRIMARY KEY,
    shift_id    integer NOT NULL REFERENCES ${S}.shifts(id),
    started_at  timestamptz NOT NULL,
    ended_at    timestamptz,
    pickup_lat  double precision,
    pickup_lng  double precision,
    dropoff_lat double precision,
    dropoff_lng double precision,
    fare_cents  integer NOT NULL DEFAULT 0,
    source      text NOT NULL DEFAULT 'pwa' CHECK (source IN ('chat','pwa','import'))
  );
  CREATE INDEX IF NOT EXISTS rides_started_idx ON ${S}.rides (started_at);
  CREATE TABLE IF NOT EXISTS ${S}.tips (
    id           serial PRIMARY KEY,
    ride_id      integer REFERENCES ${S}.rides(id),
    shift_id     integer NOT NULL REFERENCES ${S}.shifts(id),
    amount_cents integer NOT NULL,
    created_at   timestamptz NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ${S}.idle_intervals (
    id          serial PRIMARY KEY,
    shift_id    integer NOT NULL REFERENCES ${S}.shifts(id),
    started_at  timestamptz NOT NULL,
    ended_at    timestamptz
  );
  CREATE TABLE IF NOT EXISTS ${S}.shift_path (
    shift_id    integer NOT NULL REFERENCES ${S}.shifts(id),
    t           bigint NOT NULL,
    lat         double precision NOT NULL,
    lng         double precision NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shift_path_idx ON ${S}.shift_path (shift_id, t);
  CREATE TABLE IF NOT EXISTS ${S}.monthly_seed (
    month          text PRIMARY KEY,
    earnings_cents integer NOT NULL DEFAULT 0,
    rides          integer NOT NULL DEFAULT 0,
    shift_seconds  integer NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS ${S}.meta (
    key   text PRIMARY KEY,
    value jsonb
  );
  CREATE TABLE IF NOT EXISTS ${S}.idempotency (
    key        text PRIMARY KEY,
    result     jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

const iso = (v) => (v == null ? null : new Date(v).toISOString());
const shiftRow = (r) => r && ({
  id: r.id, startedAt: iso(r.started_at), endedAt: iso(r.ended_at), notes: r.notes,
});
const rideRow = (r) => r && ({
  id: r.id, shiftId: r.shift_id, startedAt: iso(r.started_at), endedAt: iso(r.ended_at),
  pickupLat: r.pickup_lat, pickupLng: r.pickup_lng,
  dropoffLat: r.dropoff_lat, dropoffLng: r.dropoff_lng,
  fareCents: r.fare_cents, source: r.source,
});
const tipRow = (r) => r && ({
  id: r.id, rideId: r.ride_id, shiftId: r.shift_id,
  amountCents: r.amount_cents, createdAt: iso(r.created_at),
});
const idleRow = (r) => r && ({
  id: r.id, shiftId: r.shift_id, startedAt: iso(r.started_at), endedAt: iso(r.ended_at),
});

export async function createPgRideStore({ postgres, schema = 'ride_tracker' }) {
  const { default: pg } = await import('pg');
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`bad ride pgSchema "${schema}"`);
  const pool = new pg.Pool({
    host: postgres.host, port: postgres.port, database: postgres.database,
    user: postgres.user, password: postgres.password,
    ssl: postgres.ssl ? { rejectUnauthorized: false } : false,
    max: 4,
  });
  const S = schema;
  const q = (text, params) => pool.query(text, params);

  return {
    kind: 'pg',
    async init() {
      await q(DDL(S));
    },

    async createShift({ startedAt, notes = null }) {
      const r = await q(
        `INSERT INTO ${S}.shifts (started_at, notes) VALUES ($1,$2) RETURNING *`,
        [startedAt, notes],
      );
      return shiftRow(r.rows[0]);
    },
    async endShift(id, endedAt) {
      const r = await q(`UPDATE ${S}.shifts SET ended_at=$2 WHERE id=$1 RETURNING *`, [id, endedAt]);
      return shiftRow(r.rows[0]);
    },
    async getOpenShift() {
      const r = await q(`SELECT * FROM ${S}.shifts WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`);
      return shiftRow(r.rows[0]);
    },
    async listShifts({ from, to } = {}) {
      const r = await q(
        `SELECT * FROM ${S}.shifts
          WHERE ($1::timestamptz IS NULL OR started_at >= $1)
            AND ($2::timestamptz IS NULL OR started_at < $2) ORDER BY id`,
        [from ?? null, to ?? null],
      );
      return r.rows.map(shiftRow);
    },

    async createRide({ shiftId, startedAt, pickup, source }) {
      const r = await q(
        `INSERT INTO ${S}.rides (shift_id, started_at, pickup_lat, pickup_lng, source)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [shiftId, startedAt, pickup?.lat ?? null, pickup?.lng ?? null, source === 'chat' ? 'chat' : 'pwa'],
      );
      return rideRow(r.rows[0]);
    },
    async endRide(id, { endedAt, dropoff, fareCents }) {
      const r = await q(
        `UPDATE ${S}.rides SET ended_at=$2, dropoff_lat=$3, dropoff_lng=$4, fare_cents=$5
          WHERE id=$1 RETURNING *`,
        [id, endedAt, dropoff?.lat ?? null, dropoff?.lng ?? null, fareCents],
      );
      return rideRow(r.rows[0]);
    },
    async getOpenRide() {
      const r = await q(`SELECT * FROM ${S}.rides WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`);
      return rideRow(r.rows[0]);
    },
    async getRide(id) {
      const r = await q(`SELECT * FROM ${S}.rides WHERE id=$1`, [id]);
      return rideRow(r.rows[0]);
    },
    async listRides({ from, to, shiftId } = {}) {
      const r = await q(
        `SELECT * FROM ${S}.rides
          WHERE ($1::timestamptz IS NULL OR started_at >= $1)
            AND ($2::timestamptz IS NULL OR started_at < $2)
            AND ($3::integer IS NULL OR shift_id = $3) ORDER BY id`,
        [from ?? null, to ?? null, shiftId ?? null],
      );
      return r.rows.map(rideRow);
    },
    async listPickups() {
      const r = await q(
        `SELECT pickup_lat, pickup_lng, started_at FROM ${S}.rides WHERE pickup_lat IS NOT NULL`,
      );
      return r.rows.map((x) => ({ lat: x.pickup_lat, lng: x.pickup_lng, startedAt: iso(x.started_at) }));
    },

    async addTip({ rideId = null, shiftId, amountCents, createdAt }) {
      const r = await q(
        `INSERT INTO ${S}.tips (ride_id, shift_id, amount_cents, created_at)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [rideId, shiftId, amountCents, createdAt],
      );
      return tipRow(r.rows[0]);
    },
    async listTips({ from, to, shiftId } = {}) {
      const r = await q(
        `SELECT * FROM ${S}.tips
          WHERE ($1::timestamptz IS NULL OR created_at >= $1)
            AND ($2::timestamptz IS NULL OR created_at < $2)
            AND ($3::integer IS NULL OR shift_id = $3) ORDER BY id`,
        [from ?? null, to ?? null, shiftId ?? null],
      );
      return r.rows.map(tipRow);
    },

    async openIdle({ shiftId, startedAt }) {
      const r = await q(
        `INSERT INTO ${S}.idle_intervals (shift_id, started_at) VALUES ($1,$2) RETURNING *`,
        [shiftId, startedAt],
      );
      return idleRow(r.rows[0]);
    },
    async closeIdle(endedAt) {
      const r = await q(
        `UPDATE ${S}.idle_intervals SET ended_at=$1
          WHERE id = (SELECT id FROM ${S}.idle_intervals WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1)
          RETURNING *`,
        [endedAt],
      );
      return idleRow(r.rows[0]);
    },
    async listIdle({ shiftId } = {}) {
      const r = await q(
        `SELECT * FROM ${S}.idle_intervals WHERE ($1::integer IS NULL OR shift_id=$1) ORDER BY id`,
        [shiftId ?? null],
      );
      return r.rows.map(idleRow);
    },

    async appendPath(shiftId, pt) {
      await q(`INSERT INTO ${S}.shift_path (shift_id, t, lat, lng) VALUES ($1,$2,$3,$4)`, [
        shiftId, pt[0], pt[1], pt[2],
      ]);
    },
    async getPath(shiftId) {
      const r = await q(`SELECT t, lat, lng FROM ${S}.shift_path WHERE shift_id=$1 ORDER BY t`, [shiftId]);
      return r.rows.map((x) => [Number(x.t), x.lat, x.lng]);
    },

    async getMonthlySeed(month) {
      const r = await q(`SELECT * FROM ${S}.monthly_seed WHERE month=$1`, [month]);
      const x = r.rows[0];
      return x
        ? { month: x.month, earningsCents: x.earnings_cents, rides: x.rides, shiftSeconds: x.shift_seconds }
        : null;
    },
    async setMonthlySeed({ month, earningsCents = 0, rides = 0, shiftSeconds = 0 }) {
      await q(
        `INSERT INTO ${S}.monthly_seed (month, earnings_cents, rides, shift_seconds)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (month) DO UPDATE
           SET earnings_cents=$2, rides=$3, shift_seconds=$4`,
        [month, earningsCents, rides, shiftSeconds],
      );
    },

    async getMeta(key) {
      const r = await q(`SELECT value FROM ${S}.meta WHERE key=$1`, [key]);
      return r.rows[0]?.value ?? null;
    },
    async setMeta(key, value) {
      await q(
        `INSERT INTO ${S}.meta (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value=$2`,
        [key, JSON.stringify(value)],
      );
    },

    async getIdempotent(key) {
      const r = await q(`SELECT result FROM ${S}.idempotency WHERE key=$1`, [key]);
      return r.rows[0]?.result ?? null;
    },
    async putIdempotent(key, result) {
      await q(
        `INSERT INTO ${S}.idempotency (key, result) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`,
        [key, JSON.stringify(result)],
      );
      // opportunistic sweep so the table can't grow unbounded
      await q(`DELETE FROM ${S}.idempotency WHERE created_at < now() - interval '14 days'`);
    },

    flush: () => {},
    close: () => pool.end(),
  };
}
