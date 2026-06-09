# The Kevin Show — Route 66 Overlay System: Developer Project Plan

## Objective
Build a set of OBS browser-source overlays that render live Tesla telemetry from a local TeslaMate instance, styled to the amber cyberdeck-60s system defined in the design brief. The trip is a six-leg loop with a one-week pause in Maricopa, so counters and progress must persist across days.

## Streaming and transport architecture (context)
The overlays plug into an existing mobile streaming rig that is proven on the Uber streams. The dev agent does not build this part, but should understand it because it defines where the overlays render and how they behave when feeds drop.

### Signal path
Two independent camera encoders ride in the car.

- **Road cam:** a mounted Sony camera into a BELABOX encoder. The BELABOX bonds Starlink and a Verizon hotspot and sends SRTLA.
- **Face cam:** a phone running IRL Pro, bonding Starlink and its own mobile network. A third phone runs purely as a hotspot to feed that mobile leg.

Both encoders send SRTLA to BELABOX Cloud, which acts as the SRTLA relay and outputs a clean SRT stream per feed. OBS at home pulls each as a media source, composites them with the overlays, and outputs one program feed to Twitch. The road cam keeps streaming the parked-car view even when Kevin walks away, since Starlink and the BELABOX stay powered in the car.

### OBS scene and audio rules
- Each car feed is an SRT media source pointed at its BELABOX Cloud endpoint.
- **Keep both SRT sources active at all times.** Do not toggle a feed off with the visibility eye to swap cameras, because deactivating an SRT source tears down the connection and re-showing it forces a reconnect and re-buffer (several seconds of dead feed). Swap primary and picture-in-picture by changing size and position, not by hiding sources.
- **Audio follows the primary camera** via per-scene muting. Each scene mutes the non-primary feed's audio so the mic tracks whichever camera is fullscreen. Cross-feed lip sync is intentionally not a concern, since the secondary cam is visual only.
- Scenes account for both feeds staying available: Road primary, Face primary, and Walkabout. Walkabout still has the road cam available as the parked-car view.

### Bitrate plan
- Per-feed ceiling of 6000 kbps on the road, with adaptive bitrate enabled and a floor around 1500 to 2000 so the encoder throttles down gracefully through weak coverage rather than buffering.
- 12000 kbps is a parked or strong-signal luxury only, not a driving setting.
- The secondary picture-in-picture feed runs lower, around 2000 to 2500 kbps, since it is a thumbnail on screen. Bump it only when it goes fullscreen.
- In dead-cell country, run a single feed so one stream has the whole bonded connection behind it. When cellular is absent and Starlink is the only live link, bonding adds nothing and the feed is limited to Starlink's instantaneous capacity.
- Twitch output is set to the plan's sweet spot at home. There is no reason for a car feed to exceed the Twitch output bitrate, since both feeds are recomposited into one program output.

### Failure-mode handling
- Build a "SIGNAL LOST" card in the cyberdeck transmission style so a dropout reads as intentional. This doubles as the real failure state.
- Use Advanced Scene Switcher to detect a frozen or lost media source and auto-cut to a fallback.
- The overlays are independent of car connectivity. They pull from the home bridge over the LAN, so they keep rendering last-known telemetry even when a camera feed drops on the road.

### Trip-specific risks (different from the city Uber streams)
- **Resilience inverts on the open road.** Through the Texas panhandle, eastern New Mexico, and the Arizona high desert, the cellular legs frequently drop to nothing and Starlink becomes the sole link. Conservative per-feed bitrate plus single-feed operation in those stretches is what keeps the stream alive.
- **Heat.** Phones running IRL Pro on a dash mount in direct desert sun will thermally throttle and shut the app down. Plan active airflow or shade on the encoder phones specifically.
- **Data budget.** Verizon hotspot plans throttle hard after a cap, and six driving days of hours-long streams burn through it fast. Confirm the data allotment before departure.
- **Power.** Sustained draw on the car for Starlink, BELABOX, and charging two or three phones across long driving days, including parked draw during walkabout segments.

## Data source: TeslaMate
TeslaMate runs in the homelab under Docker and exposes two interfaces. Use both.

- **MQTT (real-time).** Per-update topics under `teslamate/cars/<car_id>/`. Relevant ones: `battery_level`, `usable_battery_level`, `speed`, `latitude`, `longitude`, `est_battery_range_km`, `inside_temp`, `outside_temp`, `odometer`, `elevation`, `state` (driving, charging, online, asleep), `charger_power`, `plugged_in`, `geofence` (current named geofence). This drives the live readouts.
- **PostgreSQL (history).** Authoritative for cumulative values that must survive restarts and the week-long gap: trip mileage, charge sessions, drive history. Relevant tables include `positions`, `drives`, and `charges`. Use this for the Logbook counters.

## Architecture
An OBS browser source is a Chromium page. It cannot subscribe to raw MQTT over TCP. Two viable paths:

1. Enable MQTT-over-WebSockets on the broker (Mosquitto listener, typically port 9001) and connect from the page with MQTT.js.
2. Run a small bridge service that subscribes to MQTT, queries Postgres, runs geofence logic, and exposes a clean WebSocket plus REST API to the overlays.

**Recommendation: build the bridge service.** The geofencing, the Postgres cumulative queries, and the cross-day persistence all need a server-side home anyway. Keeping that logic in one bridge lets the overlays stay dumb renderers, and gives a single event hub for Streamerbot.

### Proposed stack
- **Bridge:** Node with `mqtt` and `pg` (or a Python equivalent). Exposes a WebSocket for live telemetry and events, plus REST for cumulative stats.
- **Overlays:** One static HTML/CSS/JS page per component, each its own OBS source. Vanilla JS is fine, no heavy framework needed.
- **Config files:** `legs.json` (the six legs and their waypoints) and `landmarks.json` (geofenced lore: lat, lng, radius, and copy per point, grouped by leg).

## Work breakdown

### Phase 0 — Foundation
- Stand up the bridge skeleton. Connect to TeslaMate MQTT and log live topics to confirm exact field names and units.
- Confirm Postgres connectivity and identify the relevant tables and columns.
- Build the shared CSS token file from the design brief (amber palette, fonts, scanline and glow mixins).
- Build a base overlay HTML template (transparent background, token import, WebSocket client with reconnect).

### Phase 1 — Telemetry Console
- Subscribe to `battery_level`, `est_battery_range_km`, `speed`, `inside_temp`.
- Render gauges and nixie readouts per the design.
- Add a configurable low-charge threshold that triggers the warning visual state and emits a `low_battery` event for Streamerbot.
- Handle unit conversion (km to mi if needed) and debounce jumpy speed values.

### Phase 2 — Mission Map
- Render the six-leg loop as an SVG flight plan from `legs.json`.
- Use live lat/lng to highlight the current leg, mark completed legs solid, and show Maricopa as a STANDBY node.
- Compute and display LEG 0X/06, distance to next waypoint, and ETA.
- Decide between a pre-plotted static path (simplest) or a live Mapbox basemap (richer, more setup).

### Phase 3 — Transmission ticker (geofenced lore)
- Two options for geofencing. Either roll a custom check in the bridge against `landmarks.json`, or lean on TeslaMate's native geofences and read the `geofence` MQTT topic. The custom approach gives finer control over lore copy and radius per landmark.
- On geofence entry, emit a `transmission` event, debounced to fire once per entry rather than repeatedly while inside the radius.
- Overlay renders the teletype card with typewriter reveal and a chime, header showing the place name.

### Phase 4 — Logbook counters
- Query Postgres for cumulative values: total trip miles (odometer delta from a stored trip-start baseline), charge session count, states crossed (derive from a state-boundary list or geofences), elevation gained. "Gas stations bypassed" can be a fun estimated or static-incrementing metric.
- Store the trip-start baseline so the tally stays continuous across the Maricopa week.
- Refresh on a timer. These do not need real-time updates.

### Phase 5 — Branding and alerts
- Build the show wordmark/badge component.
- Wire follow, sub, and channel-point alerts into the console visual language. Coordinate the trigger path with Streamerbot (it can hit the bridge or fire a browser-source event).

### Phase 6 — Integration and polish
- Place all sources in the OBS scene. Verify safe zones, transparency, and performance.
- Confirm reconnect logic so a broker or bridge drop does not freeze the overlays.
- Add a demo/replay mode that feeds canned telemetry so overlays can be tested without driving.

## Streamerbot integration
Route `low_battery`, `leg_complete`, and `landmark_entered` through the bridge as events. Streamerbot subscribes over WebSocket to trigger sounds and scene changes. Keep the bridge as the single event hub so there is one place to reason about timing.

## Acceptance criteria
- Each overlay renders correctly as an OBS browser source with a transparent background at 1080p.
- Live telemetry updates within roughly one to two seconds of TeslaMate.
- Counters survive an OBS or PC restart and the week-long Maricopa gap.
- Geofenced transmissions fire once per entry, not on repeat.
- Overlays reconnect gracefully when a data source drops.
- Output matches the design tokens from the brief.

## Open questions and config needed
- TeslaMate `car_id` (usually 1), broker host and port, and whether MQTT-over-WebSockets is already enabled.
- Miles versus kilometers preference.
- Final landmark list and who writes the lore copy.
- Stream canvas resolution (1080p versus 1440p).
