# The Kevin Show — Route 66 Overlay System

OBS stream overlays that render **live Tesla telemetry** from a local [TeslaMate](https://github.com/teslamate-org/teslamate) instance, styled as an amber cyberdeck / Space-Age mission console. Built for a six-leg Route 66 road-trip series.

> **Real data, retro housing.** The camera feed stays clean and legible; all the styling lives in the panels, gauges, and nixie readouts around it.

This repo now hosts **two** overlay systems on the same bridge: the Route 66 trip suite (below) and **[Night Drive](#night-drive--ride-shift-tracker-nightly-stream)** — the nightly rideshare stream's ride-shift tracker, overlay suite, and phone PWA, in its own design system.

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
                       POST /api/alert    └─ event:lowBattery / legComplete / landmarkEntered / transmission
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

**Preview params:** `?state=warn` (telemetry klaxon state) · `?state=charge` (telemetry CHARGE mode) · `?noaudio` (hide the telemetry AUDIO strip) · `?idle` (transmission starts hidden) · `?demo` (force canned data) · `?live` (never fall back to demo).

## The six overlays

1. **Mission Map** — a live moving map in the same amber-CRT housing: MapLibre GL over keyless [OpenFreeMap](https://openfreemap.org) vector tiles, restyled phosphor-on-black (roads glow, towns read as light pollution, dashed state lines). Follow-cam tracks the car with speed-adaptive zoom; the **real Route 66 driving geometry** is drawn per leg (done solid / current pulsing / future dashed) with a breadcrumb trail of the actual path; a whole-loop inset keeps mission progress visible; footer shows leg / **road-miles** to next waypoint / ETA.
2. **Telemetry Console** — battery %, range, speed, cabin/outside temp on 7-segment readouts, plus a **NEXT SC margin** row: road-miles to the next planned Supercharger and how much range is spare (amber-alerts at `thresholds.scMarginWarnMi`, before the klaxon). State-aware: plugged in flips the NAV bay to **CHARGE** (kW output, time-to-limit, target %, battery bar visibly filling); asleep dims the console to `SYSTEMS IDLE` / `STANDBY · MARICOPA, AZ`. A bottom **AUDIO strip** renders Spotify now-playing (amber-duotone art, marquee title, self-advancing progress) fed by Streamer.bot — hide it with `?noaudio`. Normal amber state + a low-charge **klaxon** warning state.
3. **Transmission Card** — an incoming teletype with a typewriter reveal. By default the content is **generated by an LLM** from the car's live location ([see below](#transmissions-llm)); switch `transmissions.source` to `geofence` to use the hand-written landmark lore (fired once per geofence entry) instead.
4. **Logbook Counters** — a persistent punch-card tally that rotates between two pages every ~12 s (`?page=1|2` pins one): **THE TRIP** (miles logged, route % complete along the real road, waypoints logged x/58, states crossed, days on road) and **POWERTRAIN** (kWh charged from real charge sessions, Superchargers docked, **gas money saved** in dollars — the EV flex, priced — drive hours, charge hours). Tune `trip.iceMpg` / `trip.gasPriceUsdPerGal` in config.
5. **Show Badge** — "The Kevin Show" as a chrome-and-neon Route 66 shield (static).
6. **Alerts** — follow / sub / channel-point redemption lower-thirds in the same console language.

Overlays are dumb renderers: a shared `telemetry-client.js` connects to the bridge, auto-reconnects, keeps the last-known frame on a drop (no blanking), and falls back to canned demo data so any file renders standalone.

### Mission Map basemap & route geometry

The map overlay renders OpenFreeMap vector tiles (free, no API key) through a hand-rolled amber style (`overlays/config/map-style-amber.js`); MapLibre GL is vendored under `overlays/vendor/`. The real driving geometry for all six legs is fetched **once** from OSRM and committed — `config/route-geometry.json` for the bridge, `overlays/config/route-geometry.js` for the overlay — so there's no runtime routing dependency. Regenerate only if `landmarks.json` / `legs.json` change:

```bash
cd bridge && node scripts/fetch-route-geometry.mjs
```

This geometry powers three things: the demo replay drives the **actual roads** (real curves, true compass headings), the footer's DIST TO NEXT is measured **along the route** instead of as the crow flies, and the bridge persists a thinned breadcrumb trail (in `state.json`, sent with each snapshot) so the driven path repaints after an OBS refresh. If the basemap tiles are unreachable mid-stream the map goes dark but the route lines, car marker, loop inset, and readouts keep working — they're all local data. Map camera: north-up by default; append `?rotate` for a heading-up chase cam.

## Going live (real TeslaMate)

```bash
cd bridge
cp config.example.json config.json     # fill in broker / car_id / Postgres
# secrets can instead go in .env (copy from .env.example) — env wins over config.json
npm run live
```

Watch the boot logs — `[r66] mqtt connected …` confirms the broker, and `GET /healthz` reports `mqtt` / `pg` status. The overlays don't change between demo and live; the bridge emits the same messages either way. Units are converted to **miles / mph / °F** in the bridge (TeslaMate publishes metric).

## Transmissions (LLM)

By default the Transmission Card is driven by an LLM instead of the preset landmark list. On a timer the bridge takes the car's current GPS and asks a local **OpenAI-compatible** endpoint (e.g. [clewdr](https://github.com/Xerxes-2/clewdr)) to write a transmission log about wherever the car is, in the show's voice — coordinates go straight to the model, so a capable backend that knows geography does the place-finding.

Variety comes from two mechanisms: each call draws an **angle** (history / local lore / Route 66 era / landscape / music & film / town portrait / roadside food / mission-control report) from a shuffle bag so every lens appears before any repeats, and the prompt carries the last few places covered (`recentPlaces`) so the model doesn't circle the same subject. The prompt also includes local time, leg, battery, and the next planned Supercharger, so the mission-control angle can reference real trip state. A car docked at a charger still transmits — the arrival fires one card about the stop, then the move gate holds until the wheels roll again.

Configure it under `transmissions` in `config.json`:

```json
"transmissions": {
  "source": "llm",                 // "llm" | "geofence" | "both"
  "intervalSec": 180,              // generate every ~3 min
  "kickoffSec": 20,                // first one shortly after boot
  "drivingOnly": true,             // only on the road (driving or charging) — skip parked/asleep
  "minMoveMi": 3,                  // skip if the car hasn't moved this far since the last one
  "recentPlaces": 6,               // how many recent subjects the model is told to avoid
  "llm": {
    "baseUrl": "http://localhost:8484/v1",
    "apiKey": "",                  // set if your endpoint needs one (or R66_LLM_API_KEY)
    "model": "claude-sonnet-4-5",  // whatever model string your endpoint expects
    "temperature": null,           // omitted unless numeric (newer Claude models reject it)
    "maxTokens": 400,
    "timeoutMs": 30000
  }
}
```

- `source`: `llm` replaces the preset transmissions (geofences still drive legs / logbook / Streamerbot events silently); `geofence` uses the hand-written `landmarks.json` lore; `both` does both.
- Endpoint failures are logged and skipped — the card just holds its last frame; `GET /healthz` reports the `llm` status.
- Overrides: `R66_LLM_BASE_URL`, `R66_LLM_API_KEY`, `R66_LLM_MODEL`.
- Every transmission (LLM **and** geofence) is also broadcast as `event:transmission` with ready-to-post `chatText` — see [Streamerbot integration](#streamerbot-integration) for piping it to Twitch chat.

**Display + triggers.** The card always re-shows the last transmission when an overlay (re)connects — e.g. an OBS source refresh — and auto-hides after `transmissionDwellMs` (default 150s, in `overlays/config/overlay-config.js`). Two HTTP triggers (GET **or** POST, so they're easy to wire to a chatbot's URL-fetch or an OBS hotkey):

- `GET|POST /api/transmission/show` — re-show the last transmission (pop the card back up).
- `GET|POST /api/transmission/generate` — force a fresh one now (ignores the timer + driving/move gates). `/api/transmission/test` is an alias.

To drive it from Twitch chat, use a **local** bot (Streamerbot can reach `localhost`): a `!lore` command → HTTP Request → `http://localhost:8787/api/transmission/show`. Cloud bots (Nightbot/StreamElements `urlfetch`) run off-box and can't reach `localhost` unless the bridge is exposed.

## Configuration

`bridge/config.example.json` is the committed template (and the demo default). Key fields:

- `mode` — `demo` | `live` (override with `R66_MODE`)
- `server.port` — default `8787`
- `vehicle.carId` — TeslaMate car id (usually `1`)
- `mqtt.url` / `mqtt.topicBase` — e.g. `mqtt://teslamate.lan:1883`, `teslamate/cars/1`
- `postgres.*` — connection for the optional accuracy poller (live mode: counts DC fast-charge stops for the SUPERCHARGERS counter and derives STATES from TeslaMate's geocoded drive addresses, so off-plan chargers and landmark-free state crossings still count)
- `thresholds.lowBatteryPct` — when the telemetry console flips to the klaxon state
- `thresholds.scMarginWarnMi` — when the NEXT SC margin readout goes amber (default 40)
- `transmissions.*` — LLM-driven Transmission Card (see [Transmissions (LLM)](#transmissions-llm))
- `trip.landmarksPath` / `trip.legsPath` — geofence + route data (default: `planning/landmarks.json`, `config/legs.json`)
- `demo.*` — replay tuning (`timeCompression`, `tickMs`, `cruiseMph`, …)

`config.json`, `.env`, and `data/*.json` are gitignored.

## Streamerbot integration

The bridge is the event hub. Streamerbot connects a **WebSocket Client** to `ws://<bridge-host>:8787` and listens for:

- `event:lowBattery` — `{ batteryPct, usableBatteryPct, rangeMi, severity, threshold, nearestSupercharger }`
- `event:legComplete` — `{ leg, title, nextLeg, isStandby, legsDone, totalLegs }`
- `event:landmarkEntered` — `{ id, name, type_, leg, header }`
- `event:transmission` — `{ id, place, body, leg, type_, chatText }` — every Transmission Card (LLM and geofence), with `chatText` pre-formatted for Twitch chat (under the 500-char IRC limit)

**Transmissions → Twitch chat.** Add a *WebSocket Client* in Streamer.bot pointed at `ws://<bridge-host>:8787`, create an action on its **Message** trigger, and give it one *Execute C# Code* sub-action (the trigger delivers the raw WS payload in `%message%`):

```csharp
using System;

public class CPHInline
{
    public bool Execute()
    {
        if (!CPH.TryGetArg("message", out string raw)) return false;
        var msg = Newtonsoft.Json.Linq.JObject.Parse(raw);
        if ((string)msg["type"] != "event:transmission") return true; // ignore telemetry/map/etc.
        var id = (string)msg["data"]?["id"];
        if (!string.IsNullOrEmpty(id) && id == CPH.GetGlobalVar<string>("r66LastTxId", false))
            return true; // already posted — guards duplicate triggers / extra WS clients
        CPH.SetGlobalVar("r66LastTxId", id, false);
        var chatText = (string)msg["data"]?["chatText"];
        if (!string.IsNullOrEmpty(chatText)) CPH.SendMessage(chatText, true);
        return true;
    }
}
```

The envelope is `{type, ts, seq, data}`, so the filter on `type` is what keeps the firehose (telemetry every tick) out of chat. Use the same pattern with `event:lowBattery` / `event:legComplete` for chat callouts on those.

If chat gets every transmission **twice**, two things are firing: each transmission goes out as both `transmission` (overlay card) and `event:transmission` (this chat hook), so an older action triggering on `transmission` — or a second WebSocket Client feeding the same action — posts a duplicate. Keep exactly one action filtered to `event:transmission`; the `r66LastTxId` guard above makes a stray duplicate harmless either way.

For Twitch alerts, point a Streamerbot action at the ingress:

```
POST http://<bridge-host>:8787/api/alert
{ "kind": "sub", "kicker": "…", "name": "@viewer", "detail": "<b>12</b> MONTHS …" }
```

The bridge rebroadcasts it as an `alert` message and the Alerts overlay shows it. (`name` is HTML-escaped at the boundary.)

**Spotify now-playing.** Source: [Tawmae's Spotify × Streamer.bot extension](https://tawmae.xyz/spotify-and-sb) (requires Spotify Premium + its `TawmaeUI.dll`). It fires three custom triggers — **New Song**, **Song Continued**, **Song Paused** — each carrying `%trackName%`, `%artists%`, `%albumName%`, `%coverImageURL%`, `%durationMs%`, `%progressMs%`, `%isPlaying%`. Streamer.bot's built-in *Fetch URL* sub-action is GET-only, so the relay is one *Execute C# Code* sub-action on an action wired to all three triggers:

```csharp
using System;
using System.Net.Http;
using System.Text;

public class CPHInline
{
    private static readonly HttpClient http = new HttpClient() { Timeout = TimeSpan.FromSeconds(2) };

    public bool Execute()
    {
        CPH.TryGetArg("trackName", out string title);
        CPH.TryGetArg("artists", out string artist);
        CPH.TryGetArg("albumName", out string album);
        CPH.TryGetArg("coverImageURL", out string artUrl);
        CPH.TryGetArg("durationMs", out long durationMs);
        CPH.TryGetArg("progressMs", out long progressMs);
        if (!CPH.TryGetArg("isPlaying", out bool playing)) playing = true;

        var body = Newtonsoft.Json.JsonConvert.SerializeObject(new {
            trackName = title, artists = artist, albumName = album,
            coverImageURL = artUrl, durationMs, progressMs, isPlaying = playing,
        });
        try {
            http.PostAsync("http://127.0.0.1:8787/api/nowplaying",
                new StringContent(body, Encoding.UTF8, "application/json")).Wait();
        } catch (Exception e) { CPH.LogWarn("r66 nowplaying: " + e.Message); }
        return true;
    }
}
```

Before compiling, open the sub-action's **References** tab and add `System.dll` and `System.Net.Http.dll` (or hit *Find Refs*) — Streamer.bot's C# compiler doesn't include them by default, and you'll get `CS0012: The type 'Uri' is defined in an assembly that is not referenced` without `System.dll`. References are stored per C# sub-action.

The bridge accepts the extension's raw variable names verbatim (and converts `durationMs`/`progressMs` to seconds), rebroadcasts a `nowplaying` WS message, and includes it in snapshots so OBS refreshes repaint the current track. *Song Paused* arrives with `isPlaying=false` and drops the AUDIO strip to `NO CARRIER`; the strip self-advances progress between posts. Sanity check without Spotify: `curl -X POST localhost:8787/api/nowplaying -d '{"trackName":"Test","artists":"Me"}'`.

## Persistence & the Maricopa week

The bridge keeps a small state file (`bridge/data/state.json`; demo uses `demo-state.json`) holding the trip-start odometer baseline, the set of visited landmarks, and cumulative counters. It's written atomically and survives bridge / OBS / PC restarts **and** the week-long Maricopa pause. Geofences are keyed on landmark `id` (not Google `place_id`) so HOME still fires on the return even though it shares coordinates with the START.

## Project structure

```
bridge/            Node event hub
  src/
    index.js         boot
    pipeline.js      normalize → geofence → legs → logbook → trail → events → broadcast
    hub.js           one HTTP server: WebSocket + REST + static overlay serving
    geofence.js      once-per-entry landmark detection (hysteresis + persisted latch)
    legs.js          route model: current leg, road/straight dist-to-next, ETA
    road-path.js     real-road polyline: landmark snapping, pos-at-distance, locate()
    logbook.js       cumulative counters
    persistence.js   atomic JSON state store
    units.js geo.js  conversions + spherical geometry
    sources/
      replay-source.js   DEMO engine (drives the real road geometry)
      mqtt-source.js     LIVE TeslaMate MQTT
      pg-source.js       LIVE Postgres cross-check (optional)
    ride/              Night Drive ride-shift tracker module
      tracker.js         shift/ride/tip state machine (timestamp-derived timers)
      json-store.js      file store (demo/fallback) · pg-store.js  Postgres (ride_tracker schema)
      routes.js          /api/ride/* REST · privacy.js  home-zone filter · heat.js  pickup binning
      night-demo.js      city simulation (npm run demo:night)
  scripts/
    fetch-route-geometry.mjs   one-time OSRM geometry build (committed output)
  test/            node:test suite (units, geo, geofence, legs, road-path, persistence, replay, overlays)
overlays/          OBS browser sources (vanilla HTML/CSS/JS)
  overlay-system.css   shared tokens / chrome / scanlines / glow
  *.html               the six components + index.html showcase
  js/telemetry-client.js   shared WS client + demo fallback
  config/              overlay-config.js · map-style-amber.js · route-geometry.js (generated)
  vendor/              maplibre-gl (pinned 5.6.0)
  night-drive/         Night Drive suite (separate design system — volt/charcoal)
    nd-tokens.css        token sheet + shared chrome · fonts/ self-hosted Barlow + JetBrains Mono
    rail.html data.html recap.html   the three OBS scenes
    js/                  nd-client.js (WS) · nd-ui.js (odometer/timers/events) · nd-map.js (NAV/ROUTE/HEAT) · nd-demo.js
    config/              nd-config.js · map-style-night.js
    dash/                installable PWA (fare keypad, tips, retry queue)
config/            legs.json (six legs, nodes) · route-geometry.json (generated road polylines)
planning/          design brief, project plan, landmarks.json (geofence lore)
```

## Testing

```bash
cd bridge && npm test
```

Covers unit conversions, haversine/projection, geofence debounce (incl. the shared START/HOME coordinates), leg computation, road-path invariants (every landmark snaps on-road inside its geofence radius, in trip order), persistence round-trips, a full demo-loop integration test (every WS message type, all six legs, the scripted low-battery edge), and a fake-DOM harness that executes each overlay's wiring against live-contract frames to catch field drift.

## Night Drive — ride-shift tracker (nightly stream)

The second overlay system in this repo: a server-side **ride tracker module** in the same bridge, plus a **Night Drive** overlay suite and a **phone PWA**, for the nightly rideshare stream. Design system is deliberately separate from the Route 66 amber costume — kinetic minimalism, one volt accent (`overlays/night-drive/nd-tokens.css`); spec of record in `planning/night-drive/`. Streamerbot is demoted to thin I/O: chat commands call bridge REST, one WebSocket subscription posts chat lines from bridge events.

```bash
cd bridge
npm run demo:night     # city ride/idle simulation — full suite animates, no car, no Postgres
```

### OBS sources (1920×1080, all full-canvas, transparent)

| Scene | URL | Notes |
|---|---|---|
| LIVE | `/night-drive/rail.html?embed` | lower-third rail + ticker chips + map dock + event cards |
| DATA | `/night-drive/data.html?embed` | full-screen stats; put the camera source UNDER it (the 1060×596 panel is a transparent hole) |
| RECAP | `/night-drive/recap.html?embed` | hidden until `shift_ended`; safe to keep loaded |

Rail params: `?collapse` hides the totals tier. Every page falls back to a canned client-side sim when no bridge is reachable, so files render standalone.

### Ride tracker module (`bridge/src/ride/`)

- **Owns all state**: shifts, rides (GPS pickup/dropoff snapshots from the shared telemetry feed), tips (attributable to any ride), idle intervals. All timers derive from stored timestamps — a bridge restart mid-ride loses nothing.
- **Storage**: Postgres in live mode (`ride.storage: "auto" | "pg"`), in a dedicated `ride_tracker` schema (never touches TeslaMate's tables; DDL bootstraps itself). JSON file fallback/demo (`bridge/data/ride-tracker.json`).
- **Money is integer cents** everywhere. Chat-style dollar strings (`!end_ride 14.75`) are converted at the API edge.
- **Idempotency**: every POST accepts an `idempotencyKey`; retries and double-taps replay the original result instead of double-logging. State-machine guards (409s) back that up.
- **Day boundary is 4 AM local** (`ride.dayRolloverHour`) so a 9 PM–3 AM shift is one "day".
- **stats_tick** broadcasts every `ride.statsTickSec` (5s) while a shift is live; payloads carry `serverNow` so overlay timers never drift.

### REST (auth: `Authorization: Bearer <ride.authToken>` or `?token=`; required for POSTs and `?private=1`)

```
POST /api/ride/shift/start | /api/ride/shift/end
POST /api/ride/start | /api/ride/end {fareCents | earnings}
POST /api/ride/tip {amountCents | amount, rideId?}      # no rideId -> most recent ride
POST /api/ride/map/mode {mode: nav|route|heat}          # force the overlay map view
POST /api/ride/summary/resend                           # re-post last ride/shift summary to chat
POST /api/ride/seed {month, earnings, rides, shiftSeconds}   # one-time migration (below)
GET  /api/ride/stats/today | /stats/month | /stats/chat | /rides/today
GET  /api/ride/map/route/today | /api/ride/map/heat?binM&from&to&dow&hour
```

WS events on the shared hub: `shift_started`, `ride_started`, `ride_ended {stats, chatText}`, `tip_added`, `shift_ended {summary, chatText}`, `stats_tick`, `map_mode`, `personal_best`.

### Privacy geofence

Configure `ride.privacy {lat, lng, radiusM}`. Enforced **server-side at every payload boundary**: path points inside the zone are dropped (segments split; the overlay renders a radial fade + `PRIVACY` label at the cut), single points (NAV position, heat pickups on the stream endpoint) are clamped/dropped, and the shared `telemetry`/`map` channels are clamped in the pipeline too. `bridge/test/ride-privacy.test.js` asserts no in-zone coordinate ever appears in any overlay-facing payload. The PWA (private, authed) sees unfiltered data. No reverse-geocoded addresses render anywhere on stream — coordinates are map geometry only.

### Streamerbot rewire

Keep six command actions, each one **HTTP Request** sub-action (POST, header `Authorization: Bearer <token>`):

| Command | Request |
|---|---|
| `!start_shift` / `!end_shift` | `POST /api/ride/shift/start` · `/api/ride/shift/end` — body `{"source":"chat"}` |
| `!start_ride` | `POST /api/ride/start` — `{"source":"chat"}` |
| `!end_ride 14.75` | `POST /api/ride/end` — `{"source":"chat","earnings":"%rawInput%"}` |
| `!add_tip 5` | `POST /api/ride/tip` — `{"source":"chat","amount":"%rawInput%"}` |
| `!ride_stats` | `GET /api/ride/stats/chat` → post `chatText` |

Chat lines come from ONE WebSocket Client action (same pattern as the [transmission hook](#streamerbot-integration)) filtered to `ride_ended` / `shift_ended` — each payload carries a ready `chatText` under the IRC limit. **Delete** the legacy timer/stat actions and globals (Update Idle/Ride/Shift Time, Reset Ride Data): timers render in the overlay from bridge state now. A full shift works with Streamerbot offline; chat simply resumes on reconnect.

**Migration** — before cutover, copy the current month totals out of the old Streamerbot globals once:

```bash
curl -X POST http://<bridge>:8787/api/ride/seed -H "Authorization: Bearer $TOKEN" \
  -d '{"month":"2026-07","earnings":"1842.75","rides":131,"shiftSeconds":324000}'
```

Month stats = seed + tracked rides from then on, to the cent; seed is zero for later months.

### PWA dashboard (`/night-drive/dash/`)

Installable, dark, one-handed: start/end shift, start/end ride with a cents-exact fare keypad (`1 2 4 7` → `$12.47`), tip attribution to any of today's rides, live stats, map-mode override, resend-chat. Mutations go through a **persistent retry queue** with idempotency keys — flaky cellular or an app kill can't lose or double-log a ride. The ride list shows pickup→dropoff coordinates (private surface only). Set the token once via the TOKEN button (stored on-device).

**Remote access (the phone in the car is not on the LAN): use Tailscale.** Install tailscaled on Unraid and Tailscale on the phone, then install the PWA from `http://<tailscale-ip>:8787/night-drive/dash/`. No ports exposed, WireGuard-encrypted, and the bearer token stays as a second factor. (A Cloudflare Tunnel + Access works too if you ever need viewer-facing pages remote, but don't put the PWA on the public internet.)

### Heat map

`GET /api/ride/map/heat` returns grid-binned pickup densities (`ride.heat.binM`, default 250 m) — never raw points. The overlay's HEAT view renders it as a soft volt density layer ("where Kevin hunts"). The same endpoint with `?from&to&dow&hour` filters powers personal analytics from the PWA (e.g. `?dow=5,6&hour=21,22,23` = weekend late-night pickups). History accumulates from cutover — no backfill (TeslaMate drives have no ride/no-ride labels; the schema's `source` column leaves room for a manual import if you ever change your mind).

### Night Drive config (`bridge/config.example.json` → `ride`)

- `authToken` — shared bearer for PWA/Streamerbot POSTs (`R66_RIDE_TOKEN` env override). Auth is disabled while it's `CHANGE_ME` (dev/demo).
- `storage` — `auto` (pg in live mode, JSON otherwise) | `pg` | `json`; `pgSchema` (default `ride_tracker`)
- `privacy.lat/lng/radiusM` — home zone; **set this before going live**
- `heat.binM`, `path.minMoveM/maxPoints`, `statsTickSec`, `timezone`, `shiftStartsAt` (pre-shift rail text), `demo.*` (night-demo tuning)

## Notes

- Canvas is **2560×1440** (1440p); sources scale cleanly to 1080p.
- Fonts (Audiowide / Share Tech Mono / DSEG7 / Kaushan Script) load from CDN. Overlays render at the home OBS machine over LAN, not in the car.
- The Mission Map basemap streams from OpenFreeMap (OpenStreetMap data, attributed on-overlay); everything else — route lines, trail, geofences — is local data.
- The `index.html` showcase composites transparent PNG snapshots (OBS-CEF can't reliably rasterize scaled cross-document iframes) — the live OBS sources are the individual component files.
