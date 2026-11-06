import AppKit
import Carbon.HIToolbox

/// Watches for window focus and title changes within the current frontmost app
/// using the Accessibility API's AXObserver mechanism.
final class AXMonitor {
    static let shared = AXMonitor()

    private var currentObserver: AXObserver?
    private var currentPid: pid_t = 0

    /// Debounce: track last event timestamp per event type to avoid floods
    private var lastEventTime: [String: Date] = [:]
    private let debounceInterval: TimeInterval = 2.0

    private init() {}

    // MARK: - Public API

    /// Start observing AX events for the given process.
    /// Tears down any existing observer before creating a new one.
    /// Called by AppSwitchMonitor on every app switch, and once at startup for the initial app.
    func observe(pid: pid_t) {
        // Tear down previous observer
        tearDown()

        guard pid > 0 else { return }
        currentPid = pid

        // Create the observer — the callback MUST be a C function pointer (not a closure).
        // We pass `self` as the refcon via Unmanaged.
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        var observer: AXObserver?
        let createResult = AXObserverCreate(pid, axCallback, &observer)

        guard createResult == .success, let observer else {
            print("[AXMonitor] AXObserverCreate failed for pid \(pid): \(createResult.rawValue)")
            return
        }

        let axApp = AXUIElementCreateApplication(pid)

        // Register for notifications we care about
        let notifications = [
            kAXFocusedWindowChangedNotification,
            kAXTitleChangedNotification,
        ]

        for notif in notifications {
            let addResult = AXObserverAddNotification(observer, axApp, notif as CFString, refcon)
            if addResult != .success && addResult != .notificationAlreadyRegistered {
                print("[AXMonitor] Failed to add \(notif) for pid \(pid): \(addResult.rawValue)")
            }
        }

        // Integrate with the main RunLoop so callbacks fire
        CFRunLoopAddSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(observer),
            .defaultMode
        )

        currentObserver = observer
        print("[AXMonitor] Observing pid \(pid)")
    }

    func stop() {
        tearDown()
    }

    // MARK: - Internal (called from C callback)

    /// Handle an AX notification. Called from the C function pointer callback below.
    fileprivate func handleNotification(element: AXUIElement, name: String) {
        guard CaptureLoop.shared.skipReason() == nil else { return }

        // Map AX notification name to our event type
        let eventType: String
        switch name {
        case kAXFocusedWindowChangedNotification:
            eventType = "window_focus"
        case kAXTitleChangedNotification:
            eventType = "title_change"
        default:
            return
        }

        // Debounce: skip if we fired the same event type within the last 2 seconds
        let now = Date()
        if let lastFire = lastEventTime[eventType],
           now.timeIntervalSince(lastFire) < debounceInterval {
            return
        }
        lastEventTime[eventType] = now

        // Grab current context using the existing ActiveContext infrastructure
        let context = ActiveContext.get()

        // Skip if the current app is on the blocklist
        guard !ActiveContext.shouldSkip(bundle: context.bundleId, windowTitle: context.windowTitle) else {
            return
        }

        let takenAt = Int64(now.timeIntervalSince1970)

        let rowId = Store.shared.insertEvent(
            takenAt: takenAt,
            eventType: eventType,
            appBundle: context.bundleId,
            appName: context.appName,
            windowTitle: context.windowTitle,
            url: context.url,
            documentPath: context.documentPath,
            previousAppBundle: nil,
            detail: context.focusedElement
        )

        if rowId > 0 {
            print("[AXMonitor] \(eventType): \(context.appName ?? "?") — \(context.windowTitle ?? "?") (id=\(rowId))")
        }
    }

    // MARK: - Teardown

    private func tearDown() {
        guard let observer = currentObserver else { return }

        CFRunLoopRemoveSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(observer),
            .defaultMode
        )

        // Remove notifications
        let axApp = AXUIElementCreateApplication(currentPid)
        AXObserverRemoveNotification(observer, axApp, kAXFocusedWindowChangedNotification as CFString)
        AXObserverRemoveNotification(observer, axApp, kAXTitleChangedNotification as CFString)

        currentObserver = nil
        currentPid = 0
        print("[AXMonitor] Tore down observer")
    }
}

// MARK: - C function pointer callback (free function, not a closure)

/// AXObserverCallback — must be a free function at file scope.
/// Recovers the AXMonitor instance from the refcon pointer and dispatches.
private func axCallback(
    _ observer: AXObserver,
    _ element: AXUIElement,
    _ notificationName: CFString,
    _ refcon: UnsafeMutableRawPointer?
) {
    guard let refcon else { return }
    let monitor = Unmanaged<AXMonitor>.fromOpaque(refcon).takeUnretainedValue()
    let name = notificationName as String
    monitor.handleNotification(element: element, name: name)
}
