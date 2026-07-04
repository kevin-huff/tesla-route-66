// ND Chat Relay — ONE WebSocket Client message handler turns bridge events
// into chat lines. Attach this Execute C# Code sub-action to an action
// triggered by your WebSocket Client's "Message" trigger (client pointed at
// ws://<bridge-host>:8787 — the same hub the overlays use).
//
// Handles: ride_ended, tip_added, shift_ended, personal_best. Everything else
// on the firehose (telemetry ticks, snapshots, stats_tick, map data) is ignored.
// Payloads carry a pre-formatted chatText under the 500-char IRC limit, so
// chat output is identical whether the shift is driven from chat or the PWA.
//
// Dedupe: guards on a per-event key so a duplicate trigger or a second WS
// client can't double-post (same pattern as the Route 66 transmission hook).
//
// References tab: none needed beyond defaults (Newtonsoft ships with SB).

using System;

public class CPHInline
{
    public bool Execute()
    {
        if (!CPH.TryGetArg("message", out string raw)) return false;

        Newtonsoft.Json.Linq.JObject msg;
        try { msg = Newtonsoft.Json.Linq.JObject.Parse(raw); }
        catch { return true; } // not JSON — ignore

        var type = (string)msg["type"];
        if (type != "ride_ended" && type != "tip_added" && type != "shift_ended" && type != "personal_best")
            return true; // ignore the firehose

        var data = msg["data"];
        var chatText = (string)data?["chatText"];
        if (string.IsNullOrEmpty(chatText)) return true;

        // stable identity per event: ride id / tip id / shift id / pb value
        string key = type + ":" + (
            type == "ride_ended"    ? (string)data["ride"]?["id"] :
            type == "tip_added"     ? (string)data["tip"]?["id"] :
            type == "shift_ended"   ? (string)data["summary"]?["shiftId"] :
                                      (string)data["valueCents"]
        );
        // resends (!recap / PWA "resend chat") are intentional — let them through
        var resent = (bool?)data["resent"] == true;

        if (!resent && key == CPH.GetGlobalVar<string>("ndLastChatKey", false))
            return true;
        CPH.SetGlobalVar("ndLastChatKey", key, false);

        if (chatText.Length > 490) chatText = chatText.Substring(0, 490);
        CPH.SendMessage(chatText, true);
        return true;
    }
}
