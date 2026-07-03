# The Kevin Show — Ride Shift Tracker: Developer Brief

## Objective
Replace the Streamerbot-resident ride tracking system with a server-side ride tracker module in the existing homelab bridge service, plus a new overlay suite (rotating map + shift console) and a phone PWA control dashboard. Streamerbot is demoted from state machine to a thin I/O layer for Twitch chat.

## Context: what exists
- **TeslaMate** on Unraid (Docker): MQTT live telemetry (position, speed, state, odometer, temps) and PostgreSQL history (`positions`, `drives`, `charges`).
- **Bridge service** (planned/being built for the Route 66 overlay project): Node service on Unraid subscribing to TeslaMate MQTT, exposing WebSocket + REST to OBS browser-source overlays, with geofence logic and Streamerbot event integration. THIS PROJECT EXTENDS THAT SERVICE with a ride-tracker module. Shared infrastructure, shared WebSocket hub, separate overlay pages and separate CSS token file (different design system, see design brief).
- **Streamerbot** on the streaming PC. Current RideTracker actions (Add tip, Start/End Ride, Start/End Shift, Reset Ride Data, Ride Stats, idle/ride/shift timer updates) hold all state in Streamerbot globals today.
- **Current month totals live in Streamerbot globals** and must be migrated (see Migration).

## Target workflow (unchanged for the human, new plumbing)
1. `!start_shift` (chat) or Start Shift (PWA) → bridge opens a shift record, shift timer runs server-side, idle timer starts.
2. `!start_ride` or PWA button → bridge opens a ride record, snapshots current GPS as pickup point, idle interval closes and accrues.
3. Drive, drop off. `!end_ride 14.75` or PWA (button + keypad) → bridge closes ride with earnings, snapshots GPS as dropoff, computes ride duration, reopens idle timer, pushes a stats summary event.
4. Streamerbot receives the summary event and posts the chat line (ride stats, day so far, month so far).
5. `!add_tip 5` or PWA → tip attributed to a specific ride (PWA shows today's ride list to pick from; the chat command defaults to the most recently completed ride).
6. `!end_shift` or PWA → closes shift, emits end-of-shift summary for the overlay recap card.

## Architecture

### Ride tracker module (in the bridge, Unraid)
- Owns all state: shifts, rides, tips, idle intervals, timers. Timers are derived from stored timestamps, not in-memory counters, so a bridge restart loses nothing.
- Subscribes to TeslaMate MQTT it already consumes: position for ride pickup/dropoff snapshots and live map, `state` for sanity checks (e.g. warn if `!start_ride` arrives while the car is asleep).
- Persists to PostgreSQL. Use a dedicated schema/database alongside TeslaMate's (same Postgres instance is fine; do not write into TeslaMate's tables).

### Schema (starting point)
- `shifts` (id, started_at, ended_at, notes)
- `rides` (id, shift_id, started_at, ended_at, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, earnings, source enum chat|pwa)
- `tips` (id, ride_id nullable, shift_id, amount, created_at) — ride_id nullable covers day-level tips for backward compatibility
- `idle_intervals` (id, shift_id, started_at, ended_at) — or derive idle purely as shift time minus ride time; storing intervals is preferred since it enables "idle location" analysis for the personal heat view
- `monthly_seed` (month, earnings, rides, shift_seconds) — one-time migration seed values (see Migration)

### API and events
- REST: `POST /shift/start`, `POST /shift/end`, `POST /ride/start`, `POST /ride/end {earnings}`, `POST /tip {amount, ride_id?}`, `GET /stats/today`, `GET /stats/month`, `GET /rides/today`, `GET /map/route/today`, `GET /map/heat`, plus auth (single shared token is acceptable; LAN + Tailscale-style access assumed, dev to confirm exposure model for the PWA when off-LAN — the phone in the car is NOT on the home LAN, so the PWA path must work remotely: reverse proxy with auth, Tailscale, or Cloudflare Tunnel; pick one and document it).
- WebSocket events (single hub shared with Route 66 module): `shift_started`, `ride_started`, `ride_ended {stats}`, `tip_added`, `shift_ended {summary}`, `stats_tick` (periodic), `map_mode {nav|route|heat}`.

### Streamerbot slimdown
Streamerbot keeps:
- Chat command triggers that call the bridge REST endpoints (`!start_shift`, `!start_ride`, `!end_ride x.xx`, `!add_tip x.xx`, `!end_shift`, `!ride_stats`)
- One WebSocket subscription that turns `ride_ended` / `shift_ended` / `stats_tick` payloads into chat messages
Streamerbot deletes:
- All timer update actions (Update Idle Time, Update Ride Timer, Update Shift Timer), Reset Ride Data, and all stat-holding globals. Timers render in the overlay from bridge state; chat stats come from bridge payloads.

### Overlay suite (OBS browser sources)
New pages, new CSS token file per the Night Drive design brief. Components:
1. **Map module** with three rotating contexts:
   - NAV: live position/heading/speed from MQTT via WebSocket.
   - ROUTE: today's path. Source from TeslaMate `positions` for the current shift window, segmented into ride vs non-ride spans by joining against `rides` timestamps. Accent color for ride segments, muted for deadhead.
   - HEAT: all-time pickup-density layer from `rides.pickup_lat/lng`. Precompute server-side (grid-bin or hexbin aggregation endpoint) rather than shipping raw points to the browser.
   - Rotation: overlay-side timer crossfade; also honor `map_mode` WebSocket events so Streamerbot/chat/PWA can force a view.
   - Basemap: dark-styled tiles (MapLibre GL with a dark style is the recommended default; Mapbox GL acceptable if a key is preferred). Must render acceptably in OBS's embedded Chromium.
2. **Shift console**: live timers (ride/shift/idle), speed, temp; totals tier (day earnings/rides/ride-vs-idle, month earnings/rides/hours). All values pushed via WebSocket; timers tick locally between `stats_tick` events using server timestamps to avoid drift.
3. **Ride ticker**: last 2-3 completed rides.
4. **End-of-shift summary card**: triggered by `shift_ended`.

### Privacy geofence
- Configurable home zone (center + radius) in bridge config. Enforced server-side: any position, path point, or ride endpoint inside the zone is dropped or clamped to the zone boundary BEFORE it reaches any overlay-facing endpoint or event. The overlay never receives raw in-zone coordinates.
- Ride pickup/dropoff points outside the zone are intentionally NOT fuzzed (owner decision: locations are already public by nature of the stream). Do not show reverse-geocoded street addresses anywhere on stream; coordinates render only as map geometry.
- The PWA (private surface) may show unfiltered data including in-zone points.

### PWA dashboard (phone)
- Installable PWA served by the bridge. Touch-first, dark, per design brief.
- Functions: start/end shift, start/end ride, earnings keypad, tip entry with attribution to any of today's rides, today's ride list, live day/month stats, map-mode override, and a "resend chat summary" action.
- Must be resilient to flaky cellular: optimistic UI with retry queue for POSTs, and idempotency keys so a double-tap or retry can't double-log a ride.

### Heat map details
- "Hunt" view (stream-facing): all-time pickup density. Server endpoint returns binned intensities; overlay renders as soft density layer.
- Personal analytics view (PWA-facing, not on stream): filterable ride-density and idle-location analysis — by month, day-of-week, hour-of-day bucket — answering "where am I when I get the most rides." Same binning endpoint with filter params (`?from&to&dow&hour`).
- All-time history starts at cutover. TeslaMate has full historical drives but no ride/no-ride labeling. OPEN ITEM for the owner: either accept accumulation from day one, or do a one-time rough backfill (e.g. mark historical drives during typical Uber hours as rides) — the latter pollutes the data and is not recommended, but the schema should not preclude a manual import.

## Migration
- One-time: read current month totals out of Streamerbot globals and write to `monthly_seed` so month stats are continuous at cutover. Month stats = seed + sum of tracked rides for that month; seed is zero for all subsequent months.
- Run old and new in parallel for a shift or two if desired; the chat output format should match the current bot's closely enough that viewers see no regression.

## Work breakdown
- **Phase 0:** schema + module skeleton in the bridge; REST endpoints; WebSocket events; migration seed.
- **Phase 1:** Streamerbot rewire (commands → REST; chat lines ← events); delete legacy actions; parity test against old workflow.
- **Phase 2:** shift console + ride ticker overlays on the new token file.
- **Phase 3:** map module — NAV, then ROUTE (positions join + segmentation), then HEAT (binning endpoint + render); rotation + `map_mode` control; privacy geofence enforcement and tests (assert no in-zone coordinate ever appears in any overlay-facing payload).
- **Phase 4:** PWA dashboard incl. remote access path, retry queue, idempotency.
- **Phase 5:** end-of-shift summary card; personal analytics filters; polish, reconnect handling, demo/replay mode with canned data.

## Acceptance criteria
- A full shift can be run entirely from the PWA with Streamerbot offline; chat lines resume when it reconnects (events since disconnect may be skipped, that's fine — but stats must be correct).
- Bridge restart mid-ride loses no state; timers resume correctly from timestamps.
- `!end_ride 12.50` produces a chat stats line within ~2s.
- ROUTE view visibly distinguishes ride vs deadhead segments; no path data renders inside the home geofence on any stream-facing surface.
- HEAT view renders from binned data (no raw point dump to the browser).
- Double-submitting a ride action (retry, double-tap) cannot create duplicate records.
- Month totals at cutover match the old Streamerbot numbers to the cent.

## Open items (owner input during build)
- Remote access mechanism for the PWA (Tailscale vs tunnel vs authed reverse proxy).
- Historical backfill decision (recommend: no backfill, accumulate from cutover).
- Exact chat message formats to preserve (copy current bot output verbatim as the starting spec).
- Heat binning resolution (start ~250m hex/grid at city zoom; tune visually).
