import AppKit
import Sparkle

/// Self-updating through Sparkle. The feed (SUFeedURL in Info.plist) is the appcast.xml attached to the
/// latest GitHub release; updates are verified with the EdDSA key in SUPublicEDKey before installing.
///
/// Sheepdog is a menu bar app, so a scheduled check that finds an update doesn't pop a window over
/// whatever you're doing ("gentle reminder"): the dropdown gets an "Update to x.y.z…" item instead.
final class Updater: NSObject, SPUStandardUserDriverDelegate {
    private var controller: SPUStandardUpdaterController?

    /// Set while an update is waiting for the user; nil otherwise.
    private(set) var availableVersion: String?
    var onChange: (() -> Void)?

    /// Sparkle needs a real bundle with a feed URL; `swift run` builds have neither.
    var isEnabled: Bool { controller != nil }

    var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    func start() {
        let feed = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String ?? ""
        guard Bundle.main.bundleURL.pathExtension == "app", feed.hasPrefix("https://") else { return }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: self)
    }

    /// "Check for Updates…" and "Update to x.y.z…" both land here; Sparkle shows its own window.
    func checkForUpdates() {
        NSApp.activate(ignoringOtherApps: true)
        controller?.checkForUpdates(nil)
    }

    // ------------------------------------------------------------ gentle reminders
    var supportsGentleScheduledUpdateReminders: Bool { true }

    func standardUserDriverShouldHandleShowingScheduledUpdate(_ update: SUAppcastItem, andInImmediateFocus immediateFocus: Bool) -> Bool {
        // only show Sparkle's window right away if the app was just launched (immediate focus);
        // otherwise surface it in the menu bar dropdown
        immediateFocus
    }

    func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState) {
        availableVersion = update.displayVersionString
        onChange?()
    }

    func standardUserDriverDidReceiveUserAttention(forUpdate update: SUAppcastItem) {
        availableVersion = nil
        onChange?()
    }

    func standardUserDriverWillFinishUpdateSession() {
        availableVersion = nil
        onChange?()
    }
}
