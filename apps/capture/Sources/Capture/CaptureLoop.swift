import Foundation
import AppKit
import ScreenCaptureKit

final class CaptureLoop {
    static let shared = CaptureLoop()

    var isPaused = false
    var onStatusUpdate: ((String) -> Void)?

    /// "Capture Now" from the menu: ignore the schedule's days/hours until this moment.
    var scheduleOverrideUntil: Date?

    /// Last loaded `capture.*` config. Refreshed every tick; guarded because the event
    /// monitors read it from other threads.
    private let scheduleLock = NSLock()
    private var cachedSchedule = CaptureSchedule.load()
    var schedule: CaptureSchedule {
        scheduleLock.lock(); defer { scheduleLock.unlock() }
        return cachedSchedule
    }

    /// Whether the configured days/hours (or a manual override) allow capture right now.
    var isInSchedule: Bool {
        if let until = scheduleOverrideUntil, Date() < until { return true }
        return schedule.isActive()
    }

    /// Why nothing should be recorded right now, or nil if capture should proceed. The one
    /// gate the timer and the event monitors share. `checkIdle` is off for file events,
    /// which keep happening (builds, syncs) while the user is away.
    func skipReason(checkIdle: Bool = true) -> String? {
        if isPaused { return "paused" }
        if !isInSchedule { return "outside capture schedule" }
        if checkIdle && IdleGate.isIdle(after: schedule.idleAfterSeconds) { return "user is idle" }
        return nil
    }

    private let queue = DispatchQueue(
        label: "com.kealjones.apotheosis.capture",
        qos: .utility
    )
    private var timer: DispatchSourceTimer?
    private var timerInterval = 0

    private init() {}

    // MARK: - Lifecycle

    func start() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        timerInterval = schedule.intervalSeconds
        t.schedule(deadline: .now() + 2, repeating: .seconds(timerInterval))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    /// Re-reads `capture.*` from user-config.json and applies an interval change in place.
    private func refreshSchedule() {
        let fresh = CaptureSchedule.load()
        scheduleLock.lock(); cachedSchedule = fresh; scheduleLock.unlock()
        if fresh.intervalSeconds != timerInterval, let timer {
            print("[CaptureLoop] Interval changed: \(timerInterval)s -> \(fresh.intervalSeconds)s")
            timerInterval = fresh.intervalSeconds
            timer.schedule(deadline: .now() + .seconds(timerInterval), repeating: .seconds(timerInterval))
        }
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    // MARK: - Capture tick

    private func tick() {
        refreshSchedule()
        if let reason = skipReason() {
            if reason != "paused" { print("[CaptureLoop] Skipping — \(reason)") }
            return
        }

        let context = ActiveContext.get()
        guard !ActiveContext.shouldSkip(bundle: context.bundleId, windowTitle: context.windowTitle) else {
            print("[CaptureLoop] Skipping — skip list match: bundle=\(context.bundleId ?? "nil") title=\(context.windowTitle ?? "nil")")
            return
        }

        // Slack gets structured message extraction. When it finds messages, they already hold
        // what OCR would, so the tick keeps only the timeline row: no screenshot, no OCR.
        var screenshot = true
        if context.bundleId == SlackExtractor.slackBundleId {
            screenshot = SlackExtractor.shared.captureMessages(windowTitle: context.windowTitle) == 0
        }

        Task {
            await captureAndStore(context: context, screenshot: screenshot)
        }
    }

    // MARK: - Screenshot + storage

    /// Main-actor only. If the main thread stalls, ticks queue up behind it and would all
    /// fire back to back once it frees; one capture at a time drops the duplicates.
    private var captureInFlight = false

    @MainActor
    private func captureAndStore(context: AppContext, screenshot: Bool) async {
        guard !captureInFlight else { return }
        captureInFlight = true
        defer { captureInFlight = false }

        let now = Date().timeIntervalSince1970
        let takenAt = Int64(now)

        // Empty path = no screenshot for this sample (delete_samples skips missing files).
        var screenshotPath = ""
        if screenshot {
            // Unique per capture: if two captures shared a file, one OCR job would delete the other's image.
            guard let path = makeScreenshotPath(unixMs: Int64(now * 1000)) else {
                print("[CaptureLoop] Could not create screenshot directory")
                return
            }
            guard let cgImage = await takeScreenshot() else {
                print("[CaptureLoop] Screenshot failed")
                return
            }
            guard writeJPEG(cgImage: cgImage, to: path) else {
                print("[CaptureLoop] JPEG write failed")
                return
            }
            screenshotPath = path
        }

        // Store in database
        let rowId = Store.shared.insertSample(
            takenAt: takenAt,
            appBundle: context.bundleId,
            appName: context.appName,
            windowTitle: context.windowTitle,
            url: context.url,
            screenshotPath: screenshotPath,
            documentPath: context.documentPath,
            selectedText: context.selectedText,
            focusedElement: context.focusedElement,
            visibleWindows: context.visibleWindows
        )

        guard rowId > 0 else {
            print("[CaptureLoop] DB insert failed")
            return
        }

        if screenshot {
            OCR.shared.enqueue(path: screenshotPath, sampleId: rowId)
        }

        // Update menu bar label
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        let timeStr = formatter.string(from: Date())
        onStatusUpdate?("apotheosis — last: \(timeStr)")
    }

    // MARK: - ScreenCaptureKit

    /// Capture just the focused window (not full screen) for cleaner OCR.
    /// Falls back to full-display capture if window capture fails.
    private func takeScreenshot() async -> CGImage? {
        do {
            let content = try await SCShareableContent.current

            // Try to find the focused window matching the frontmost app
            if let frontApp = await MainActor.run(body: { NSWorkspace.shared.frontmostApplication }),
               let scWindow = content.windows.first(where: {
                   $0.owningApplication?.processID == frontApp.processIdentifier
                   && $0.isOnScreen
                   && $0.frame.width > 100 && $0.frame.height > 100
               }) {
                let filter = SCContentFilter(desktopIndependentWindow: scWindow)
                let config = SCStreamConfiguration()
                config.pixelFormat = kCVPixelFormatType_32BGRA
                // Use native resolution for the window (Retina-quality)
                let scale = await MainActor.run { NSScreen.main?.backingScaleFactor ?? 2.0 }
                config.width = Int(scWindow.frame.width * scale)
                config.height = Int(scWindow.frame.height * scale)
                config.showsCursor = false
                config.capturesShadowsOnly = false
                config.shouldBeOpaque = true

                let image = try await SCScreenshotManager.captureImage(
                    contentFilter: filter,
                    configuration: config
                )
                return image
            }

            // Fallback: full display capture (e.g. if no matching window found)
            let displays = content.displays
            guard let display = displays.first else {
                print("[CaptureLoop] No display found")
                return nil
            }

            let scale = await MainActor.run { NSScreen.main?.backingScaleFactor ?? 2.0 }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.width = min(Int(Double(display.width) * scale), 1920 * Int(scale))
            config.height = Int(Double(display.height) / Double(display.width) * Double(config.width))
            config.showsCursor = false

            return try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )
        } catch {
            print("[CaptureLoop] ScreenCaptureKit error: \(error)")
            return nil
        }
    }

    // MARK: - File helpers

    private func makeScreenshotPath(unixMs: Int64) -> String? {
        let appSupport = Store.dataDirectory.appendingPathComponent("screenshots", isDirectory: true)

        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        let dayFolder = appSupport.appendingPathComponent(
            dateFormatter.string(from: Date()),
            isDirectory: true
        )

        do {
            try FileManager.default.createDirectory(
                at: dayFolder,
                withIntermediateDirectories: true
            )
        } catch {
            print("[CaptureLoop] Could not create screenshot folder: \(error)")
            return nil
        }

        return dayFolder.appendingPathComponent("\(unixMs)-\(UUID().uuidString.prefix(8)).jpg").path
    }

    private func writeJPEG(cgImage: CGImage, to path: String) -> Bool {
        let rep = NSBitmapImageRep(cgImage: cgImage)
        let properties: [NSBitmapImageRep.PropertyKey: Any] = [
            .compressionFactor: 0.75
        ]
        guard let data = rep.representation(using: .jpeg, properties: properties) else {
            return false
        }
        do {
            try data.write(to: URL(fileURLWithPath: path))
            return true
        } catch {
            print("[CaptureLoop] Write error: \(error)")
            return false
        }
    }
}
