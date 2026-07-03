# Handoff: The Kevin Show — "Night Drive" Ride-Shift Overlay System

> Imported from the claude.ai/design project (`design_handoff_night_drive/README.md`,
> project ddb29381-d4eb-4e47-88cb-358aa4c6daf0). The interactive prototype
> `Night Drive System.dc.html` lives in that project; this document is the
> implementation spec of record.

## Overview
A complete stream-graphics system for a nightly IRL rideshare stream, plus a companion driver-facing PWA. It replaces a cyan sci-fi overlay with **kinetic minimalism**: a quiet, instrument-grade telemetry layer over live video — modern EV dashboard × motorsport broadcast telemetry. Decoration is static; personality comes from motion (odometer rolls, route draw-in, panel pulses).

Two render targets:
1. **Stream overlay** — OBS browser sources at 1920×1080 over live camera (Twitch).
2. **Companion dashboard PWA** — 390×844 reference, Kevin's private in-car control surface (start/end rides, enter fares, attribute tips). It is the *write side*; the overlay is the *read side*.

## About the Design Files
The files in this bundle are **design references created in HTML** — live prototypes showing intended look, motion, and behavior. They are NOT production code to copy directly. The task is to **recreate these designs in the target environment** using its established patterns:
- Overlay: any web stack served as OBS browser sources (transparent background). Vanilla/React both fine.
- Map: a real map SDK (MapLibre/Mapbox GL, dark style) replaces the abstract street-grid placeholder.
- PWA: any mobile-web stack; must work offline-tolerant and one-handed.

`Night Drive System.dc.html` opens in a browser and runs a **live simulation** (ride↔idle cycle ~20s, map rotation 8s, cycling event alerts). Interactive: the PWA screens' buttons/keypads write into the same simulated state the overlay reads — that linkage mirrors the intended production architecture.

## Fidelity
**High-fidelity.** Colors, type, spacing, radii, opacities, and motion values are final and specified below. Recreate pixel-perfectly at 1080p scale. The only placeholders: the abstract map basemap (use a real dark basemap), the camera panel (live video source; in the prototype it's a drag-and-drop image slot), and all data values (live telemetry/economics in production).

---

## Architecture (intended)

- **OBS scenes:** `LIVE` (rail overlay over fullscreen camera) · `DATA` (full-screen data scene with camera as a panel) · `RECAP` (end-of-shift card over dimmed camera). Shift-not-started and reconnecting are states of the rail source, not separate scenes.
- **Data flow:** telemetry service (GPS/speed/temp) + shift economics store → WebSocket → overlay sources. PWA writes rides/tips/shift events to the store. Overlay never blocks on writes.
- **Privacy geofence:** a configured zone around home. Map layers must **never render data inside the zone** — clip at ingestion, not at render. Paths fade out over ~170px (at 1080p scale) approaching the zone edge (radial fade), never hard-clip. A small `PRIVACY` label (11px JBM, tracked .22em, 75% secondary) sits at the fade.
- **Overlay footprint budget:** camera stays dominant. LIVE scene covers only the bottom 172px rail + floating chips/dock (bottom offset 196px). Everything must remain legible under Twitch compression and at mobile/PiP size: no strokes thinner than 3.5px, no text smaller than 13px at 1080p.

---

## Screens / Views

### 1. LIVE Rail (driving default) — board `RAIL`
Full-width borderless lower-third over video.
- **Rail container:** left 0 / right 0 / bottom 0, height **172px**; background `linear-gradient(180deg, rgba(10,12,15,0), rgba(10,12,15,.8) 32%, rgba(10,12,15,.94))`; content row `align-items:center`, padding `24px 72px 30px`.
- **Cells** separated by 1px `#2A2E33` left borders, each padded `0 48px`:
  1. Wordmark block: "THE KEVIN SHOW" Barlow 700, 27px, letter-spacing .24em, `#F2F4F6`; below: 8px volt dot (2.2s blink) + "LIVE · NIGHT DRIVE" JBM 500 14px, tracking .2em, `#8B929A`.
  2. State cell (primary): label 14px Barlow 600 .22em — riding: "RIDE · TRIP TIME" in `#C8F542`; idle: "IDLE" in `#8B929A`. Clock JBM 600 **50px**, tabular; riding `#F2F4F6`, idle `#B9BFC7`. A 4px volt underline (left/right 48, bottom −16) flashes on ride start/end (see Motion).
  3. SHIFT — h:mm:ss, JBM 500 40px `#F2F4F6`.
  4. SPEED — value 40px + "MPH" 16px `#8B929A`.
  5. TEMP — 40px.
  6. (flex spacer)
  7. EARNINGS TODAY — **odometer** (see Components), JBM 600 46px/52px, volt `#C8F542`, digit cells 29×52px.
  8. RIDES — 40px.
- **Ride ticker chips** float above the rail: left 72px, bottom 196px, row gap 12px. Chip: `rgba(10,12,15,.72)`, 1px `#2A2E33`, radius 3, padding `11px 18px`; contents `#14` (16px `#8B929A`) · duration (17px `#F2F4F6`, tabular) · fare (17px JBM **700** volt) · tip (16px `rgba(200,245,66,.6)`). Show last 3. Newest slides in on ride end.
- **Map dock** floats above rail: right 72px, bottom 196px, **420×290px**, 1px `#2A2E33`, radius 3, well `#14171C`. See Map module.
- **Totals collapse:** earnings+rides cells can hide (config/hotkey) leaving live tier only.

### 2. Map module (shared) — inside dock, data scene, recap
- **Basemap (placeholder → real dark basemap):** well `#14171C`; grid lines 1px `#232830` at 46px/60px spacing, layer opacity .55; avenues 4px `#262C34`; inset vignette `inset 0 0 50–70px rgba(0,0,0,.5)`.
- **Mode tag** top-left 14px inset: scrim chip `rgba(10,12,15,.78)`, 1px `#2A2E33`, radius 3, padding 7 13; text JBM 600 13–14px, tracking .2em, **volt**; values `NAV` / `ROUTE` / `HEAT`. Top-right: three 8px dots, active = opacity 1, inactive .25.
- **Rotation:** crossfade every **8s** (also on-demand). Views stacked, opacity transition 450ms ease.
- **NAV:** position dot 16px volt + `0 0 22px rgba(200,245,66,.6)` glow; expanding ring 48px, 2.5px volt border, 2.4s ease-out ping. Dot position transitions 1600ms linear (continuous drift). Speed chip bottom-left: "27 MPH · NE".
- **ROUTE:** today's path. Ride segments stroke **4px volt**, deadhead **3.5px `#8B929A` at .75**, round caps/joins. Draw-in on view entry: dashoffset animation 800ms `cubic-bezier(.3,.7,.2,1)`, deadhead segment delayed +550ms, second ride segment +850ms. End dot 5px volt. Privacy fade at path tail (radial, basemap color → transparent, ~170px) + `PRIVACY` label.
- **HEAT:** all-time pickup density: 4–5 soft radial blobs, volt at 15–28% alpha, radius 115–200px, no hard dots. Caption chip "ALL-TIME PICKUPS" optional.

### 3. Overlay states — board `ST`
- **Shift not started (`ST·1`):** rail keeps wordmark (dot solid `#8B929A`, sub "OFFLINE · NIGHT DRIVE"), one cell "SHIFT STARTS — 9:00 PM" (clock 40px `#B9BFC7`), right cell MONTH aggregate 24px `#8B929A`. No live data.
- **Reconnecting / data-stale (`ST·2`):** quiet, not an error. Wordmark dot turns **amber `#FFB454`**, blink 1.4s; sub-line "RECONNECTING · DATA HELD" in amber. All data cells **freeze last values and dim to 45% opacity**. Speed (the only instant metric) shows "––". Trigger after ~5s without telemetry; recover instantly.

### 4. Event moments — board `EV`
Panel-level, never full-screen. One card slides in above the rail, right side (aligned with map dock edge), 200ms ease-out (translateY 8→0 + fade), holds ~6s, fades 200ms. On land, a 3px volt underline pulses (450ms in). Card: width 410px, `rgba(10,12,15,.9)`, 1px `#2A2E33`, radius 3, padding 18 22.
- **RIDE START** — label volt 13px .22em; "RIDE #15" 26px JBM + "PICKUP · 2 MIN" 15px `#8B929A`.
- **RIDE COMPLETE** — "+$12.47" 26px JBM volt + "RIDE #14 · 18:22".
- **TIP ADDED** — "+$3.15" volt + ride ref.
- **◆ PERSONAL BEST** — "$51.40/HR" white + "BEST HOUR PACE". Also an inline "◆ BEST" chip may flash next to PACE in data views (opacity fade, ~4s).
- **Twitch: NEW FOLLOWER / SUB** — same card, label in `#8B929A` (not volt — reserve volt labels for money/telemetry); username 26px JBM white; sub shows "TIER 1" in volt. Same underline pulse.
Simultaneously, the affected rail panel pulses (see Motion). Never queue more than one card; collapse bursts ("+3 FOLLOWERS").

### 5. Shift-complete recap (stream scale) — board `RC`
Camera dims under `rgba(10,12,15,.6)` scrim. Wordmark stays top-left (dot gray, "SHIFT ENDED · NIGHT DRIVE"). Centered card: **920px**, `rgba(14,16,19,.94)`, 1px `#2A2E33`, radius 10, padding 44. Header: "SHIFT COMPLETE" 16px Barlow 600 .26em volt + date/duration JBM 15px gray. Left column: EARNINGS 66px JBM volt; RIDES / HOURS / PACE row (30px, hairline-separated); ride·idle split bar (5px, volt fill on `#2A2E33` track) with h:mm values; bests line; a "!recap" chat-command chip (volt text, 1px volt-40% border). Right: 340px route thumbnail (map module, ROUTE view, static full-drawn). Card fades/slides in 200ms.

### 6. Data Scene (parked / between rides) — board `DS`
Full-screen charcoal stats page; camera becomes a panel. Surface `#101215`, page padding **64px**, Barlow.
- **Header row:** wordmark block + "PARKED · DATA VIEW" outline chip (1px `#2A2E33`, radius 3, 13px JBM .18em gray); right-aligned live tier: STATE (clock 44px, volt underline pulse), SHIFT / SPEED / TEMP (36px), cells padded 0 44 with hairline left borders. Full-width hairline below (margin-top 26).
- **Body** (flex, gap 44, margin-top 30):
  - Left column 1060px: **camera panel 1060×596** (16:9), 1px `#2A2E33`, radius 3; "CAM · MAIN" scrim chip with blinking volt dot top-left. Below (fills remaining ~200px): "LAST RIDES" label + right-aligned caption "FULL LOG · DASHBOARD"; **5-row table**, rows flex-fill, grid `90px 1fr auto 120px`, gap 24, 1px `rgba(42,46,51,.55)` top borders; # 17px gray / duration 20px white / fare 20px JBM 700 volt / tip 17px volt-60% right-aligned. Newest row slides in.
  - Right column (fills, ~590px): EARNINGS TODAY odometer (46/52, volt) · RIDES 36px + PACE 27px volt ("/HR" 14px gray, "◆ BEST" flash chip) · hairline · RIDE·IDLE split bar with 24px h:mm values · MONTH + BESTS lines (14px JBM gray/white) · **map panel** fills remaining height (min 300px).
- In production this is its own OBS scene; camera panel is the live camera source cropped 16:9.

### 7. Companion PWA — boards `P·1`–`P·5` (390×844)
Shared chrome: bg `#101215`, content padding 22px, status bar 44px, home indicator. All targets ≥44px. Dark only, high contrast.
- **P·1 Home · Shift Live:** header (wordmark 14px + live dot; shift clock right) · state block (label 13px volt/gray; clock 62px JBM; 4px pulse underline) · stats strip (hairline top+bottom, 16px pad): EARNINGS odometer 34/40 volt · RIDES 30px · PACE 22px · **primary button 84px**: riding = filled volt "END RIDE" (text `#0E1013` 21px Barlow 700 .26em, radius 6); idle = outline volt "START RIDE" (`rgba(200,245,66,.08)` fill, 1.5px border) · secondary row: ADD TIP / END SHIFT (56px, 1px `#2A2E33`, radius 6) · LAST RIDES list (rows: grid `44px 1fr auto 64px`; second line = pickup→dropoff 13px `#8B929A` — **private data, never on stream**).
- **P·2 End Ride · Fare:** title + "RIDE #15 · 12:34" meta · FARE display 58px JBM volt, centered, hairline under · **keypad 3×4** (`1–9, 00, 0, ⌫`), keys 66px, `rgba(255,255,255,.03)` + 1px `rgba(42,46,51,.8)`, radius 5, 26px JBM · SAVE RIDE 72px filled volt · "ADD TIP LATER" ghost 48px. Entry is **cents-based**: typing `1 2 4 7` → `$12.47` ('00' appends two zeros; max $999.99). No round-number presets — fares are exact.
- **P·3 Add Tip:** "TAP A RIDE" · selectable ride cards (1.5px border, selected = volt border + volt ride #; radius 6, padding 12 14; includes location line) — most recent selected by default · TIP AMOUNT display 32px volt + cents keypad (keys 50px) · APPLY TIP 64px filled volt · CANCEL ghost. Exact-cents entry, same scheme as fare.
- **P·4 Shift Summary:** "SHIFT COMPLETE" volt + date · recap card (1px `#2A2E33`, radius 10, `rgba(255,255,255,.02)`): micro-wordmark 11px .26em · earnings 46px volt · RIDES/HOURS/PACE 24px row · split bar · route thumb 150px · bests line · SHARE RECAP 64px volt · CLOSE SHIFT ghost.
- **P·5 Pre-Shift:** wordmark (dot `#2A2E33`) · centered "NO ACTIVE SHIFT" + 0:00:00 44px · START SHIFT 88px filled volt · LAST SHIFT and MONTH stats (17px JBM) above bottom.

---

## Interactions & Behavior

- **Ride lifecycle:** START RIDE (PWA) → overlay state cell flips to RIDE (volt), trip clock 0:00, panel pulse. END RIDE → fare entry → SAVE → overlay: earnings odometer rolls, RIDES increments, new ticker chip slides in, panel pulse, RIDE COMPLETE event card. Tip applied later → odometer rolls, tip appears on that ride's chip, TIP event card.
- **Panel pulse:** the volt underline under the state cell (and box-glow on carded panels) — opacity 0→1 in 450–500ms ease, hold, fade; total ~750ms. Triggered by ride start/end/tip/PB.
- **Odometer:** each digit is a vertical 0–9 strip, translateY to `−digit × cellHeight`, 700ms `cubic-bezier(.2,.9,.25,1)`. Non-digits ($ . ,) static. Font must be tabular/mono so digits don't jitter.
- **Ticker enter:** new row/chip at opacity 0 / translateY −10px → settles in 350ms ease.
- **Map rotation:** 8s timer, 450ms crossfade; ROUTE re-draws on every entry (reset dashoffset while hidden, animate after ~200ms).
- **Timers:** tick 1s; formats — trip/idle `m:ss`, shift `h:mm:ss`, aggregates `h:mm`. All tabular.
- **Reconnecting:** >5s stale → amber indicator + 45% dim, values held. Restore instantly on data.
- **PWA touch:** all actions bottom-anchored for one-hand reach; APPLY/SAVE are no-ops at $0.00.

## State Management

```
shift:   { status: 'off'|'live'|'ended', startedAt, endsAt?, earningsCents, ridesCount,
           totRideSec, totIdleSec, bestHourCents, bestDayCents }
ride:    { n, startedAt, durSec, fareCents, tipCents, fromZone, toZone }   // zones = neighborhood names, PWA-only
telemetry: { speedMph, headingCardinal, tempF, lat, lng, staleSince? }
ui:      { rideActive, mapView: 0|1|2, pulse, eventQueue: Event[] }
Event:   { kind: 'ride_start'|'ride_end'|'tip'|'pb'|'follow'|'sub', payload, ts }
```
- Derived: PACE = earningsCents ÷ shift hours; split % = totRideSec / (totRideSec+totIdleSec).
- Overlay subscribes (WebSocket); PWA mutates via API; Twitch events via EventSub → same event queue.
- Geofence filtering happens server-side before any position/path reaches the overlay.

## Design Tokens

**Color**
- `surface.base` #101215 (data scene) · `surface.well` #14171C (map/media wells) · desk/deep #0E1013
- `scrim` rgba(10,12,15,.72 / .78 / .84 / .94) — chips / dock chrome / bands / rail max
- `rail.gradient` transparent → rgba(10,12,15,.8) @32% → .94
- `hairline` #2A2E33 · `map.grid` #232830 · `map.avenue` #262C34
- `text.primary` #F2F4F6 · `text.secondary` #8B929A · `text.dim` #B9BFC7
- `accent.volt` #C8F542 (THE one accent; dim = rgba(200,245,66,.6); wash = rgba(200,245,66,.08–.13))
- `alert.amber` #FFB454 — reconnecting/stale only, never decorative
- On-volt text: #0E1013

**Type** (px @1080p; PWA uses listed phone sizes)
- Barlow: wordmark 27/700/.24em · section labels 13–16/600/.20–.26em uppercase · buttons 17–22/700/.24–.28em
- JetBrains Mono (all data, `font-variant-numeric: tabular-nums`): primary clock 50–62/600 · secondary 36–46/500 · recap hero 46–66/600 · row data 15–20/500 (money 700) · captions/meta 11–14/500
- Hierarchy via size/weight only; labels are small, uppercase, tracked, secondary color.

**Spacing:** 4, 8, 12, 16, 24, 32, 44, 48, 64, 72 · page margins 64–72 · rail cell padding 48 · safe guide 48
**Radii:** 3 (chips/panels/tags) · 5–6 (buttons/keys) · 10 (cards) · 30 (device shell)
**Strokes:** hairlines 1px; data strokes ≥3.5px; pulse underline 3–4px

**Motion** (fast, physical, no bounces)
| Behavior | Duration | Spec |
|---|---|---|
| Panel slide/fade in | 200ms | ease-out, translateY 8→0 + opacity |
| Ticker row enter | 350ms | ease, translateY −10→0 + opacity |
| Map crossfade | 450ms | ease, opacity |
| Event pulse | 500ms | ease in, ~750ms total envelope |
| Odometer roll | 700ms | cubic-bezier(.2,.9,.25,1) |
| Route draw-in | 800ms | cubic-bezier(.3,.7,.2,1), stagger +550/+850ms |
| Split bar | 1000ms | ease, width |
| NAV drift | 1600ms | linear, continuous |

## Assets
- **Fonts:** Barlow (400–700) + JetBrains Mono (400–700), Google Fonts — self-host for the OBS sources.
- **No images or icon set.** Only glyph used: ◆ (personal best). Camera feeds are live sources; in the prototype the data-scene camera is a drag-and-drop `<image-slot>` (`image-slot.js`), user-fillable.
- Map basemap in production: MapLibre/Mapbox dark style tuned to the token palette (well #14171C, roads ≈ #232830–#262C34, no labels brighter than #8B929A).

## OBS Placement Notes (1920×1080)
- Rail source: full-canvas browser source, transparent; rail occupies y 908–1080; chips/dock bottom-anchored at y≈884 rising.
- Action-safe: keep all content ≥48px from edges (grid guide toggle exists in the prototype Tweaks).
- Camera fullscreen under overlay in LIVE; in DATA the camera is a 1060×596 panel at (64, ~200).
- PiP test: at 25% preview scale the live tier (state, clocks, speed) must remain readable — it does at the specified sizes; do not shrink below them.

## Files
- `Night Drive System.dc.html` — the locked system, all boards: tokens, LIVE rail, states, events, recap, data scene, PWA ×5. Open in a browser; simulation + interactions run live. (Tweaks: force ride/idle, collapse totals, 48px safe guide.)
- `image-slot.js` — drag-and-drop image slot used by the camera panel (prototype-only helper).
- `support.js` — prototype runtime (required for the .dc.html to render; not part of the design).
- Project root also contains `Night Drive POC.dc.html` — the exploration history (rejected directions); reference only.
