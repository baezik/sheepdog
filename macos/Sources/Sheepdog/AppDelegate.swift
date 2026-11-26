import AppKit
import ServiceManagement
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let server = ServerProcess()
    private let api = Api()
    private let updater = Updater()
    private var menu: StatusMenu!
    private var board: BoardWindow!
    private var pollTimer: Timer?
    private var firstReady = true

    /// UNUserNotificationCenter only works inside a real .app bundle.
    private var canNotify: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app" }

    func applicationDidFinishLaunching(_ notification: Notification) {
        updater.start()
        NSApp.mainMenu = mainMenu()
        menu = StatusMenu()
        board = BoardWindow()

        menu.onFocus = { [weak self] a in self?.focus(a.focusKey, fallbackToBoard: true) }
        menu.onOpenBoard = { [weak self] in self?.board.show(route: "board") }
        menu.onSettings = { [weak self] in self?.board.show(route: "settings") }
        menu.onSetup = { [weak self] in self?.board.show(route: "setup") }
        menu.onRestartServer = { [weak self] in self?.server.restart() }
        menu.onShowLog = { [weak self] in if let url = self?.server.logURL { NSWorkspace.shared.open(url) } }
        menu.loginItemEnabled = { SMAppService.mainApp.status == .enabled }
        menu.onToggleLoginItem = { [weak self] in self?.toggleLoginItem() }
        menu.onCheckForUpdates = { [weak self] in self?.updater.checkForUpdates() }
        menu.updateInfo = { [weak self] in
            guard let u = self?.updater, u.isEnabled else { return nil }
            return (u.currentVersion, u.availableVersion)
        }
        updater.onChange = { [weak self] in self?.menu.refreshIcon() }

        board.onMessage = { [weak self] msg in self?.handle(msg) }

        server.onReady = { [weak self] port in self?.serverReady(port) }
        server.onStopped = { [weak self] message in self?.menu.serverDown(message) }
        server.start()

        if canNotify {
            UNUserNotificationCenter.current().delegate = self
            let open = UNNotificationAction(identifier: "jump", title: "Jump to Tab", options: [.foreground])
            UNUserNotificationCenter.current().setNotificationCategories([
                UNNotificationCategory(identifier: "agent", actions: [open], intentIdentifiers: [])])
        }

        pollTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.poll() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        server.stop()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        board.show()
        return true
    }

    // ------------------------------------------------------------ server
    private func serverReady(_ port: Int) {
        api.port = port
        board.load(port: port)
        poll()
        if firstReady {
            firstReady = false
            // first launch: open the board, which starts the setup wizard
            api.state { [weak self] s in
                if s?["setupComplete"] as? Bool == false { self?.board.show() }
            }
        }
    }

    private func poll() {
        guard server.isRunning else { return }
        api.state { [weak self] s in
            guard let self else { return }
            if let s { self.menu.update(state: s) }
        }
    }

    private func focus(_ key: String, fallbackToBoard: Bool) {
        guard !key.isEmpty else { if fallbackToBoard { board.show(route: "board") }; return }
        api.focus(key) { [weak self] ok, _ in
            if !ok && fallbackToBoard { self?.board.show(route: "board") }
        }
    }

    // ------------------------------------------------------------ messages from the web page
    private func handle(_ msg: [String: Any]) {
        switch msg["type"] as? String {
        case "ready":
            reportNotificationStatus()
        case "bark":
            menu.bark()
        case "notify":
            notify(title: msg["title"] as? String ?? "An agent is waiting", body: msg["body"] as? String ?? "",
                   id: msg["id"] as? String ?? UUID().uuidString, focusKey: msg["focusKey"] as? String ?? "",
                   url: msg["url"] as? String ?? "")
        case "requestNotifications":
            requestNotifications()
        default:
            break
        }
    }

    // ------------------------------------------------------------ notifications
    private func requestNotifications() {
        guard canNotify else { board.setNotificationStatus("denied"); return }
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            DispatchQueue.main.async {
                if settings.authorizationStatus == .denied {
                    // already refused once: macOS won't ask again, so open the right settings page
                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!)
                    self?.reportNotificationStatus()
                    return
                }
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
                    DispatchQueue.main.async { self?.reportNotificationStatus() }
                }
            }
        }
    }

    private func reportNotificationStatus() {
        guard canNotify else { board.setNotificationStatus("unavailable"); return }
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] s in
            let status: String
            switch s.authorizationStatus {
            case .authorized, .provisional: status = "granted"
            case .denied: status = "denied"
            default: status = "default"
            }
            DispatchQueue.main.async { self?.board.setNotificationStatus(status) }
        }
    }

    private func notify(title: String, body: String, id: String, focusKey: String, url: String = "") {
        guard canNotify else { return }
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        // PR alerts carry a GitHub link and open it; agent alerts jump to the agent's tab
        let isLink = url.hasPrefix("https://")
        c.categoryIdentifier = isLink ? "pr" : "agent"
        c.userInfo = ["focusKey": focusKey, "url": isLink ? url : ""]
        // the page plays the chosen Sheepdog sound itself, so no system sound here
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let key = info["focusKey"] as? String ?? ""
        if let link = info["url"] as? String, link.hasPrefix("https://"), let url = URL(string: link) {
            DispatchQueue.main.async { NSWorkspace.shared.open(url) }
            done()
            return
        }
        DispatchQueue.main.async { self.focus(key, fallbackToBoard: true) }
        done()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list])
    }

    // ------------------------------------------------------------ login item
    private func toggleLoginItem() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            let a = NSAlert()
            a.messageText = "Couldn’t change Open at Login"
            a.informativeText = "\(error.localizedDescription)\n\nYou can add Sheepdog yourself in System Settings › General › Login Items."
            a.runModal()
        }
    }

    // ------------------------------------------------------------ main menu (needed for ⌘C/⌘V/⌘, in the window)
    private func mainMenu() -> NSMenu {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Sheepdog", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        if updater.isEnabled {
            appMenu.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "").target = self
        }
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Sheepdog", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Sheepdog", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let winItem = NSMenuItem()
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winItem.submenu = win
        main.addItem(winItem)
        NSApp.windowsMenu = win
        return main
    }

    @objc private func openSettings() { board.show(route: "settings") }
    @objc private func checkForUpdates() { updater.checkForUpdates() }
}
