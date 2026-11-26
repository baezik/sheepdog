import Foundation

/// Runs the Sheepdog server (Node) as a child process on a free localhost port.
/// The app bundle carries its own Node runtime, so nothing has to be installed.
final class ServerProcess {
    private var process: Process?
    private var stdinPipe: Pipe?
    private var stopping = false
    private var recentExits: [Date] = []
    private var lineBuffer = ""
    private let logHandle: FileHandle?

    private(set) var port: Int?
    private(set) var lastError: String?
    var onReady: ((Int) -> Void)?
    var onStopped: ((String) -> Void)?

    let logURL: URL

    init() {
        let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Sheepdog")
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        logURL = logs.appendingPathComponent("server.log")
        // keep the log small: start fresh when it passes 2 MB
        if let size = (try? FileManager.default.attributesOfItem(atPath: logURL.path)[.size] as? Int), size > 2_000_000 {
            try? FileManager.default.removeItem(at: logURL)
        }
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        logHandle = try? FileHandle(forWritingTo: logURL)
        logHandle?.seekToEndOfFile()
    }

    /// Bundled layout: Contents/Resources/runtime/node and Contents/Resources/app/server/index.mjs.
    /// During development, SHEEPDOG_ROOT points at the sheepdog folder and `node` comes from PATH.
    private func locate() -> (node: URL, args: [String])? {
        let fm = FileManager.default
        if let res = Bundle.main.resourceURL {
            let node = res.appendingPathComponent("runtime/node")
            let entry = res.appendingPathComponent("app/server/index.mjs")
            if fm.isExecutableFile(atPath: node.path), fm.fileExists(atPath: entry.path) {
                return (node, [entry.path])
            }
        }
        if let root = ProcessInfo.processInfo.environment["SHEEPDOG_ROOT"] {
            let entry = URL(fileURLWithPath: root).appendingPathComponent("server/index.mjs")
            return (URL(fileURLWithPath: "/usr/bin/env"), ["node", entry.path])
        }
        return nil
    }

    func start() {
        stopping = false
        port = nil
        guard let (node, args) = locate() else {
            fail("Sheepdog’s server files are missing from the app. Reinstall Sheepdog.")
            return
        }
        let p = Process()
        p.executableURL = node
        p.arguments = args

        // Apps opened from Finder get a minimal PATH; add the usual places for gh, python3 and friends.
        var env = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()
        let extra = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        env["PATH"] = (extra + (env["PATH"]?.split(separator: ":").map(String.init) ?? [])).reduce(into: [String]()) {
            if !$0.contains($1) { $0.append($1) }
        }.joined(separator: ":")
        env["SHEEPDOG_PORT"] = "0"
        env["SHEEPDOG_APP"] = "1"
        p.environment = env

        let out = Pipe()
        let input = Pipe()
        p.standardOutput = out
        p.standardError = out
        p.standardInput = input  // the server exits when this pipe closes, i.e. when the app goes away
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty else { return }
            self?.logHandle?.write(data)
            if let text = String(data: data, encoding: .utf8) {
                DispatchQueue.main.async { self?.scan(text) }
            }
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.exited(code: proc.terminationStatus) }
        }
        do {
            try p.run()
            process = p
            stdinPipe = input
            lastError = nil
        } catch {
            fail("Couldn’t start Sheepdog’s server: \(error.localizedDescription)")
        }
    }

    private func scan(_ text: String) {
        lineBuffer += text
        while let nl = lineBuffer.firstIndex(of: "\n") {
            let line = String(lineBuffer[..<nl])
            lineBuffer.removeSubrange(...nl)
            if line.hasPrefix("SHEEPDOG_READY port="), let n = Int(line.dropFirst("SHEEPDOG_READY port=".count)) {
                port = n
                onReady?(n)
            } else if line.contains("Error") || line.contains("in use") {
                lastError = line.trimmingCharacters(in: .whitespaces)
            }
        }
    }

    private func exited(code: Int32) {
        process = nil
        port = nil
        if stopping { return }
        // restart, unless it keeps dying
        let now = Date()
        recentExits = recentExits.filter { now.timeIntervalSince($0) < 60 } + [now]
        if recentExits.count >= 4 {
            fail("Sheepdog’s server keeps stopping (exit \(code)). \(lastError ?? "See the log for details.")")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.start() }
    }

    private func fail(_ message: String) {
        lastError = message
        onStopped?(message)
    }

    func restart() {
        recentExits.removeAll()
        if let p = process, p.isRunning {
            stopping = true
            p.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.process = nil; self?.start() } }
            p.terminate()
        } else {
            start()
        }
    }

    func stop() {
        stopping = true
        process?.terminate()
        try? stdinPipe?.fileHandleForWriting.close()
    }

    var isRunning: Bool { process?.isRunning == true && port != nil }
}
