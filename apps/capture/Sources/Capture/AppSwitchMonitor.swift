import AppKit

/// Observes NSWorkspace app-activation notifications to log exact app-switch timestamps.
final class AppSwitchMonitor {
    static let shared = AppSwitchMonitor()

    private var previousBundle: String?
    private var previousAppName: String?

    private init() {}

    // MARK: - Lifecycle

    func start() {
        // Seed previous state from current frontmost app
        if let front = NSWorkspace.shared.frontmostApplication {
            previousBundle = front.bundleIdentifier
            previousAppName = front.localizedName
        }

        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(appDidActivate(_:)),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )

        print("[AppSwitchMonitor] Started — initial app: \(previousBundle ?? "nil")")
    }

    func stop() {
        NSWorkspace.shared.notificationCenter.removeObserver(self)
    }

    // MARK: - Notification handler

    @objc private func appDidActivate(_ notification: Notification) {
        guard CaptureLoop.shared.skipReason() == nil else { return }

        guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else {
            return
        }

        let newBundle = app.bundleIdentifier
        let newName = app.localizedName

        // Don't log if it's the same app re-activating
        guard newBundle != previousBundle else { return }

        // Skip if the new app is on the blocklist
        guard !SkipPatterns.shared.shouldSkip(bundle: newBundle, windowTitle: nil) else {
            // Still update previous so the NEXT switch has correct previous_app_bundle
            previousBundle = newBundle
            previousAppName = newName
            return
        }

        let now = Int64(Date().timeIntervalSince1970)

        // Grab extra context from the newly activated app
        let context = ActiveContext.get()

        let rowId = Store.shared.insertEvent(
            takenAt: now,
            eventType: "app_switch",
            appBundle: newBundle,
            appName: newName,
            windowTitle: context.windowTitle,
            url: context.url,
            documentPath: context.documentPath,
            previousAppBundle: previousBundle,
            detail: nil
        )

        if rowId > 0 {
            print("[AppSwitchMonitor] \(previousAppName ?? "?") → \(newName ?? "?") (id=\(rowId))")
        }

        // Re-register AX observer for the new app
        let pid = app.processIdentifier
        AXMonitor.shared.observe(pid: pid)

        // Warm Slack's Electron AX tree so it's built before the next capture tick.
        // The flag resets when Slack restarts; re-asserting on every activation covers that.
        if newBundle == SlackExtractor.slackBundleId {
            SlackExtractor.shared.ensureAXEnabled()
        }

        // Update previous state
        previousBundle = newBundle
        previousAppName = newName
    }
}
