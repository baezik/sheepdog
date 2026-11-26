import Foundation

/// Talks to the local Sheepdog server.
final class Api {
    var port: Int?
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 8
        return URLSession(configuration: c)
    }()

    var baseURL: URL? { port.map { URL(string: "http://127.0.0.1:\($0)")! } }

    func state(_ done: @escaping ([String: Any]?) -> Void) {
        guard let base = baseURL else { done(nil); return }
        session.dataTask(with: base.appendingPathComponent("api/state")) { data, _, _ in
            let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async { done(obj) }
        }.resume()
    }

    func post(_ path: String, _ body: [String: Any], _ done: (([String: Any]?) -> Void)? = nil) {
        guard let base = baseURL else { done?(nil); return }
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        session.dataTask(with: req) { data, _, _ in
            let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async { done?(obj) }
        }.resume()
    }

    func focus(_ key: String, _ done: ((Bool, String?) -> Void)? = nil) {
        post("api/focus", ["key": key]) { r in done?(r?["ok"] as? Bool ?? false, r?["error"] as? String) }
    }
}

/// One agent as the menu shows it. Mirrors the board's rules (public/app.js agentsOf).
struct Agent {
    enum Status: Int { case turn = 0, working = 1, idle = 2 }
    let key: String
    let focusKey: String
    let focusable: Bool
    let title: String
    let ticket: String?
    let host: String
    let kind: String
    let status: Status
    let seconds: Double

    static func list(from state: [String: Any]) -> [Agent] {
        let settings = state["settings"] as? [String: Any]
        let idleAfter = ((settings?["idleMinutes"] as? Double) ?? 30) * 60
        var out: [Agent] = []
        for h in state["hosts"] as? [[String: Any]] ?? [] {
            guard h["enabled"] as? Bool == true else { continue }
            let hostId = h["id"] as? String ?? ""
            let hostName = h["name"] as? String ?? hostId
            let now = (h["now"] as? Double) ?? ((state["now"] as? Double ?? 0) / 1000)
            for a in h["agents"] as? [[String: Any]] ?? [] {
                if a["headless"] as? Bool == true || !(a["parent"] is NSNull || a["parent"] == nil) { continue }
                let since = (a["stateSince"] as? Double) ?? (a["lastActivity"] as? Double) ?? (a["started"] as? Double) ?? now
                let waited = max(0, now - since)
                let working = (a["state"] as? String) == "working"
                let status: Status = working ? .working : (waited >= idleAfter ? .idle : .turn)
                let pid = (a["pid"] as? Int).map(String.init) ?? ""
                let sid = a["sessionId"] as? String ?? pid
                let kind = (a["kind"] as? String) == "codex" ? "Codex" : "Claude"
                let title = (a["title"] as? String) ?? (a["prompt"] as? String) ?? "\(kind) in \(a["repo"] as? String ?? "?")"
                out.append(Agent(key: "\(hostId):\(sid)", focusKey: pid.isEmpty ? "" : "\(hostId):\(pid)",
                                 focusable: a["focusable"] as? Bool ?? false, title: title, ticket: a["ticket"] as? String,
                                 host: hostName, kind: kind, status: status, seconds: waited))
            }
        }
        return out.sorted {
            if $0.status != $1.status { return $0.status.rawValue < $1.status.rawValue }
            return $0.status == .working ? $0.seconds < $1.seconds : $0.seconds > $1.seconds
        }
    }
}

func shortDuration(_ sec: Double) -> String {
    let s = Int(sec.rounded())
    if s < 60 { return "\(s)s" }
    let m = s / 60
    if m < 60 { return "\(m)m" }
    let h = m / 60
    if h < 24 { return "\(h)h" }
    return "\(h / 24)d"
}
