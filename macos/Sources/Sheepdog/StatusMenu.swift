import AppKit

/// The menu bar icon and its dropdown (design 1a: grouped list).
/// Icon: the app icon's prompt chevron and three bars as a menu bar glyph (dimmed when nothing is running),
/// amber count when agents wait, red queue when a machine is overloaded.
final class StatusMenu: NSObject, NSMenuDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private var agents: [Agent] = []
    private var overload: (name: String, queue: Int)?
    private var serverProblem: String?
    private var barking = false

    var onFocus: ((Agent) -> Void)?
    var onOpenBoard: (() -> Void)?
    var onSettings: (() -> Void)?
    var onSetup: (() -> Void)?
    var onRestartServer: (() -> Void)?
    var onShowLog: (() -> Void)?
    var loginItemEnabled: () -> Bool = { false }
    var onToggleLoginItem: (() -> Void)?
    var onCheckForUpdates: (() -> Void)?
    /// (current version, newer version waiting or nil); nil when updates aren't available (dev builds)
    var updateInfo: () -> (current: String, available: String?)? = { nil }

    static let amber = NSColor(srgbRed: 0.96, green: 0.65, blue: 0.14, alpha: 1)
    static let green = NSColor(srgbRed: 0.24, green: 0.84, blue: 0.55, alpha: 1)
    static let red = NSColor(srgbRed: 0.95, green: 0.33, blue: 0.35, alpha: 1)

    override init() {
        super.init()
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        item.button?.toolTip = "Sheepdog"
        redrawIcon()
    }

    func update(state: [String: Any]?) {
        if let state {
            serverProblem = nil
            agents = Agent.list(from: state)
            overload = nil
            for h in state["hosts"] as? [[String: Any]] ?? [] where h["enabled"] as? Bool == true {
                let load = (h["load"] as? [Double])?.first ?? 0
                let ncpu = h["ncpu"] as? Double ?? 0
                guard ncpu > 0 else { continue }
                let queue = Int((load - ncpu).rounded())
                if queue >= 4, queue > (overload?.queue ?? 0) { overload = (h["name"] as? String ?? "", queue) }
            }
        }
        redrawIcon()
    }

    func refreshIcon() { redrawIcon() }

    func serverDown(_ message: String) {
        serverProblem = message
        redrawIcon()
    }

    // ------------------------------------------------------------ icon
    /// The glyph, drawn from the app icon's 120×120 design (chevron + three bars), as a template image so macOS
    /// tints it for light and dark menu bars. `nudge` moves the chevron right (the "bark").
    static func glyph(dimmed: Bool, nudge: CGFloat = 0) -> NSImage {
        let k: CGFloat = 14.5 / 43 // design units -> points: the glyph's 43-unit height fills 14.5pt
        let size = NSSize(width: 68 * k + 2, height: 18)
        let img = NSImage(size: size, flipped: true) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            ctx.translateBy(x: 1 - 26.5 * k, y: (18 - 43 * k) / 2 - 38.5 * k)
            ctx.scaleBy(x: k, y: k)
            ctx.setStrokeColor(NSColor.black.withAlphaComponent(dimmed ? 0.5 : 1).cgColor)
            ctx.setLineCap(.round); ctx.setLineJoin(.round)
            ctx.setLineWidth(7)
            ctx.move(to: CGPoint(x: 30 + nudge, y: 42)); ctx.addLine(to: CGPoint(x: 48 + nudge, y: 60)); ctx.addLine(to: CGPoint(x: 30 + nudge, y: 78))
            ctx.strokePath()
            ctx.setLineWidth(6.5)
            for (y, x2) in [(44.0, 90.0), (60.0, 84.0), (76.0, 78.0)] as [(CGFloat, CGFloat)] {
                ctx.move(to: CGPoint(x: 60, y: y)); ctx.addLine(to: CGPoint(x: x2, y: y)); ctx.strokePath()
            }
            return true
        }
        img.isTemplate = true
        img.accessibilityDescription = "Sheepdog"
        return img
    }

    private func redrawIcon() {
        guard let button = item.button, !barking else { return }
        let waiting = agents.filter { $0.status == .turn }.count
        let s = NSMutableAttributedString()
        let font = NSFont.menuBarFont(ofSize: 0)
        let asleep = waiting == 0 && (agents.isEmpty || agents.allSatisfy { $0.status == .idle })
        button.image = Self.glyph(dimmed: asleep)
        button.imagePosition = .imageLeft
        if serverProblem != nil {
            s.append(NSAttributedString(string: " !", attributes: [.font: NSFont.boldSystemFont(ofSize: font.pointSize), .foregroundColor: Self.red]))
        } else {
            if waiting > 0 {
                s.append(NSAttributedString(string: " \(waiting)", attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: font.pointSize, weight: .bold), .foregroundColor: Self.amber]))
            }
            if let o = overload {
                s.append(NSAttributedString(string: " ⧗\(o.queue)", attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: font.pointSize - 1, weight: .semibold), .foregroundColor: Self.red]))
            }
        }
        if updateInfo()?.available != nil {
            s.append(NSAttributedString(string: " •", attributes: [.font: font, .foregroundColor: NSColor.controlAccentColor]))
        }
        button.attributedTitle = s
        button.toolTip = serverProblem ?? (waiting > 0 ? "\(waiting) agent\(waiting == 1 ? "" : "s") waiting for you" : "Sheepdog: nothing needs you")
    }

    /// The icon "barks" once when a new agent turns amber: the chevron jumps forward twice.
    func bark() {
        guard let button = item.button, !barking else { return }
        barking = true
        let frames: [CGFloat] = [4, 0, 4, 0]
        for (i, nudge) in frames.enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(180 * i)) {
                button.image = Self.glyph(dimmed: false, nudge: nudge)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(180 * frames.count)) { [weak self] in
            self?.barking = false
            self?.redrawIcon()
        }
    }

    // ------------------------------------------------------------ dropdown
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        if let new = updateInfo()?.available {
            let up = action("Update to Sheepdog \(new)…", #selector(checkForUpdates))
            up.attributedTitle = NSAttributedString(string: up.title, attributes: [
                .font: NSFont.menuFont(ofSize: 13).withWeight(.semibold), .foregroundColor: NSColor.controlAccentColor])
            menu.addItem(up)
            menu.addItem(.separator())
        }
        if let problem = serverProblem {
            let i = NSMenuItem(title: problem, action: nil, keyEquivalent: "")
            i.isEnabled = false
            menu.addItem(i)
            menu.addItem(action("Restart Sheepdog", #selector(restartServer)))
            menu.addItem(action("Show Log", #selector(showLog)))
            menu.addItem(.separator())
        } else if agents.isEmpty {
            let i = NSMenuItem(title: "No agents running", action: nil, keyEquivalent: "")
            i.isEnabled = false
            menu.addItem(i)
            menu.addItem(.separator())
        } else {
            for (status, label, color) in [(Agent.Status.turn, "Your turn", Self.amber), (.working, "Working", Self.green), (.idle, "Idle", NSColor.secondaryLabelColor)] {
                let group = agents.filter { $0.status == status }
                guard !group.isEmpty else { continue }
                let header = NSMenuItem(title: "", action: nil, keyEquivalent: "")
                header.attributedTitle = NSAttributedString(string: "\(label) · \(group.count)", attributes: [
                    .font: NSFont.systemFont(ofSize: 11.5, weight: .semibold), .foregroundColor: status == .turn ? color : NSColor.secondaryLabelColor])
                header.isEnabled = false
                menu.addItem(header)
                for a in group.prefix(12) { menu.addItem(agentItem(a, color: color)) }
                if group.count > 12 {
                    let more = NSMenuItem(title: "\(group.count - 12) more on the board…", action: #selector(openBoard), keyEquivalent: "")
                    more.target = self
                    menu.addItem(more)
                }
                menu.addItem(.separator())
            }
        }
        menu.addItem(action("Open Board", #selector(openBoard), key: "b"))
        menu.addItem(action("Settings…", #selector(settings), key: ","))
        menu.addItem(action("Run Setup Again…", #selector(setup)))
        menu.addItem(.separator())
        let login = action("Open at Login", #selector(toggleLogin))
        login.state = loginItemEnabled() ? .on : .off
        menu.addItem(login)
        if let info = updateInfo() {
            menu.addItem(action("Check for Updates…", #selector(checkForUpdates)))
            let v = NSMenuItem(title: "Version \(info.current)", action: nil, keyEquivalent: "")
            v.isEnabled = false
            menu.addItem(v)
        }
        menu.addItem(.separator())
        menu.addItem(action("Quit Sheepdog", #selector(quit), key: "q"))
    }

    private func agentItem(_ a: Agent, color: NSColor) -> NSMenuItem {
        let i = NSMenuItem(title: a.title, action: #selector(focusAgent(_:)), keyEquivalent: "")
        i.target = self
        i.representedObject = a.key
        let para = NSMutableParagraphStyle()
        para.tabStops = [NSTextTab(textAlignment: .left, location: 82), NSTextTab(textAlignment: .right, location: 380)]
        para.lineBreakMode = .byTruncatingTail
        let dim = a.status == .idle
        let t = NSMutableAttributedString()
        t.append(NSAttributedString(string: "● ", attributes: [.foregroundColor: dim ? NSColor.tertiaryLabelColor : color, .font: NSFont.systemFont(ofSize: 10)]))
        t.append(NSAttributedString(string: (a.ticket ?? "–") + "\t", attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular), .foregroundColor: NSColor.secondaryLabelColor]))
        let title = a.title.count > 40 ? String(a.title.prefix(39)) + "…" : a.title
        t.append(NSAttributedString(string: title, attributes: [.font: NSFont.menuFont(ofSize: 13), .foregroundColor: dim ? NSColor.secondaryLabelColor : NSColor.labelColor]))
        t.append(NSAttributedString(string: "\t" + shortDuration(a.seconds), attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: a.status == .turn ? .semibold : .regular),
            .foregroundColor: a.status == .turn ? color : NSColor.secondaryLabelColor]))
        t.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: t.length))
        i.attributedTitle = t
        i.toolTip = "\(a.host) · \(a.kind)\(a.focusable ? " · click to open its tab" : "")"
        return i
    }

    private func action(_ title: String, _ sel: Selector, key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        i.target = self
        return i
    }

    @objc private func focusAgent(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String, let a = agents.first(where: { $0.key == key }) else { return }
        onFocus?(a)
    }
    @objc private func openBoard() { onOpenBoard?() }
    @objc private func settings() { onSettings?() }
    @objc private func setup() { onSetup?() }
    @objc private func restartServer() { onRestartServer?() }
    @objc private func showLog() { onShowLog?() }
    @objc private func toggleLogin() { onToggleLoginItem?() }
    @objc private func checkForUpdates() { onCheckForUpdates?() }
    @objc private func quit() { NSApp.terminate(nil) }
}

private extension NSFont {
    func withWeight(_ w: NSFont.Weight) -> NSFont { NSFont.systemFont(ofSize: pointSize, weight: w) }
}
