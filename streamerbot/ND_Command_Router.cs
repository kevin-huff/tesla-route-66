// ND Command Router — ONE action handles every Night Drive chat command.
// Wire all the commands (!start_shift, !start_ride, !end_ride, !add_tip,
// !end_shift, !ride_stats, !recap) to a single action containing this
// Execute C# Code sub-action. The matched command arrives in %command%,
// everything after it in %rawInput%.
//
// The router posts confirmations and errors. Ride/shift summary chat lines
// deliberately do NOT post from here — they arrive over the WebSocket
// (ND_Chat_Relay.cs) so PWA-driven actions produce identical chat output.
//
// References tab: add System.dll and System.Net.Http.dll (or hit Find Refs).

using System;
using System.Net.Http;
using System.Text;
using Newtonsoft.Json.Linq;

public class CPHInline
{
    // ---- EDIT THESE TWO LINES ----
    private const string BRIDGE = "http://localhost:8787";   // bridge host as seen from the streaming PC
    private const string TOKEN  = "CHANGE_ME";               // ride.authToken from bridge/config.json

    private static readonly HttpClient http = MakeClient();
    private static HttpClient MakeClient()
    {
        var c = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        c.DefaultRequestHeaders.Add("Authorization", "Bearer " + TOKEN);
        return c;
    }

    public bool Execute()
    {
        CPH.TryGetArg("command", out string command);
        CPH.TryGetArg("rawInput", out string rawInput);
        command = (command ?? "").Trim().ToLowerInvariant();
        rawInput = (rawInput ?? "").Trim();

        try
        {
            switch (command)
            {
                case "!start_shift":
                {
                    var r = Post("/api/ride/shift/start", new JObject { ["source"] = "chat" });
                    Reply(r, ok => (bool?)ok["already"] == true
                        ? "Shift already running."
                        : "🟢 Shift started. Good hunting.");
                    return true;
                }
                case "!end_shift":
                {
                    var r = Post("/api/ride/shift/end", new JObject { ["source"] = "chat" });
                    Reply(r, ok => null); // summary line arrives via the WS relay
                    return true;
                }
                case "!start_ride":
                {
                    var r = Post("/api/ride/start", new JObject { ["source"] = "chat" });
                    Reply(r, ok =>
                    {
                        var n = ok["ride"]?["n"];
                        var warn = (string)ok["warning"];
                        return "▶ RIDE #" + n + " started." + (warn != null ? " (" + warn + ")" : "");
                    });
                    return true;
                }
                case "!end_ride":
                {
                    if (rawInput.Length == 0) { Chat("Usage: !end_ride 14.75"); return true; }
                    var r = Post("/api/ride/end", new JObject { ["source"] = "chat", ["earnings"] = rawInput });
                    Reply(r, ok => null); // ride stats line arrives via the WS relay
                    return true;
                }
                case "!add_tip":
                {
                    if (rawInput.Length == 0) { Chat("Usage: !add_tip 5"); return true; }
                    var r = Post("/api/ride/tip", new JObject { ["source"] = "chat", ["amount"] = rawInput });
                    Reply(r, ok => null); // tip line arrives via the WS relay (same as PWA tips)
                    return true;
                }
                case "!ride_stats":
                {
                    var r = Get("/api/ride/stats/chat");
                    Reply(r, ok => (string)ok["chatText"]);
                    return true;
                }
                case "!recap":
                {
                    var r = Post("/api/ride/summary/resend", new JObject());
                    Reply(r, ok => null); // resent summary arrives via the WS relay
                    return true;
                }
                default:
                    CPH.LogWarn("[nd] unknown command routed here: " + command);
                    return true;
            }
        }
        catch (Exception e)
        {
            CPH.LogWarn("[nd] bridge call failed: " + e.Message);
            Chat("⚠ Bridge unreachable — action not recorded.");
            return true;
        }
    }

    // ---- helpers ----

    private JObject Post(string path, JObject body)
    {
        body["idempotencyKey"] = Guid.NewGuid().ToString();
        var res = http.PostAsync(BRIDGE + path,
            new StringContent(body.ToString(), Encoding.UTF8, "application/json")).Result;
        return Parse(res);
    }

    private JObject Get(string path)
    {
        var res = http.GetAsync(BRIDGE + path).Result;
        return Parse(res);
    }

    private JObject Parse(HttpResponseMessage res)
    {
        var text = res.Content.ReadAsStringAsync().Result;
        JObject o;
        try { o = JObject.Parse(text); }
        catch { o = new JObject { ["ok"] = false, ["error"] = "HTTP " + (int)res.StatusCode }; }
        o["_status"] = (int)res.StatusCode;
        return o;
    }

    private void Reply(JObject r, Func<JObject, string> onOk)
    {
        if ((bool?)r["ok"] == true)
        {
            var line = onOk(r);
            if (!string.IsNullOrEmpty(line)) Chat(line);
        }
        else
        {
            var err = (string)r["error"] ?? ("error " + r["_status"]);
            Chat("⚠ " + err);
        }
    }

    private void Chat(string msg)
    {
        if (msg.Length > 490) msg = msg.Substring(0, 490);
        CPH.SendMessage(msg, true);
    }
}
