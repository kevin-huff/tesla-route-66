# Streamer.bot setup — Night Drive

Streamer.bot's export/import strings are a proprietary blob its UI generates — they can't
be hand-authored reliably, so this kit is the next best thing: **two paste-in C# files and
a 5-minute click-through**. End state: Streamer.bot holds zero ride state — commands call
the bridge REST, chat lines come back off the bridge WebSocket.

```
chat command ──▶ [ND Command Router action] ──▶ POST bridge /api/ride/*
bridge WS event (ride_ended / shift_ended / personal_best) ──▶ [ND Chat Relay action] ──▶ chat
```

## 1. Action: `ND Command Router`

1. **Actions → Add** — name it `ND Command Router`.
2. Add one sub-action: **Core → C# → Execute C# Code**, paste `ND_Command_Router.cs`.
3. Edit the two constants at the top: `BRIDGE` (e.g. `http://unraid.lan:8787`) and `TOKEN`
   (the `ride.authToken` from `bridge/config.json`).
4. In the sub-action's **References** tab add `System.dll` and `System.Net.Http.dll`
   (or click *Find Refs*), then **Compile** — expect ✔.

## 2. Commands (all pointing at that ONE action)

**Commands → Add** for each row; on the Advanced tab set the sources to Twitch and attach
the `ND Command Router` action:

| Command | Permission | Cooldown | Notes |
|---|---|---|---|
| `!start_shift` | Broadcaster + Mods | — | |
| `!end_shift` | Broadcaster + Mods | — | refuses while a ride is open |
| `!start_ride` | Broadcaster + Mods | — | |
| `!end_ride` | Broadcaster + Mods | — | takes the fare: `!end_ride 14.75` |
| `!add_tip` | Broadcaster + Mods | — | `!add_tip 5` → most recent ride |
| `!ride_stats` | Everyone | 30s global | posts day + month line |
| `!recap` | Everyone | 60s global | re-posts the last ride/shift summary |

The router reads `%command%`, so one action serves all seven. Mode/input matching:
leave "Ignore Internal" defaults; `!end_ride`/`!add_tip` read their amount from `%rawInput%`.

## 3. Action: `ND Chat Relay` + WebSocket Client

1. **Actions → Add** — name it `ND Chat Relay`; add an **Execute C# Code** sub-action with
   `ND_Chat_Relay.cs` (no extra references needed) and Compile.
2. **Servers/Clients → WebSocket Clients → Add**:
   - Address: `ws://<bridge-host>:8787` (same hub the overlays use)
   - ✔ Auto Connect, ✔ Auto Reconnect
3. On that client's **Triggers**, add trigger **Message** → run action `ND Chat Relay`.

If you still run the Route 66 transmission hook, keep it as its own action — the relay here
ignores every message type except `ride_ended` / `shift_ended` / `personal_best`, so both
can listen to the same client without cross-talk.

## 4. Delete the legacy RideTracker

Once parity is confirmed (below): delete **Add tip, Start/End Ride, Start/End Shift,
Reset Ride Data, Ride Stats, Update Idle Time, Update Ride Timer, Update Shift Timer**
and every ride/shift/tip/earnings global. Timers now render in the overlay from bridge
state; stats come from bridge payloads. Nothing in Streamer.bot holds numbers anymore.

## 5. One-time migration + parity test

1. Before the first cutover shift, copy the current month totals out of the old globals:
   ```
   curl -X POST http://<bridge>:8787/api/ride/seed \
     -H "Authorization: Bearer <token>" \
     -d '{"month":"2026-07","earnings":"1842.75","rides":131,"shiftSeconds":324000}'
   ```
2. Run one shift with both systems live and compare chat lines; `GET /api/ride/stats/month`
   must match the old bot to the cent.
3. Kill-switch test: close Streamer.bot mid-shift, run a ride from the PWA, reopen —
   stats stay correct; the missed chat line is skippable by design (`!recap` re-posts).

## Division of labor (why some replies come from the router and some from the relay)

- **Router posts**: start confirmations, errors, and `!ride_stats`.
- **Relay posts**: ride summaries, tip lines, shift summaries, personal bests — driven by
  bridge events so a ride ended (or tip added) from the **PWA** produces the exact same
  chat line as one from chat. The relay dedupes on event identity, and `!recap`/PWA
  resends are passed through intentionally.
