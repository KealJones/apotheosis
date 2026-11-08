// XCODE SETUP REQUIRED (one-time, ~5 min):
// 1. Open Package.swift in Xcode, wait for package resolution, then select the Capture scheme.
// 2. In Build Settings → Info.plist File, point it at Sources/Capture/Resources/Info.plist.template
//    (rename the file to Info.plist in Finder first — SPM forbids top-level Info.plist so it ships as .template).
// 3. Go to Signing & Capabilities → add the "Screen Recording" entitlement and link Capture.entitlements.
// Then hit ⌘R to run.

import AppKit
import Foundation
import Darwin

@main
struct CaptureApp {
    static func main() {
        // launchd points stdout at a file, which is block-buffered by default: lines arrive
        // late and a crash loses the tail. Line-buffer so the log keeps up.
        setvbuf(stdout, nil, _IOLBF, 0)

        if CommandLine.arguments.contains("--smoke-meeting") {
            guard #available(macOS 26.0, *) else {
                print("smoke: meeting recording requires macOS 26")
                exit(1)
            }
            MeetingSmokeTest.run(CommandLine.arguments)
        }

        // `Capture --dedupe-echo <meetingId>`: run the end-of-meeting echo filter on a
        // meeting recorded before it existed.
        if let i = CommandLine.arguments.firstIndex(of: "--dedupe-echo") {
            guard let id = CommandLine.arguments.dropFirst(i + 1).first.flatMap(Int64.init) else {
                print("usage: Capture --dedupe-echo <meetingId>")
                exit(2)
            }
            EchoFilter.apply(meetingId: id)
            exit(0)
        }

        if CommandLine.arguments.contains("--slack-messages") {
            SlackExtractor.shared.printMessages()
            exit(0)
        }

        if CommandLine.arguments.contains("--smoke-slack-text") {
            SlackTextSmokeTest.run()
        }

        if CommandLine.arguments.contains("--dump-slack") {
            SlackExtractor.shared.dumpTree()
            exit(0)
        }

        if CommandLine.arguments.contains("--smoke-consent-gate") {
            MeetingGateSmokeTest.run()
        }

        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem?
    private var statusMenuItem: NSMenuItem?
    private var captureToggleItem: NSMenuItem?
    private var recordingStatusItem: NSMenuItem?
    private var stopRecordingItem: NSMenuItem?
    private var deleteMeetingItem: NSMenuItem?
    private var dashboardServerProcess: Process?
    /// Latest "last: HH:MM" label from CaptureLoop, shown while capture is running.
    private var lastCaptureLabel = "apotheosis — capturing"

    /// Whether a meeting is actively being recorded right now — drives the menu-bar icon
    /// so recording is unmistakable regardless of the pause/capture state.
    private var isRecordingMeeting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = NSImage(
                systemSymbolName: "camera.badge.clock",
                accessibilityDescription: "apotheosis"
            )
        }
        item.menu = buildMenu()
        statusItem = item

        CaptureLoop.shared.onStatusUpdate = { [weak self] label in
            DispatchQueue.main.async {
                self?.lastCaptureLabel = label
                self?.refreshCaptureState()
            }
        }

        MeetingDetector.shared.onRecordingStateChanged = { [weak self] recording, label in
            DispatchQueue.main.async {
                self?.updateRecordingState(recording: recording, label: label)
            }
        }

        CaptureLoop.shared.start()

        // Event-driven monitors
        AppSwitchMonitor.shared.start()
        FileMonitor.shared.start()
        MeetingDetector.shared.start()
        Retention.shared.start()

        // Seed AXMonitor for the current frontmost app
        if let front = NSWorkspace.shared.frontmostApplication {
            AXMonitor.shared.observe(pid: front.processIdentifier)
        }

        // Enable Slack's Electron AX tree if Slack is already running at daemon startup
        SlackExtractor.shared.ensureAXEnabled()
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        // Without this, AppKit enables every item whose target responds to its action and
        // ignores `isEnabled`, which is why Stop/Delete looked clickable with no meeting.
        menu.autoenablesItems = false
        menu.delegate = self

        let label = NSMenuItem(title: "apotheosis — capturing", action: nil, keyEquivalent: "")
        label.isEnabled = false
        menu.addItem(label)
        statusMenuItem = label

        menu.addItem(.separator())

        let toggleItem = NSMenuItem(
            title: "Pause Capture",
            action: #selector(toggleCapture),
            keyEquivalent: ""
        )
        toggleItem.target = self
        menu.addItem(toggleItem)
        captureToggleItem = toggleItem

        let reviewItem = NSMenuItem(
            title: "What did I do today?",
            action: #selector(openReview),
            keyEquivalent: ""
        )
        reviewItem.target = self
        menu.addItem(reviewItem)

        let dashboardItem = NSMenuItem(
            title: "Open Dashboard",
            action: #selector(openDashboardAction),
            keyEquivalent: ""
        )
        dashboardItem.target = self
        menu.addItem(dashboardItem)

        menu.addItem(.separator())

        let recordingStatus = NSMenuItem(title: "No meeting recording", action: nil, keyEquivalent: "")
        recordingStatus.isEnabled = false
        menu.addItem(recordingStatus)
        recordingStatusItem = recordingStatus

        let stopItem = NSMenuItem(
            title: "Stop Recording This Meeting",
            action: #selector(stopMeetingRecording),
            keyEquivalent: ""
        )
        stopItem.target = self
        stopItem.isHidden = true
        menu.addItem(stopItem)
        stopRecordingItem = stopItem

        let deleteItem = NSMenuItem(
            title: "Delete This Meeting",
            action: #selector(deleteCurrentMeetingAction),
            keyEquivalent: ""
        )
        deleteItem.target = self
        deleteItem.isHidden = true
        menu.addItem(deleteItem)
        deleteMeetingItem = deleteItem

        menu.addItem(.separator())

        let quitItem = NSMenuItem(
            title: "Quit",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        menu.addItem(quitItem)

        return menu
    }

    func menuWillOpen(_ menu: NSMenu) {
        refreshCaptureState()
    }

    /// One toggle, three meanings: resume when paused, "capture anyway" when the schedule
    /// says off (until midnight), otherwise pause.
    @objc private func toggleCapture() {
        let loop = CaptureLoop.shared
        if loop.isPaused {
            loop.isPaused = false
        } else if !loop.isInSchedule {
            loop.scheduleOverrideUntil = Calendar.current.startOfDay(for: Date()).addingTimeInterval(24 * 60 * 60)
        } else {
            loop.isPaused = true
            loop.scheduleOverrideUntil = nil
        }
        refreshCaptureState()
    }

    /// Syncs the status line, toggle title, and icon with pause + schedule state.
    private func refreshCaptureState() {
        let loop = CaptureLoop.shared
        if loop.isPaused {
            statusMenuItem?.title = "apotheosis — paused"
            captureToggleItem?.title = "Resume Capture"
        } else if !loop.isInSchedule {
            statusMenuItem?.title = "apotheosis — outside capture schedule"
            captureToggleItem?.title = "Capture Now (until midnight)"
        } else {
            statusMenuItem?.title = lastCaptureLabel
            captureToggleItem?.title = "Pause Capture"
        }
        updateMenuBarIcon(capturing: loop.skipReason(checkIdle: false) == nil)
    }

    private func updateMenuBarIcon(capturing: Bool) {
        // Recording takes priority over the pause/capture icon so it's unmistakable
        // regardless of what else is going on.
        let symbolName = isRecordingMeeting
            ? "record.circle.fill"
            : (capturing ? "camera.badge.clock" : "camera.badge.clock.fill")
        let description = isRecordingMeeting
            ? "apotheosis — recording meeting"
            : (capturing ? "apotheosis — capturing" : "apotheosis — paused")
        if let button = statusItem?.button {
            button.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: description)
        }
    }

    /// Wired to `MeetingDetector.onRecordingStateChanged`. Updates the dedicated menu
    /// item, shows/hides the stop/delete actions, and swaps the menu-bar icon —
    /// three redundant signals so recording is never just a log line.
    private func updateRecordingState(recording: Bool, label: String?) {
        isRecordingMeeting = recording
        recordingStatusItem?.title = recording
            ? "\u{1F534} Recording meeting\(label.map { ": \($0)" } ?? "")"
            : "No meeting recording"
        // Only offer meeting actions while there is a meeting to act on.
        stopRecordingItem?.isHidden = !recording
        deleteMeetingItem?.isHidden = !recording
        updateMenuBarIcon(capturing: CaptureLoop.shared.skipReason(checkIdle: false) == nil)
    }

    @objc private func stopMeetingRecording() {
        MeetingDetector.shared.stopCurrentRecording()
    }

    @objc private func deleteCurrentMeetingAction() {
        MeetingDetector.shared.deleteCurrentMeeting()
    }

    /// "What did I do today?": the dashboard timeline, scoped to local midnight onward.
    @objc private func openReview() {
        let midnight = Calendar.current.startOfDay(for: Date())
        let since = ISO8601DateFormatter().string(from: midnight)
        openDashboard(path: "/timeline?since=\(since)")
    }

    @objc private func openDashboardAction() {
        openDashboard(path: "/")
    }

    private static let dashboardBase = "http://127.0.0.1:4317"
    /// Same file the web LaunchAgent logs to. ~/Library/Logs is private to the user,
    /// unlike /tmp, and Console.app shows it.
    private static let dashboardLog = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/apotheosis/web.log").path

    /// Opens a dashboard page, starting the web server first if nothing is listening.
    private func openDashboard(path: String) {
        guard let url = URL(string: Self.dashboardBase + path) else { return }
        checkServerRunning { [weak self] isRunning in
            guard let self else { return }
            if isRunning {
                DispatchQueue.main.async { NSWorkspace.shared.open(url) }
                return
            }
            if let error = self.startDashboardServer() {
                self.showDashboardError(error)
                return
            }
            self.waitForServer(attemptsLeft: 30) { up in
                DispatchQueue.main.async {
                    if up {
                        NSWorkspace.shared.open(url)
                    } else {
                        self.showDashboardError("The dashboard server didn't come up within 30 seconds.")
                    }
                }
            }
        }
    }

    private func checkServerRunning(completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: URL(string: Self.dashboardBase)!)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 1.0
        URLSession.shared.dataTask(with: request) { _, response, _ in
            completion(response is HTTPURLResponse)
        }.resume()
    }

    /// Polls once a second; `next start` takes a few seconds to bind.
    private func waitForServer(attemptsLeft: Int, completion: @escaping (Bool) -> Void) {
        checkServerRunning { [weak self] up in
            if up || attemptsLeft <= 1 { completion(up); return }
            DispatchQueue.global().asyncAfter(deadline: .now() + 1.0) {
                self?.waitForServer(attemptsLeft: attemptsLeft - 1, completion: completion)
            }
        }
    }

    /// Finds the repo root by walking up from the binary (it's built inside the repo,
    /// at apps/capture/.build/...) to the folder holding pnpm-workspace.yaml.
    private func findRepoRoot() -> String? {
        var dir = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
            .deletingLastPathComponent()
        while dir.path != "/" {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("pnpm-workspace.yaml").path) {
                return dir.path
            }
            dir.deleteLastPathComponent()
        }
        return nil
    }

    /// Starts `next start` for apps/web in the background. Returns an error message, or nil.
    ///
    /// launchd gives this daemon a bare PATH, so node (asdf, nvm, Homebrew...) isn't found
    /// directly. A login shell picks up the user's PATH; Next is run from apps/web's own
    /// node_modules so pnpm doesn't need to be on PATH at all. Output is appended to
    /// `dashboardLog`.
    private func startDashboardServer() -> String? {
        if let running = dashboardServerProcess, running.isRunning { return nil }
        guard let repoRoot = findRepoRoot() else {
            return "Couldn't find the apotheosis repo above \(CommandLine.arguments[0])."
        }
        let webDir = URL(fileURLWithPath: repoRoot).appendingPathComponent("apps/web")
        guard FileManager.default.fileExists(atPath: webDir.appendingPathComponent(".next").path) else {
            return "The dashboard isn't built yet. Run `pnpm --filter @apotheosis/web build` in the repo."
        }

        let fm = FileManager.default
        try? fm.createDirectory(atPath: (Self.dashboardLog as NSString).deletingLastPathComponent,
                                withIntermediateDirectories: true)
        if !fm.fileExists(atPath: Self.dashboardLog) {
            fm.createFile(atPath: Self.dashboardLog, contents: nil)
        }
        guard let log = FileHandle(forWritingAtPath: Self.dashboardLog) else {
            return "Couldn't open \(Self.dashboardLog) for writing."
        }
        log.seekToEndOfFile()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "exec node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 4317"]
        process.currentDirectoryURL = webDir
        process.standardOutput = log
        process.standardError = log
        do {
            try process.run()
            dashboardServerProcess = process
            return nil
        } catch {
            return "Couldn't start the dashboard server: \(error.localizedDescription)"
        }
    }

    private func showDashboardError(_ message: String) {
        DispatchQueue.main.async {
            print("[Dashboard] \(message)")
            let alert = NSAlert()
            alert.messageText = "Couldn't open the dashboard"
            alert.informativeText = "\(message)\n\nServer log: \(Self.dashboardLog)"
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
    }
}
