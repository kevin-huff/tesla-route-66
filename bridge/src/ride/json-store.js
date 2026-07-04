// ride/json-store.js — file-backed ride-tracker store (demo + pg-less fallback).
// Same async interface as pg-store.js so the tracker never knows which one it has.
// One JSON document, atomic temp->rename like persistence.js. All money is integer
// cents; all timestamps are ISO strings — timers are DERIVED from these, so a
// bridge restart mid-ride loses nothing.

import fs from 'node:fs';
import path from 'node:path';

const IDEMPOTENCY_CAP = 300; // most-recent keys kept (a shift is ~20 mutations)

function emptyDoc() {
  return {
    version: 1,
    seq: { shift: 0, ride: 0, tip: 0, idle: 0 },
    shifts: [],
    rides: [],
    tips: [],
    idle: [],
    paths: {}, // shiftId -> [[epochMs, lat, lng], ...]
    monthlySeed: {}, // 'YYYY-MM' -> { earningsCents, rides, shiftSeconds }
    meta: {}, // bests, mapMode, lastSummaries
    idempotency: {}, // key -> { result, at }
  };
}

export function createJsonRideStore(filePath) {
  const dir = path.dirname(filePath);
  let doc = load();

  function load() {
    try {
      return { ...emptyDoc(), ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
    } catch {
      return emptyDoc();
    }
  }

  let dirty = false;
  let timer = null;
  function writeSync() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc));
    fs.renameSync(tmp, filePath);
    dirty = false;
  }
  function save() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (dirty) writeSync();
    }, 500);
    if (timer.unref) timer.unref();
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    writeSync();
  }

  const byId = (arr, id) => arr.find((x) => x.id === id) || null;

  return {
    kind: 'json',
    async init() {},

    // ---- shifts ----
    async createShift({ startedAt, notes = null }) {
      const shift = { id: ++doc.seq.shift, startedAt, endedAt: null, notes };
      doc.shifts.push(shift);
      flush(); // lifecycle edges are must-not-lose
      return { ...shift };
    },
    async endShift(id, endedAt) {
      const s = byId(doc.shifts, id);
      if (s) { s.endedAt = endedAt; flush(); }
      return s ? { ...s } : null;
    },
    async getOpenShift() {
      const s = doc.shifts.findLast((x) => !x.endedAt);
      return s ? { ...s } : null;
    },
    async listShifts({ from, to } = {}) {
      return doc.shifts
        .filter((s) => (!from || s.startedAt >= from) && (!to || s.startedAt < to))
        .map((s) => ({ ...s }));
    },
    async updateShift(id, { startedAt, endedAt } = {}) {
      const s = byId(doc.shifts, id);
      if (!s) return null;
      if (startedAt !== undefined) s.startedAt = startedAt;
      if (endedAt !== undefined) s.endedAt = endedAt;
      flush();
      return { ...s };
    },
    // hard-delete a shift and everything it owns (test/junk shifts). Aggregates
    // recompute from the store, so month/today totals heal on the next rebuild.
    async deleteShift(id) {
      const before = {
        rides: doc.rides.length, tips: doc.tips.length, idle: doc.idle.length,
      };
      if (!byId(doc.shifts, id)) return null;
      doc.shifts = doc.shifts.filter((s) => s.id !== id);
      doc.rides = doc.rides.filter((r) => r.shiftId !== id);
      doc.tips = doc.tips.filter((t) => t.shiftId !== id);
      doc.idle = doc.idle.filter((iv) => iv.shiftId !== id);
      delete doc.paths[String(id)];
      flush();
      return {
        shiftId: id,
        rides: before.rides - doc.rides.length,
        tips: before.tips - doc.tips.length,
        idleIntervals: before.idle - doc.idle.length,
      };
    },

    // ---- rides ----
    async createRide({ shiftId, startedAt, pickup, source }) {
      const ride = {
        id: ++doc.seq.ride, shiftId, startedAt, endedAt: null,
        pickupLat: pickup?.lat ?? null, pickupLng: pickup?.lng ?? null,
        dropoffLat: null, dropoffLng: null,
        fareCents: 0, source: source === 'chat' ? 'chat' : 'pwa',
      };
      doc.rides.push(ride);
      flush();
      return { ...ride };
    },
    async endRide(id, { endedAt, dropoff, fareCents }) {
      const r = byId(doc.rides, id);
      if (!r) return null;
      r.endedAt = endedAt;
      r.dropoffLat = dropoff?.lat ?? null;
      r.dropoffLng = dropoff?.lng ?? null;
      r.fareCents = fareCents;
      flush();
      return { ...r };
    },
    async getOpenRide() {
      const r = doc.rides.findLast((x) => !x.endedAt);
      return r ? { ...r } : null;
    },
    async getRide(id) {
      const r = byId(doc.rides, id);
      return r ? { ...r } : null;
    },
    async updateRide(id, patch = {}) {
      const r = byId(doc.rides, id);
      if (!r) return null;
      for (const k of ['fareCents', 'startedAt', 'endedAt']) {
        if (patch[k] !== undefined) r[k] = patch[k];
      }
      flush();
      return { ...r };
    },
    async deleteRide(id) {
      const r = byId(doc.rides, id);
      if (!r) return null;
      const tipsBefore = doc.tips.length;
      doc.rides = doc.rides.filter((x) => x.id !== id);
      doc.tips = doc.tips.filter((t) => t.rideId !== id);
      flush();
      return { rideId: id, tips: tipsBefore - doc.tips.length };
    },
    async listRides({ from, to, shiftId } = {}) {
      return doc.rides
        .filter((r) =>
          (!from || r.startedAt >= from) && (!to || r.startedAt < to) &&
          (shiftId == null || r.shiftId === shiftId))
        .map((r) => ({ ...r }));
    },
    async listPickups() {
      return doc.rides
        .filter((r) => r.pickupLat != null)
        .map((r) => ({ lat: r.pickupLat, lng: r.pickupLng, startedAt: r.startedAt }));
    },

    // ---- tips ----
    async addTip({ rideId = null, shiftId, amountCents, createdAt }) {
      const tip = { id: ++doc.seq.tip, rideId, shiftId, amountCents, createdAt };
      doc.tips.push(tip);
      flush();
      return { ...tip };
    },
    async listTips({ from, to, shiftId } = {}) {
      return doc.tips
        .filter((t) =>
          (!from || t.createdAt >= from) && (!to || t.createdAt < to) &&
          (shiftId == null || t.shiftId === shiftId))
        .map((t) => ({ ...t }));
    },
    async deleteTip(id) {
      const t = byId(doc.tips, id);
      if (!t) return null;
      doc.tips = doc.tips.filter((x) => x.id !== id);
      flush();
      return { ...t };
    },

    // ---- idle intervals ----
    async openIdle({ shiftId, startedAt }) {
      const iv = { id: ++doc.seq.idle, shiftId, startedAt, endedAt: null };
      doc.idle.push(iv);
      save();
      return { ...iv };
    },
    async closeIdle(endedAt) {
      const iv = doc.idle.findLast((x) => !x.endedAt);
      if (iv) { iv.endedAt = endedAt; save(); }
      return iv ? { ...iv } : null;
    },
    async listIdle({ shiftId } = {}) {
      return doc.idle
        .filter((iv) => shiftId == null || iv.shiftId === shiftId)
        .map((iv) => ({ ...iv }));
    },

    // ---- shift path (for the ROUTE view; thinning is the tracker's job) ----
    async appendPath(shiftId, pt, maxPoints = 4000) {
      const key = String(shiftId);
      const arr = doc.paths[key] || (doc.paths[key] = []);
      arr.push(pt);
      if (arr.length > maxPoints) arr.splice(0, arr.length - maxPoints);
      // keep only the last few shifts' paths so the file can't grow unbounded
      const keys = Object.keys(doc.paths);
      if (keys.length > 4) {
        for (const k of keys.sort((a, b) => Number(a) - Number(b)).slice(0, keys.length - 4)) {
          delete doc.paths[k];
        }
      }
      save();
    },
    async getPath(shiftId) {
      return (doc.paths[String(shiftId)] || []).slice();
    },

    // ---- monthly seed (Streamerbot migration) ----
    async getMonthlySeed(month) {
      return doc.monthlySeed[month] ? { month, ...doc.monthlySeed[month] } : null;
    },
    async setMonthlySeed({ month, earningsCents = 0, rides = 0, shiftSeconds = 0 }) {
      doc.monthlySeed[month] = { earningsCents, rides, shiftSeconds };
      flush();
    },

    // ---- meta (bests, map mode, last summaries) ----
    async getMeta(key) {
      return doc.meta[key] ?? null;
    },
    async setMeta(key, value) {
      doc.meta[key] = value;
      save();
    },

    // ---- idempotency ----
    async getIdempotent(key) {
      return doc.idempotency[key]?.result ?? null;
    },
    async putIdempotent(key, result) {
      doc.idempotency[key] = { result, at: Date.now() };
      const keys = Object.keys(doc.idempotency);
      if (keys.length > IDEMPOTENCY_CAP) {
        keys
          .sort((a, b) => doc.idempotency[a].at - doc.idempotency[b].at)
          .slice(0, keys.length - IDEMPOTENCY_CAP)
          .forEach((k) => delete doc.idempotency[k]);
      }
      save();
    },

    flush,
    close: () => flush(),
    _reset: () => { doc = emptyDoc(); flush(); }, // demo loop + tests
  };
}
