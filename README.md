# The Kevin Show — Route 66 Overlay System

OBS stream overlays that render **live Tesla telemetry** from a local [TeslaMate](https://github.com/teslamate-org/teslamate) instance, styled as an amber cyberdeck / Space-Age mission console. Built for a six-leg Route 66 road-trip series.

> **Real data, retro housing.** The camera feed stays clean and legible; all the styling lives in the panels, gauges, and nixie readouts around it.

The trip is a loop with a one-week pause in the middle:

```
Leg 1  Springfield, MO → Amarillo, TX
Leg 2  Amarillo, TX    → Flagstaff, AZ
Leg 3  Flagstaff, AZ   → Maricopa, AZ      ┐
            · · · STANDBY · 1 WEEK · · ·   │  the car parks; counters persist
Leg 4  Maricopa, AZ    → El Paso, TX       ┘
Leg 5  El Paso, TX     → Garland, TX
Leg 6  Garland, TX     → Springfield, MO   (home)
```

## How it works

An OBS browser source is a Chromium page — it can't subscribe to raw MQTT. So a small **bridge service** sits in the middle: it subscribes to TeslaMate (MQTT + Postgres), runs geofencing and cross-day persistence, and exposes one clean WebSocket + REST surface the overlays render from. The bridge is the single event hub, so Streamerbot has one place to listen too.

```
 TeslaMate                bridge/ (Node, :8787)                 overlays/ (OBS browser sources)
┌──────────┐  MQTT   ┌─────────────────────────────┐  WS    ┌────────────────────────────┐
│ battery  │────────▶│ normalize → geofence → legs  │═══════▶│ telemetry · map · logbook  │
│ speed    │         │   → logbook → events         │  REST  │ transmission · alerts      │
│ lat/lng  │ Postgres│ persistence (state.json)     │◀──────▶│ badge (static)             │
│ odometer │────────▶│ HTTP: WS + REST + static     │ /api/  │  via js/telemetry-client   │
└──────────┘         └─────────────────────────────┘        └────────────────────────────┘
                              ▲           │
                       POST /api/alert    └─ event:lowBattery / legComplete / landmarkEntered
                       (Streamerbot/Twitch)     (Streamerbot listens on the same socket)
```

**Demo-first:** the bridge ships a route-replay engine that drives a virtual Tesla through every leg and landmark, so the whole system runs and animates with **no car attached**. Point it at real TeslaMate by flipping one config value.

## Quick start (demo mode)

```bash
cd bridge
npm install
npm run demo
```

The bridge serves the overlays itself. Open the showcase at **http://localhost:8787/**, or drop the individual overlays into OBS (below). The replay loops the whole trip — charging at Superchargers, firing landmark transmissions, dipping the battery into the klaxon warning on the high-desert climb, and dwelling at the Maricopa STANDBY node.

## OBS setup

Add each overlay as a **Browser Source** (transparent background, designed on a **2560×1440** canvas; scales cleanly to 1080p). Append `?embed` to hide each overlay's dev controls.

| Source | URL | Size (W×H) | Position (left, top) |
|---|---|---|---|
| Show Badge | `/badge.html` | 620 × 540 | 40, 20 (top-left) |
| Mission Map | `/map.html` | 1140 × 760 | 1370, 30 (top-right) |
| Telemetry Console | `/telemetry.html?embed` | 1280 × 460 | 40, 700 (bottom-left) |
| Logbook Counters | `/logbook.html` | 1560 × 220 | 500, 1190 (bottom strip) |
| Transmission Card | `/transmission.html?embed` | 720 × 400 | 40, 40 (event scene) |
| Alerts / lower-third | `/alerts.html?embed` | 800 × 320 | 880, 1100 (lower-third) |

All URLs are relative to the bridge, e.g. `http://localhost:8787/telemetry.html?embed`.

**Preview params:** `?state=warn` (telemetry klaxon state) · `?idle` (transmission starts hidden) · `?demo` (force canned data) · `?live` (never fall back to demo).

## The six overlays

1. **Mission Map** — the six-leg loop as a glowing SVG flight plan; completed legs solid, current leg pulsing, Maricopa as a STANDBY node; live leg / distance / ETA.
2. **Telemetry Console** — battery %, range, speed, cabin/outside temp on 7-segment readouts. Normal amber state + a low-charge **klaxon** warning state.
3. **Transmission Card** — landmark lore as an incoming teletype with a typewriter reveal, fired once per geofence entry.
4. **Logbook Counters** — a persistent punch-card tally: states crossed, Superchargers docked, miles logged, **gas stations bypassed** (the EV flex), elevation gained.
5. **Show Badge** — "The Kevin Show" as a chrome-and-neon Route 66 shield (static).
6. **Alerts** — follow / sub / channel-point redemption lower-thirds in the same console language.

Overlays are dumb renderers: a shared `telemetry-client.js` connects to the bridge, auto-reconnects, keeps the last-known frame on a drop (no blanking), and falls back to canned demo data so any file renders standalone.

## Going live (real TeslaMate)

```bash
cd bridge
cp config.example.json config.json     # fill in broker / car_id / Postgres
# secrets can instead go in .env (copy from .env.example) — env wins over config.json
npm run live
```

Watch the boot logs — `[r66] mqtt connected …` confirms the broker, and `GET /healthz` reports `mqtt` / `pg` status. The overlays don't change between demo and live; the bridge emits the same messages either way. Units are converted to **miles / mph / °F** in the bridge (TeslaMate publishes metric).

## Configuration

`bridge/config.example.json` is the committed template (and the demo default). Key fields:

- `mode` — `demo` | `live` (override with `R66_MODE`)
- `server.port` — default `8787`
- `vehicle.carId` — TeslaMate car id (usually `1`)
- `mqtt.url` / `mqtt.topicBase` — e.g. `mqtt://teslamate.lan:1883`, `teslamate/cars/1`
- `postgres.*` — connection for the optional cumulative cross-check poller
- `thresholds.lowBatteryPct` — when the telemetry console flips to the klaxon state
- `trip.landmarksPath` / `trip.legsPath` — geofence + route data (default: `planning/landmarks.json`, `config/legs.json`)
- `demo.*` — replay tuning (`timeCompression`, `tickMs`, `cruiseMph`, …)

`config.json`, `.env`, and `data/*.json` are gitignored.

## Streamerbot integration

The bridge is the event hub. Streamerbot connects a **WebSocket Client** to `ws://<bridge-host>:8787` and listens for:

- `event:lowBattery` — `{ batteryPct, usableBatteryPct, rangeMi, severity, threshold, nearestSupercharger }`
- `event:legComplete` — `{ leg, title, nextLeg, isStandby, legsDone, totalLegs }`
- `event:landmarkEntered` — `{ id, name, type_, leg, header }`

For Twitch alerts, point a Streamerbot action at the ingress:

```
POST http://<bridge-host>:8787/api/alert
{ "kind": "sub", "kicker": "…", "name": "@viewer", "detail": "<b>12</b> MONTHS …" }
```

The bridge rebroadcasts it as an `alert` message and the Alerts overlay shows it. (`name` is HTML-escaped at the boundary.)

## Persistence & the Maricopa week

The bridge keeps a small state file (`bridge/data/state.json`; demo uses `demo-state.json`) holding the trip-start odometer baseline, the set of visited landmarks, and cumulative counters. It's written atomically and survives bridge / OBS / PC restarts **and** the week-long Maricopa pause. Geofences are keyed on landmark `id` (not Google `place_id`) so HOME still fires on the return even though it shares coordinates with the START.

## Project structure

```
bridge/            Node event hub
  src/
    index.js         boot
    pipeline.js      normalize → geofence → legs → logbook → events → broadcast
    hub.js           one HTTP server: WebSocket + REST + static overlay serving
    geofence.js      once-per-entry landmark detection (hysteresis + persisted latch)
    legs.js          route model: current leg, vehicle SVG projection, dist/ETA
    logbook.js       cumulative counters
    persistence.js   atomic JSON state store
    units.js geo.js  conversions + spherical geometry
    sources/
      replay-source.js   DEMO engine (virtual drive)
      mqtt-source.js     LIVE TeslaMate MQTT
      pg-source.js       LIVE Postgres cross-check (optional)
  test/            node:test suite (units, geo, geofence, legs, persistence, replay, overlays)
overlays/          OBS browser sources (vanilla HTML/CSS/JS)
  overlay-system.css   shared tokens / chrome / scanlines / glow
  *.html               the six components + index.html showcase
  js/telemetry-client.js   shared WS client + demo fallback
config/legs.json   six legs, waypoints, map SVG node coords
planning/          design brief, project plan, landmarks.json (geofence lore)
```

## Testing

```bash
cd bridge && npm test
```

Covers unit conversions, haversine/projection, geofence debounce (incl. the shared START/HOME coordinates), leg computation, persistence round-trips, a full demo-loop integration test (every WS message type, all six legs, the scripted low-battery edge), and a fake-DOM harness that executes each overlay's wiring against live-contract frames to catch field drift.

## Notes

- Canvas is **2560×1440** (1440p); sources scale cleanly to 1080p.
- Fonts (Audiowide / Share Tech Mono / DSEG7 / Kaushan Script) load from CDN. Overlays render at the home OBS machine over LAN, not in the car.
- The `index.html` showcase composites transparent PNG snapshots (OBS-CEF can't reliably rasterize scaled cross-document iframes) — the live OBS sources are the individual component files.
