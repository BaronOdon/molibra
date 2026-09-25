// Molibra Miner - the application window (macOS).
//
// A native SwiftUI app. It only READS: the miner's own status
// (http://127.0.0.1:20227/status), its log file, and public figures from
// molibra.org. It never touches a private key and never sends anything.
// If the miner is not answering, it starts the supervisor itself (as this user)
// and, if that fails too, shows the log so the person can see why.

import SwiftUI
import AppKit

@main
struct MolibraMinerApp: App {
    var body: some Scene {
        WindowGroup("Molibra Miner") {
            MinerView()
                .frame(minWidth: 480, idealWidth: 560, minHeight: 600, idealHeight: 660)
        }
        .windowStyle(.hiddenTitleBar)
    }
}

let gold = Color(red: 1, green: 0.82, blue: 0)
let dim = Color(red: 0.55, green: 0.55, blue: 0.58)
let okGreen = Color(red: 0.29, green: 0.87, blue: 0.5)
let bad = Color(red: 1, green: 0.36, blue: 0.36)
let panel = Color(red: 0.086, green: 0.086, blue: 0.098)
let root = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Molibra")

final class Model: ObservableObject {
    @Published var state = "Connecting…"
    @Published var stateColor = gold
    @Published var detail = ""
    @Published var pct = 0.0
    @Published var eta = ""
    @Published var balance = "—"
    @Published var found = "—"
    @Published var height = "—"
    @Published var network = "—"
    @Published var wallet = ""
    @Published var log = ""

    private var netHeight: Int?
    private var netAt = Date.distantPast
    private var first: (h: Int, t: Date)?
    private var failures = 0
    private var startedSupervisor = false

    func tick() {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:20227/status")!)
        req.timeoutInterval = 2.5
        URLSession.shared.dataTask(with: req) { data, _, _ in
            let s = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async { s == nil ? self.notAnswering() : self.show(s!) }
        }.resume()
        if !wallet.isEmpty && Date().timeIntervalSince(netAt) > 15 { fetchNetwork() }
    }

    private func logTail(_ n: Int) -> String {
        guard let text = try? String(contentsOf: root.appendingPathComponent("logs/miner.log"), encoding: .utf8) else { return "" }
        return text.split(separator: "\n").suffix(n).joined(separator: "\n")
    }

    private func notAnswering() {
        failures += 1
        state = "Starting the miner…"; stateColor = gold
        detail = "The miner is starting. This can take a minute."
        // After ~25 s of silence, run the supervisor directly as this user.
        if failures >= 8 && !startedSupervisor {
            startedSupervisor = true
            let p = Process()
            p.executableURL = root.appendingPathComponent("runtime/bin/node")
            p.arguments = [root.appendingPathComponent("molibra-miner.mjs").path]
            p.currentDirectoryURL = root
            try? p.run()
        }
        let tail = logTail(12)
        if failures > 40 || tail.contains("FATAL") {
            state = "The miner could not start"; stateColor = bad
            detail = "Restart the Mac. If this stays, send a photo of the technical details."
        }
        log = tail
    }

    private func show(_ s: [String: Any]) {
        failures = 0
        let phase = s["phase"] as? String ?? ""
        let mining = s["mining"] as? Bool ?? false
        wallet = s["miner"] as? String ?? wallet
        let h = s["height"] as? Int ?? 0
        let n = netHeight ?? (s["networkHeight"] as? Int ?? 0)
        let p = mining ? 100 : (h > 0 && n > 0 ? min(99, 100 * h / n) : 0)
        pct = Double(p) / 100
        switch phase {
        case "mining": state = "⛏  Mining"; stateColor = okGreen
        case "catching-up": state = "Catching up — \(p)%"; stateColor = gold
        case "updating": state = "Updating…"; stateColor = gold
        case "loading": state = "Loading…"; stateColor = gold
        case "problem": state = "Problem"; stateColor = bad
        default: state = "Starting…"; stateColor = gold
        }
        let err = s["error"] as? String ?? ""
        detail = (s["detail"] as? String ?? "") + (phase == "problem" && !err.isEmpty ? " (\(err))" : "")
        if phase == "catching-up" && h > 0 {
            if first == nil { first = (h, Date()) }
            let mins = Date().timeIntervalSince(first!.t) / 60
            let rate = mins > 0.2 ? Double(h - first!.h) / mins : 0
            eta = rate > 50 && n > h ? "About \(max(1, Int((Double(n - h) / rate).rounded()))) minutes left" : ""
        } else { eta = "" }
        height = h > 0 ? h.formatted() : "—"
        network = n > 0 ? n.formatted() : "—"
        let count = (s["minedThisSession"] as? [Any])?.count ?? 0
        found = count > 0 ? "\(count) since the miner started" : (mining ? "none yet — keep it running" : "mining has not started yet")
        let lines = ((s["log"] as? [String]) ?? []) + [""] + ((s["nodeLog"] as? [String]) ?? [])
        let commit = (s["commit"] as? String ?? "?").prefix(7)
        log = lines.joined(separator: "\n") + "\n\nversion \(commit)"
    }

    private func fetchNetwork() {
        netAt = Date()
        URLSession.shared.dataTask(with: URL(string: "https://molibra.org/molibra")!) { data, _, _ in
            if let d = data, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let h = j["height"] as? Int {
                DispatchQueue.main.async { self.netHeight = h }
            }
        }.resume()
        var req = URLRequest(url: URL(string: "https://molibra.org")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"\(wallet)\",\"latest\"]}".data(using: .utf8)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            var text = "cannot reach molibra.org"
            if let d = data, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let hex = j["result"] as? String {
                text = Model.formatMoli(hex) + " MOLI"
            }
            DispatchQueue.main.async { self.balance = text }
        }.resume()
    }

    /// Wei (hex) -> MOLI with up to 4 decimals, exactly, without floating point.
    static func formatMoli(_ hex: String) -> String {
        var v = Decimal(0)
        for c in hex.dropFirst(2) { v = v * 16 + Decimal(Int(String(c), radix: 16) ?? 0) }
        var moli = v / pow(Decimal(10), 18)
        var rounded = Decimal()
        NSDecimalRound(&rounded, &moli, 4, .down)
        let f = NumberFormatter()
        f.numberStyle = .decimal; f.maximumFractionDigits = 4
        return f.string(from: rounded as NSDecimalNumber) ?? "\(rounded)"
    }
}

struct Row: View {
    let name: String; let value: String; var big = false
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(name).foregroundColor(dim).frame(width: 170, alignment: .leading)
            Text(value).font(big ? .title2.bold() : .body).foregroundColor(big ? gold : .white).textSelection(.enabled)
            Spacer()
        }
    }
}

struct MinerView: View {
    @StateObject var m = Model()
    @State var showLog = false
    let timer = Timer.publish(every: 3, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("⛏  MOLIBRA MINER").font(.title2.bold()).foregroundColor(gold)
                Text("Runs in the background · closing this window does not stop mining").font(.caption).foregroundColor(dim)

                VStack(alignment: .leading, spacing: 6) {
                    Text(m.state).font(.title.bold()).foregroundColor(m.stateColor)
                    Text(m.detail).foregroundColor(dim).font(.callout)
                    ProgressView(value: m.pct).tint(gold)
                    if !m.eta.isEmpty { Text(m.eta).foregroundColor(dim).font(.caption) }
                }.padding(14).background(panel).cornerRadius(10)

                VStack(alignment: .leading, spacing: 8) {
                    Row(name: "Balance", value: m.balance, big: true)
                    Row(name: "Blocks found here", value: m.found)
                    Row(name: "Blocks on this Mac", value: m.height)
                    Row(name: "Blocks on the network", value: m.network)
                    Row(name: "Your wallet", value: m.wallet.isEmpty ? "—" : m.wallet)
                    HStack {
                        Spacer().frame(width: 170)
                        Button("Copy address") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(m.wallet, forType: .string)
                        }.disabled(m.wallet.isEmpty)
                        Button("See it on molibra.org") {
                            NSWorkspace.shared.open(URL(string: "https://molibra.org/molibra/moliscan/address/\(m.wallet)")!)
                        }.disabled(m.wallet.isEmpty)
                    }
                }.padding(14).background(panel).cornerRadius(10)

                Text("Mining starts with the Mac and keeps going after you log out. It uses about one processor core at low priority. A sleeping Mac does not mine. How many blocks you find depends on your share of all the computers mining; the first can take a while. Nothing here promises any amount or value.")
                    .font(.caption).foregroundColor(dim)

                DisclosureGroup("Technical details", isExpanded: $showLog) {
                    Text(m.log).font(.system(.caption2, design: .monospaced)).foregroundColor(dim)
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }.foregroundColor(dim)
            }.padding(20)
        }
        .background(Color(red: 0.043, green: 0.043, blue: 0.047))
        .preferredColorScheme(.dark)
        .onAppear { m.tick() }
        .onReceive(timer) { _ in m.tick() }
    }
}
