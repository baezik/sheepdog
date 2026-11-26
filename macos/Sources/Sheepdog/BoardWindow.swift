import AppKit
@preconcurrency import WebKit

/// The board window: the same board, settings and setup wizard as the web version, in a WKWebView.
/// The web view stays loaded while the window is closed, so alerts (sound, notifications) keep working.
final class BoardWindow: NSObject, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    let window: NSWindow
    let webView: WKWebView
    private var port: Int?
    private var pendingRoute: String?
    private var pageReady = false

    var onMessage: (([String: Any]) -> Void)?

    override init() {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []  // alert sounds play without a click
        config.websiteDataStore = .nonPersistent()
        let controller = WKUserContentController()
        config.userContentController = controller
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 780), configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        controller.add(WeakHandler(self), name: "sheepdog")
        webView.uiDelegate = self
        webView.navigationDelegate = self
        window.title = "Sheepdog"
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(srgbRed: 0.118, green: 0.122, blue: 0.137, alpha: 1)
        window.contentView = webView
        window.minSize = NSSize(width: 360, height: 400)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("SheepdogBoard")
    }

    func load(port: Int) {
        guard self.port != port else { return }
        self.port = port
        pageReady = false
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
    }

    /// Show the window, optionally opening a route: "settings", "settings/slack", "setup", "branches", "board".
    func show(route: String? = nil) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        if let route { open(route) }
    }

    func open(_ route: String) {
        if pageReady {
            webView.evaluateJavaScript("window.sheepdogNative && window.sheepdogNative.open(\(jsString(route)))")
        } else {
            pendingRoute = route
        }
    }

    func setNotificationStatus(_ status: String) {
        webView.evaluateJavaScript("window.sheepdogNative && window.sheepdogNative.setNotif(\(jsString(status)))")
    }

    var isVisible: Bool { window.isVisible }

    // ------------------------------------------------------------ NSWindowDelegate
    func windowWillClose(_ notification: Notification) {
        // back to a pure menu bar app: no Dock icon while the board is closed
        DispatchQueue.main.async { NSApp.setActivationPolicy(.accessory) }
    }

    // ------------------------------------------------------------ messages from the page
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if body["type"] as? String == "ready" {
            pageReady = true
            if let r = pendingRoute { pendingRoute = nil; open(r) }
        }
        onMessage?(body)
    }

    // ------------------------------------------------------------ links and dialogs
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.host == "127.0.0.1" || url.scheme == "about" {
            decisionHandler(.allow)
        } else {
            NSWorkspace.shared.open(url)  // GitHub, Slack and docs links open in the browser
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { retryLoad() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { retryLoad() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { retryLoad() }

    private func retryLoad() {
        guard let port else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, self.port == port else { return }
            self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
}

/// WKUserContentController keeps its handlers alive; this breaks the cycle.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

private func jsString(_ s: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [s])
    let arr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
    return String(arr.dropFirst().dropLast())
}
