# The Kevin Show — Ride Shift Overlay System: Design Brief

> Imported from the claude.ai/design project (`uploads/KevinShow_RideShift_Design_Brief.md`).
> The Night Drive handoff (`Night_Drive_Handoff.md`) is the resolved, final spec;
> this is the originating brief kept for context.

## Concept
A ground-up redesign of the nightly rideshare stream overlay. Working name for the direction: **Night Drive**. The system is kinetic minimalism: a quiet, modern instrument layer over live IRL video. Real telemetry and shift economics presented like contemporary EV interface design or motorsport broadcast telemetry. Technical, streamlined, relaxed. It should feel like a well-built daily tool, not a produced graphics package.

This replaces the current cyan sci-fi overlay. It is deliberately NOT the retro-futurist amber system used for the Route 66 trip. That system is an event costume; this is the daily uniform. They should feel like the same person's taste in two different registers.

## Reference points
- Modern EV dashboard and infotainment UI (clean dark surfaces, instrument-grade numerals)
- F1 and motorsport broadcast telemetry graphics (dense data made calm and legible on video)
- Dark-mode digital map products (muted basemaps, one confident accent color)
- Contemporary product-dashboard design (soft radii, frosted layers, generous spacing)

## What to avoid
- Neon gamer aesthetics, RGB gradients, aggressive glow
- Retro treatments of any kind (no scanlines, CRT effects, chrome, bevels)
- Over-production: heavy textures, skeuomorphism, busy borders
- Pure black panels (use deep charcoal so the layer has warmth and video underneath stays readable)

## Color
Deep neutral surfaces, one electric accent, semantic supporting colors used sparingly. Starting palette, adjust to taste:

- Surface base: `#121417` (deep charcoal)
- Surface raised: `#1A1D21` at ~85% opacity over video (frosted panel)
- Hairline / dividers: `#2A2E33`
- Text primary: `#F2F4F6`
- Text secondary / labels: `#8B929A`
- Accent (single, electric): `#3DF0C2` mint-teal — or designer's pick of one comparable electric accent. Exactly one accent.
- Earnings positive: accent, not a separate green
- Ride-active state: accent
- Idle / deadhead state: `#8B929A`
- Alert / attention: `#FFB454` used rarely

## Typography
- Numerals and all live data: a tabular monospace or mono-numeral face (e.g. class of JetBrains Mono, Geist Mono, IBM Plex Mono). Timers must be tabular so digits don't jitter.
- Labels, headers, chat lines: a quiet modern grotesque (e.g. class of Inter, Geist, Söhne).
- Hierarchy comes from size and weight, not color variety. Labels are small, uppercase, tracked out, secondary color.

## Motion (this is where the personality lives)
Decoration is static; personality comes from movement. All motion is fast, physical, and restrained:
- Numbers tick/roll when they change (odometer-style on earnings)
- The day's route path draws itself in when the ROUTE view rotates on
- Panels slide and fade in the space of ~200ms, no bounces
- Ride start/end triggers a single clean pulse on the affected panel, not a full-screen alert

## Components

### 1. Map module (the centerpiece)
One map panel that rotates between three contexts. Muted dark basemap, accent-colored data layers. Each view has a small mode tag (NAV / ROUTE / HEAT) so viewers always know what they're seeing. Rotation is a crossfade on a timer, also switchable on demand.

- **NAV** — live position, heading, speed. The "where am I" view.
- **ROUTE** — today's path since shift start. Ride segments in accent, deadhead/idle driving in the muted gray, so the shape of the shift is readable at a glance. Path animates in on view switch.
- **HEAT** — all-time pickup density. "Where Kevin hunts." Soft density blobs in accent tones over the dark basemap, no hard dots.

A privacy geofence around home means the map layers simply never render data inside that zone. Design should assume paths can begin/end at the zone edge gracefully (fade the path tail, don't hard-clip).

### 2. Shift console
The persistent stat cluster. Two tiers:
- **Live tier:** current ride timer, shift timer, idle timer, current speed, temp. Instrument-style, always visible.
- **Totals tier:** today's earnings, rides, ride time vs idle time. Month's earnings, rides, hours.
Design so the live tier is glanceable at PiP scale and the totals tier can collapse.

### 3. Ride ticker / ride list
A compact per-ride record: ride number, duration, earnings, tip if attributed. On ride end, the newest entry slides in. Full list lives on the dashboard (below); the overlay shows the last 2-3.

### 4. Event moments
Ride start, ride end (with earnings), tip added, personal-best moments (best hour, best day pace). These are panel-level pulses and inline highlights, not full-screen alerts. Twitch alerts (follow/sub) should get a matching minimal treatment in the same language.

### 5. Wordmark
"The Kevin Show" in the system's type voice, small, persistent, corner placement. No badge, no emblem, just confident type.

### 6. Companion dashboard (PWA, phone-scale)
A driver-facing control surface, same design language, touch-first: big Start/End Ride buttons, earnings entry keypad, tip attribution to a ride from today's list, shift start/end, and a read-only mirror of today's stats. This is used one-handed in a parked car at night: large targets, high contrast, dark, zero clutter. It is a private tool and can show data (like the ride list with locations) that the overlay does not.

## States to design
- Shift not started / shift live / shift ended summary
- Ride active vs idle (the overlay should read differently at a glance)
- Map: each of the three views plus the transition
- Data-stale / reconnecting (a quiet indicator, not an error screen)
- End-of-shift summary card (shareable-looking recap: earnings, rides, hours, route thumbnail)

## Deliverables
- Editable source (Figma) with a token sheet: colors, type scale, spacing, radii, opacity values, motion durations/easings
- All components in all listed states, on a 1920x1080 canvas with OBS-safe placement notes
- Transparent-background export samples for static elements; motion specs (or Lottie/CSS notes) for the animated behaviors
- Dashboard PWA screens at phone scale (390x844 reference)

## Constraints
- Renders as OBS browser sources over live video at 1080p, and must stay legible under Twitch compression and at mobile viewing size. Avoid hairline-weight data strokes; give the accent lines real width.
- The camera feed must stay dominant. Total overlay footprint should be lighter than the current design, not heavier.
- One accent color, enforced. If a second color is ever needed, it's the semantic alert amber, used rarely.
