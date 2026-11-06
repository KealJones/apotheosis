import Foundation
import UserNotifications
import AppKit

/// The user's response to the `meetings.mode = "ask"` consent prompt.
enum ConsentDecision {
    case record
    case skip
    case alwaysForRoom
}

/// Asks at meeting start with Record / Skip / Always-for-this-room, and waits (bounded) for
/// a response. Never records while waiting: the default on timeout, denied authorization,
/// or a delivery error is always `.skip`.
///
/// Uses a macOS notification when running as a real `.app`. As a bare LaunchAgent binary
/// (today's packaging) notifications are unavailable, so it shows a small floating panel
/// from the menu-bar app instead. The panel doesn't take focus, so typing into the call
/// isn't interrupted.
/// `@unchecked Sendable`: the only mutable state (`continuations`) is guarded by `lock`,
/// same pattern as `ChannelPipeline` in MeetingRecorder.swift.
final class MeetingConsent: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = MeetingConsent()

    private static let categoryId = "com.kealjones.apotheosis.meeting-consent"
    private static let recordActionId = "record"
    private static let skipActionId = "skip"
    private static let alwaysActionId = "always"

    private let lock = NSLock()
    private var continuations: [String: CheckedContinuation<ConsentDecision, Never>] = [:]

    /// `UNUserNotificationCenter.current()` throws an uncaught `NSException`
    /// ("bundleProxyForCurrentProcess is nil") when the running process isn't a real
    /// `.app` bundle registered with LaunchServices — which is exactly what `Capture` is
    /// today (a bare, code-signed Mach-O binary with an *embedded* Info.plist section,
    /// launched as a LaunchAgent). That exception can't be caught from Swift and takes
    /// the whole daemon down with it, so every entry point into UserNotifications is
    /// guarded by this check first. Verified against the real signed binary: crashes
    /// when false, works fine (in principle) when true. If `Capture` is ever packaged as
    /// a proper `.app`, this starts returning true and `ask` starts prompting for real —
    /// no code change needed.
    private static let notificationsAvailable = Bundle.main.bundleURL.pathExtension == "app"

    private override init() { super.init() }

    /// Registers the notification category/actions and requests authorization. Call once
    /// at app startup. Denied/unavailable authorization isn't fatal — `ask` just always
    /// resolves to `.skip` (logged once here so it's clear why nothing prompts).
    func setup() {
        guard Self.notificationsAvailable else {
            print("[MeetingConsent] Running outside an .app bundle — using a floating panel for 'ask' prompts instead of notifications.")
            return
        }
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        let record = UNNotificationAction(identifier: Self.recordActionId, title: "Record", options: [])
        let skip = UNNotificationAction(identifier: Self.skipActionId, title: "Skip", options: [.destructive])
        let always = UNNotificationAction(identifier: Self.alwaysActionId, title: "Always for this room", options: [])
        let category = UNNotificationCategory(
            identifier: Self.categoryId, actions: [record, skip, always],
            intentIdentifiers: [], options: []
        )
        center.setNotificationCategories([category])

        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error {
                print("[MeetingConsent] Notification authorization error: \(error)")
            } else if !granted {
                print("[MeetingConsent] Notification authorization denied — 'ask' mode will default to Skip for every meeting until this is granted in System Settings > Notifications")
            }
        }
    }

    /// Posts the consent prompt for `meetingId` and waits up to `timeout` seconds.
    /// Resolves as soon as the user taps an action, or with `.skip` at the timeout —
    /// whichever comes first wins (a late tap after timeout is accepted but harmless,
    /// since the caller has already moved on).
    func ask(meetingId: Int64, title: String?, platform: MeetingPlatform, timeout: TimeInterval = 20) async -> ConsentDecision {
        guard Self.notificationsAvailable else {
            let decision = await ConsentPanel.ask(title: title, platform: platform, timeout: timeout)
            print("[MeetingConsent] Meeting \(meetingId) consent decision (panel): \(decision)")
            return decision
        }

        let identifier = "meeting-consent-\(meetingId)"

        let content = UNMutableNotificationContent()
        content.title = "Record this meeting?"
        content.body = title.map { "\($0) (\(platform.rawValue))" } ?? "Detected a \(platform.rawValue) meeting"
        content.categoryIdentifier = Self.categoryId
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)

        let decision = await withCheckedContinuation { (continuation: CheckedContinuation<ConsentDecision, Never>) in
            lock.withLock { continuations[identifier] = continuation }

            UNUserNotificationCenter.current().add(request) { [weak self] error in
                if let error {
                    print("[MeetingConsent] Could not post consent notification for meeting \(meetingId): \(error)")
                    self?.resume(identifier: identifier, with: .skip)
                }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.resume(identifier: identifier, with: .skip)
            }
        }

        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [identifier])
        print("[MeetingConsent] Meeting \(meetingId) consent decision: \(decision)")
        return decision
    }

    /// Resumes the pending continuation for `identifier`, if it hasn't already resumed
    /// (via a button tap or the timeout firing first). `removeValue` returning nil means
    /// someone else already won the race, so this is a safe no-op.
    private func resume(identifier: String, with decision: ConsentDecision) {
        let continuation = lock.withLock { continuations.removeValue(forKey: identifier) }
        continuation?.resume(returning: decision)
    }

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let decision: ConsentDecision
        switch response.actionIdentifier {
        case Self.recordActionId: decision = .record
        case Self.alwaysActionId: decision = .alwaysForRoom
        default: decision = .skip   // explicit Skip action, notification dismissed, or default tap
        }
        resume(identifier: response.notification.request.identifier, with: decision)
        completionHandler()
    }

    /// Menu-bar-only app has no "foreground" window, but keep banners showing regardless.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}

/// Non-notification fallback for the consent prompt: an alert-style window that floats above
/// other apps without activating this one, answered by its buttons or dismissed at `timeout`.
@MainActor
private final class ConsentPanel: NSObject {
    private let alert = NSAlert()
    private var continuation: CheckedContinuation<ConsentDecision, Never>?
    private static var showing: [ConsentPanel] = []  // keeps panels alive while on screen

    static func ask(title: String?, platform: MeetingPlatform, timeout: TimeInterval) async -> ConsentDecision {
        let panel = ConsentPanel()
        showing.append(panel)
        defer { showing.removeAll { $0 === panel } }
        return await panel.run(title: title, platform: platform, timeout: timeout)
    }

    private func run(title: String?, platform: MeetingPlatform, timeout: TimeInterval) async -> ConsentDecision {
        alert.messageText = "Record this meeting?"
        alert.informativeText = (title.map { "\($0) (\(platform.rawValue))" } ?? "Detected a \(platform.rawValue) meeting")
            + "\n\nSkips automatically in \(Int(timeout)) seconds."
        for (i, label) in ["Record", "Skip", "Always for this room"].enumerated() {
            let button = alert.addButton(withTitle: label)
            button.tag = i
            button.target = self
            button.action = #selector(choose(_:))
        }
        alert.layout()
        alert.window.level = .floating
        alert.window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // Top-right of the screen the pointer is on, where notifications would appear.
        let mouse = NSEvent.mouseLocation
        if let screen = NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main {
            let area = screen.visibleFrame, size = alert.window.frame.size
            alert.window.setFrameOrigin(NSPoint(x: area.maxX - size.width - 16, y: area.maxY - size.height - 16))
        }
        alert.window.orderFrontRegardless()

        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.finish(.skip)
            }
        }
    }

    @objc private func choose(_ sender: NSButton) {
        finish([.record, .skip, .alwaysForRoom][sender.tag])
    }

    private func finish(_ decision: ConsentDecision) {
        guard let continuation else { return }
        self.continuation = nil
        alert.window.orderOut(nil)
        continuation.resume(returning: decision)
    }
}
