// geofence.js — fire a transmission ONCE per landmark entry.
// Two-layer debounce:
//   inside  (in-memory) — hysteresis so we don't re-fire every tick while parked in radius
//   visited (persisted) — once-per-trip latch; survives restart + the Maricopa week, and
//                         keyed on landmark `id` (NOT place_id) so HOME still fires on return
//                         even though springfield_start/springfield_home share a place_id.

import { haversine } from './geo.js';

export function createGeofence(route, store) {
  const inside = new Set();

  return {
    // Returns the landmarks newly entered this tick (first time this trip).
    // Only the CURRENT leg's landmarks are live — a linear trip visits each leg in
    // order, and this scoping stops a coincident future landmark from firing early
    // (e.g. springfield_home shares exact coords with springfield_start).
    check(lat, lng) {
      if (lat == null || lng == null) return [];
      const fired = [];
      const visited = new Set(store.get().visited);
      const cur = route.currentLeg(visited);

      for (const lm of route.route) {
        if (lm.leg !== cur) continue;
        const within = haversine(lat, lng, lm.lat, lm.lng) <= lm.radius_m;
        const wasInside = inside.has(lm.id);

        if (within && !wasInside) {
          inside.add(lm.id);
          if (!visited.has(lm.id)) {
            store.get().visited.push(lm.id); // persist the latch (flushed by caller)
            fired.push(lm);
          }
        } else if (!within && wasInside) {
          inside.delete(lm.id); // re-arm the in-radius hysteresis on exit
        }
      }
      return fired;
    },

    // Clear in-memory radius state (used when the demo loop restarts the trip).
    reset() {
      inside.clear();
    },
  };
}
