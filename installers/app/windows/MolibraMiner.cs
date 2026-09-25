// Molibra Miner - the application window (Windows).
//
// A native Windows Forms program, compiled by the C# compiler that ships with
// Windows (.NET Framework 4.x), with no third-party libraries. It only READS:
// the miner's own status (http://127.0.0.1:20227/status), its log files, and
// public figures from molibra.org. It never touches a private key and never
// sends anything anywhere.
//
// If the miner is not running, it starts it: first the boot task, then the
// supervisor directly. If it still cannot, it shows the log so the person can
// see why - instead of a browser error.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Molibra Miner")]
[assembly: System.Reflection.AssemblyProduct("Molibra Miner")]
[assembly: System.Reflection.AssemblyCompany("Molibra")]
[assembly: System.Reflection.AssemblyDescription("Shows the Molibra Miner's progress")]
[assembly: System.Reflection.AssemblyVersion("1.0.3.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.3.0")]

namespace Molibra
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            bool first;
            using (var one = new Mutex(true, "Local\\MolibraMinerWindow", out first))
            {
                if (!first) return; // one window is enough
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MinerWindow());
            }
        }
    }

    sealed class MinerWindow : Form
    {
        static readonly Color Bg = Color.FromArgb(11, 11, 12), Panel = Color.FromArgb(22, 22, 25),
            Ink = Color.FromArgb(236, 236, 240), Dim = Color.FromArgb(139, 139, 148),
            Gold = Color.FromArgb(255, 209, 0), Ok = Color.FromArgb(74, 222, 128), Bad = Color.FromArgb(255, 92, 92);

        readonly string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 3000 };

        Label state, detail, eta, balance, found, height, network;
        TextBox wallet, log;
        ProgressBar bar;
        string miner;
        bool busy, triedStart;
        long? netHeight;
        DateTime netAt = DateTime.MinValue;
        int? firstH; DateTime firstT;

        public MinerWindow()
        {
            Text = "Molibra Miner";
            BackColor = Bg; ForeColor = Ink;
            Font = new Font("Segoe UI", 10f);
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(560, 640);
            MinimumSize = new Size(480, 560);
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            var title = L("⛏  MOLIBRA MINER", 16f, FontStyle.Bold, Gold); title.SetBounds(20, 16, 500, 32);
            var sub = L("Runs in the background · closing this window does not stop mining", 9f, FontStyle.Regular, Dim);
            sub.SetBounds(22, 50, 520, 20);

            var p1 = Card(20, 80, 104);
            state = L("Connecting…", 17f, FontStyle.Bold, Gold); state.SetBounds(14, 10, 490, 32); p1.Controls.Add(state);
            detail = L("", 9.5f, FontStyle.Regular, Dim); detail.SetBounds(14, 42, 490, 20); p1.Controls.Add(detail);
            bar = new ProgressBar { Style = ProgressBarStyle.Continuous, Maximum = 100 }; bar.SetBounds(14, 66, 490, 12); p1.Controls.Add(bar);
            eta = L("", 9f, FontStyle.Regular, Dim); eta.SetBounds(14, 80, 490, 18); p1.Controls.Add(eta);

            var p2 = Card(20, 196, 214);
            int y = 12;
            balance = Row(p2, "Balance", ref y, 15f, Gold);
            found = Row(p2, "Blocks found here", ref y);
            height = Row(p2, "Blocks on this computer", ref y);
            network = Row(p2, "Blocks on the network", ref y);
            var wl = L("Your wallet", 9.5f, FontStyle.Regular, Dim); wl.SetBounds(14, y + 2, 170, 22); p2.Controls.Add(wl);
            wallet = new TextBox { ReadOnly = true, BorderStyle = BorderStyle.None, BackColor = Panel, ForeColor = Ink, Font = new Font("Consolas", 9.5f) };
            wallet.SetBounds(186, y + 4, 316, 20); p2.Controls.Add(wallet);
            y += 30;
            var copy = Btn("Copy address", 186, y, 140); copy.Click += (s, e) => { if (!string.IsNullOrEmpty(miner)) Clipboard.SetText(miner); };
            var open = Btn("See it on molibra.org", 334, y, 168);
            open.Click += (s, e) => { if (!string.IsNullOrEmpty(miner)) Process.Start("https://molibra.org/molibra/moliscan/address/" + miner); };
            p2.Controls.Add(copy); p2.Controls.Add(open);

            var about = L("Mining starts with the computer and keeps going after you log off. It uses about one processor core at " +
                          "low priority. A sleeping computer does not mine. How many blocks you find depends on your share of all " +
                          "the computers mining; the first can take a while. Nothing here promises any amount or value.",
                          9f, FontStyle.Regular, Dim);
            about.SetBounds(22, 420, 520, 62);

            var details = L("Technical details", 9f, FontStyle.Underline, Dim); details.SetBounds(22, 486, 200, 18);
            details.Cursor = Cursors.Hand;
            log = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, BackColor = Panel, ForeColor = Dim,
                                BorderStyle = BorderStyle.FixedSingle, Font = new Font("Consolas", 8.5f), Visible = false };
            log.SetBounds(20, 508, 520, 120);
            log.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            details.Click += (s, e) => { log.Visible = !log.Visible; };

            Controls.AddRange(new Control[] { title, sub, p1, p2, about, details, log });
            timer.Tick += async (s, e) => await Tick();
            Shown += async (s, e) => { timer.Start(); await Tick(); };
        }

        // ------------------------------------------------------------ layout helpers
        Label L(string t, float size, FontStyle st, Color c)
        {
            return new Label { Text = t, AutoSize = false, ForeColor = c, BackColor = Color.Transparent, Font = new Font("Segoe UI", size, st) };
        }
        Panel Card(int x, int y, int h)
        {
            var p = new Panel { BackColor = Panel }; p.SetBounds(x, y, 520, h);
            p.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            return p;
        }
        Label Row(Panel p, string name, ref int y, float size = 10f, Color? c = null)
        {
            var n = L(name, 9.5f, FontStyle.Regular, Dim); n.SetBounds(14, y + 2, 170, 22);
            var v = L("—", size, size > 11 ? FontStyle.Bold : FontStyle.Regular, c ?? Ink); v.SetBounds(186, y, 320, size > 11 ? 30 : 24);
            p.Controls.Add(n); p.Controls.Add(v);
            y += size > 11 ? 36 : 28;
            return v;
        }
        Button Btn(string t, int x, int y, int w)
        {
            var b = new Button { Text = t, FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(34, 34, 42), ForeColor = Ink, Font = new Font("Segoe UI", 9f) };
            b.FlatAppearance.BorderColor = Color.FromArgb(60, 60, 70);
            b.SetBounds(x, y, w, 30);
            return b;
        }

        // -------------------------------------------------------------- the data
        static string Get(string url, int timeoutMs)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = timeoutMs; req.ReadWriteTimeout = timeoutMs;
            using (var res = req.GetResponse()) using (var r = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) return r.ReadToEnd();
        }
        static string Post(string url, string body, int timeoutMs)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST"; req.ContentType = "application/json"; req.Timeout = timeoutMs;
            var b = Encoding.UTF8.GetBytes(body);
            using (var s = req.GetRequestStream()) s.Write(b, 0, b.Length);
            using (var res = req.GetResponse()) using (var r = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) return r.ReadToEnd();
        }
        static string Fmt(decimal v) { return v.ToString("#,0.####"); }

        string LogTail(string file, int n)
        {
            try
            {
                var lines = File.ReadAllLines(Path.Combine(root, "logs", file));
                return string.Join(Environment.NewLine, lines.Skip(Math.Max(0, lines.Length - n)));
            }
            catch { return ""; }
        }

        void StartMiner()
        {
            // The boot task first (it runs as this user, whether or not anyone is logged on) ...
            try { Process.Start(new ProcessStartInfo("schtasks.exe", "/Run /TN \"Molibra Miner\"") { CreateNoWindow = true, UseShellExecute = false }); } catch { }
            // ... and if that has not answered within 25 seconds, the supervisor directly.
            Task.Delay(25000).ContinueWith(_ =>
            {
                try { Get("http://127.0.0.1:20227/status", 2000); return; } catch { }
                try
                {
                    Process.Start(new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"), "\"" + Path.Combine(root, "molibra-miner.mjs") + "\"")
                        { WorkingDirectory = root, CreateNoWindow = true, UseShellExecute = false });
                }
                catch { }
            });
        }

        async Task Tick()
        {
            if (busy) return;
            busy = true;
            try
            {
                Dictionary<string, object> s = null;
                try { s = await Task.Run(() => json.Deserialize<Dictionary<string, object>>(Get("http://127.0.0.1:20227/status", 2500))); }
                catch { }
                if (s == null) { NotAnswering(); return; }
                silent = 0;
                ShowStatus(s);
                if (!string.IsNullOrEmpty(miner) && DateTime.Now - netAt > TimeSpan.FromSeconds(15)) await Network();
            }
            finally { busy = false; }
        }

        int silent;
        void NotAnswering()
        {
            if (!triedStart) { triedStart = true; StartMiner(); }
            // After ~30 s of silence, show the log without being asked: the reason is in it.
            if (++silent > 10) log.Visible = true;
            state.Text = "Starting the miner…"; state.ForeColor = Gold;
            detail.Text = "The miner was not running, so it is being started. This can take a minute.";
            var tail = LogTail("miner.log", 12);
            if (tail.Contains("FATAL"))
            {
                state.Text = "The miner could not start"; state.ForeColor = Bad;
                detail.Text = "Restart the computer. If this stays, send a photo of the technical details.";
                log.Visible = true;
            }
            log.Text = tail;
        }

        void ShowStatus(Dictionary<string, object> s)
        {
            string phase = s["phase"] as string ?? "";
            bool mining = s["mining"] is bool && (bool)s["mining"];
            miner = s["miner"] as string;
            long h = s["height"] == null ? 0 : Convert.ToInt64(s["height"]);
            long n = netHeight ?? (s["networkHeight"] == null ? 0 : Convert.ToInt64(s["networkHeight"]));
            int pct = mining ? 100 : (h > 0 && n > 0 ? (int)Math.Min(99, 100 * h / n) : 0);

            switch (phase)
            {
                case "mining": state.Text = "⛏  Mining"; state.ForeColor = Ok; break;
                case "catching-up": state.Text = "Catching up — " + pct + "%"; state.ForeColor = Gold; break;
                case "updating": state.Text = "Updating…"; state.ForeColor = Gold; break;
                case "loading": state.Text = "Loading…"; state.ForeColor = Gold; break;
                case "problem": state.Text = "Problem"; state.ForeColor = Bad; break;
                default: state.Text = "Starting…"; state.ForeColor = Gold; break;
            }
            string err = s["error"] as string;
            detail.Text = (s["detail"] as string ?? "") + (phase == "problem" && !string.IsNullOrEmpty(err) ? " (" + err + ")" : "");
            bar.Value = Math.Max(0, Math.Min(100, pct));

            if (phase == "catching-up" && h > 0)
            {
                if (firstH == null) { firstH = (int)h; firstT = DateTime.Now; }
                double mins = (DateTime.Now - firstT).TotalMinutes;
                double rate = mins > 0.2 ? (h - firstH.Value) / mins : 0;
                eta.Text = rate > 50 && n > h ? "About " + Math.Max(1, (int)Math.Round((n - h) / rate)) + " minutes left" : "";
            }
            else eta.Text = "";

            height.Text = h > 0 ? h.ToString("#,0") : "—";
            network.Text = n > 0 ? n.ToString("#,0") : "—";
            var mined = s["minedThisSession"] as System.Collections.ArrayList;
            int count = mined == null ? 0 : mined.Count;
            found.Text = count > 0 ? count + " since the miner started"
                       : (mining ? "none yet — keep it running" : "mining has not started yet");
            if (!string.IsNullOrEmpty(miner) && wallet.Text != miner) wallet.Text = miner;

            var lines = new List<string>();
            foreach (var key in new[] { "log", "nodeLog" })
                if (s.ContainsKey(key) && s[key] is System.Collections.ArrayList)
                    foreach (var l in (System.Collections.ArrayList)s[key]) lines.Add(l.ToString());
            lines.Add(""); lines.Add("version " + ((s["commit"] as string) ?? "?").Substring(0, Math.Min(7, ((s["commit"] as string) ?? "?").Length)));
            log.Text = string.Join(Environment.NewLine, lines);
        }

        async Task Network()
        {
            netAt = DateTime.Now;
            try
            {
                var st = await Task.Run(() => json.Deserialize<Dictionary<string, object>>(Get("https://molibra.org/molibra", 8000)));
                netHeight = Convert.ToInt64(st["height"]);
                var r = await Task.Run(() => json.Deserialize<Dictionary<string, object>>(Post("https://molibra.org",
                    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"" + miner + "\",\"latest\"]}", 8000)));
                var hex = (r["result"] as string ?? "0x0").Substring(2);
                var wei = System.Numerics.BigInteger.Parse("0" + hex, System.Globalization.NumberStyles.HexNumber);
                balance.Text = Fmt((decimal)(wei / System.Numerics.BigInteger.Pow(10, 14)) / 10000m) + " MOLI";
            }
            catch { balance.Text = "cannot reach molibra.org"; }
        }
    }
}
