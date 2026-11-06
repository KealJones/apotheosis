import AppKit
import CoreAudio
import Foundation

// MARK: - Platform

enum MeetingPlatform: String {
    case googleMeet = "google_meet"
    case zoom
    case teams
    case slackHuddle = "slack_huddle"
    case unknown
}

/// Bundle ids for native meeting apps. Their mere presence in `runningApplications`,
/// combined with the mic being live, is treated as a meeting signal — we don't have a
/// reliable cross-app way to detect "has an active call window" short of deep AX
/// introspection per app, which is out of scope for this detection-only task.
enum MeetingAppBundle: String, CaseIterable {
    case zoom = "us.zoom.xos"
    case teams = "com.microsoft.teams2"
    case slack = "com.tinyspeck.slackmacgap"

    var platform: MeetingPlatform {
        switch self {
        case .zoom: return .zoom
        case .teams: return .teams
        case .slack: return .slackHuddle
        }
    }
}

// MARK: - URL matching (pure, unit-testable)

struct MeetingURLMatch: Equatable {
    let platform: MeetingPlatform
    let externalId: String?
}

enum MeetingURLMatcher {
    // Google Meet join codes are three lowercase-letter groups, e.g. "abc-defg-hij".
    // The code may sit behind extra path segments, e.g. "meet.google.com/meet/abc-defg-hij".
    private static let googleMeetRegex = try! NSRegularExpression(
        pattern: #"meet\.google\.com/(?:[\w-]+/)*([a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4})"#
    )
    private static let zoomRegex = try! NSRegularExpression(
        pattern: #"zoom\.us/j/(\d+)"#
    )
    private static let teamsSubstring = "teams.microsoft.com"

    /// Matches a tab URL against known meeting platform patterns.
    /// Returns nil for anything else (e.g. a YouTube video, a Google Meet *landing* page
    /// with no join code, an unrelated zoom.us marketing page).
    static func match(url: String) -> MeetingURLMatch? {
        let range = NSRange(url.startIndex..<url.endIndex, in: url)

        if let m = googleMeetRegex.firstMatch(in: url, range: range),
           let idRange = Range(m.range(at: 1), in: url) {
            return MeetingURLMatch(platform: .googleMeet, externalId: String(url[idRange]))
        }
        if let m = zoomRegex.firstMatch(in: url, range: range),
           let idRange = Range(m.range(at: 1), in: url) {
            return MeetingURLMatch(platform: .zoom, externalId: String(url[idRange]))
        }
        if url.contains(teamsSubstring) {
            return MeetingURLMatch(platform: .teams, externalId: nil)
        }
        return nil
    }
}

// MARK: - Microphone signal

enum MicrophoneMonitor {
    /// True when some *other* process is capturing audio input. Our own recorder holds
    /// the mic for the whole meeting, so the device-level "running somewhere" flag would
    /// never go idle and meetings would never end. The per-process CoreAudio objects
    /// (macOS 14.2+) let us exclude ourselves; the device-level check is the fallback.
    ///
    /// Siri's voice-trigger daemon also starts running input whenever another process
    /// opens the mic (observed while our recorder was the only mic user), so it is
    /// ignored too; otherwise it would keep every recorded meeting alive forever.
    static func isInUse() -> Bool {
        if #available(macOS 14.2, *), let inUse = isInUseByOtherProcess() {
            return inUse
        }
        return defaultInputIsRunningSomewhere()
    }

    private static let ignoredExecutables: Set<String> = ["corespeechd", "corespeechd_system"]

    @available(macOS 14.2, *)
    private static func isInUseByOtherProcess() -> Bool? {
        let system = AudioObjectID(kAudioObjectSystemObject)
        var listAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &listAddress, 0, nil, &size) == noErr else { return nil }
        var processes = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &listAddress, 0, nil, &size, &processes) == noErr else { return nil }

        let ownPid = getpid()
        for process in processes {
            var pid: pid_t = 0
            var pidSize = UInt32(MemoryLayout<pid_t>.size)
            var pidAddress = AudioObjectPropertyAddress(
                mSelector: kAudioProcessPropertyPID,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            guard AudioObjectGetPropertyData(process, &pidAddress, 0, nil, &pidSize, &pid) == noErr,
                  pid != ownPid else { continue }

            var running: UInt32 = 0
            var runningSize = UInt32(MemoryLayout<UInt32>.size)
            var runningAddress = AudioObjectPropertyAddress(
                mSelector: kAudioProcessPropertyIsRunningInput,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            guard AudioObjectGetPropertyData(process, &runningAddress, 0, nil, &runningSize, &running) == noErr,
                  running != 0 else { continue }
            if !ignoredExecutables.contains(executableName(pid: pid)) { return true }
        }
        return false
    }

    private static func executableName(pid: pid_t) -> String {
        var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return "" }
        return (String(cString: path) as NSString).lastPathComponent
    }

    /// `kAudioDevicePropertyDeviceIsRunningSomewhere` on the default input device.
    /// Includes our own process.
    private static func defaultInputIsRunningSomewhere() -> Bool {
        var defaultInputDeviceID = AudioDeviceID(0)
        var deviceIDSize = UInt32(MemoryLayout<AudioDeviceID>.size)
        var deviceAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let deviceStatus = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &deviceAddress,
            0, nil,
            &deviceIDSize,
            &defaultInputDeviceID
        )
        guard deviceStatus == noErr, defaultInputDeviceID != kAudioObjectUnknown else {
            return false
        }

        var isRunning: UInt32 = 0
        var isRunningSize = UInt32(MemoryLayout<UInt32>.size)
        var runningAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let runningStatus = AudioObjectGetPropertyData(
            defaultInputDeviceID,
            &runningAddress,
            0, nil,
            &isRunningSize,
            &isRunning
        )
        guard runningStatus == noErr else { return false }
        return isRunning != 0
    }
}

// MARK: - Detector

/// Detects meeting start/stop and drives `MeetingRecorder`.
///
/// The `meetings` row is inserted at start (status `recording`) because recording and
/// segment writes need its id. Meetings that end under the minimum duration are deleted
/// along with their audio and segments, so short blips still leave no trace.
/// `@unchecked Sendable`: `pending` is only ever read/written from closures dispatched on
/// `queue` (same confinement pattern as `ChannelPipeline` in MeetingRecorder.swift).
final class MeetingDetector: @unchecked Sendable {
    static let shared = MeetingDetector()

    private let queue = DispatchQueue(label: "com.kealjones.apotheosis.meetingdetector", qos: .utility)
    private var timer: DispatchSourceTimer?

    private static let pollInterval: TimeInterval = 5
    private static let idleEndThreshold: Int64 = 30
    private static let minimumDuration: Int64 = 60

    private static let meetingAppBundleIds: Set<String> = Set(
        MeetingAppBundle.allCases.map { $0.rawValue }
    )

    private struct PendingMeeting {
        let id: Int64
        let startedAt: Int64
        var lastMicActiveAt: Int64
        let platform: MeetingPlatform
        /// `external_id`, or the URL when there's no external id — identifies "this
        /// room" for the consent prompt's "Always for this room" action.
        let roomKey: String?
        let title: String?
        /// `MeetingRecorder` on macOS 26+, set once recording has actually started. Nil
        /// while only detected-but-not-recording: OS too old, gated by config/blocklist,
        /// or still waiting on an `ask`-mode consent decision.
        var recorder: AnyObject?
        /// Final status when there is no recorder: `skipped` (OS too old, disabled,
        /// blocklisted, or consent declined/timed out) or `failed`.
        var statusWithoutRecorder: TranscriptStatus
    }

    private var pending: PendingMeeting?

    /// Fires whenever real audio recording starts or stops for the current meeting, so
    /// the menu bar can show an unmistakable indicator. `label` describes the meeting
    /// (title or platform), nil when recording stops.
    var onRecordingStateChanged: ((Bool, String?) -> Void)?

    private init() {}

    // MARK: - Lifecycle

    /// Runs its own 5s timer rather than piggybacking on `CaptureLoop`'s: that timer
    /// fires every 15s (screenshot cadence) and is a private implementation detail of
    /// CaptureLoop, whereas the 30s mic-idle-to-end window here needs finer granularity
    /// to be a meaningful signal. Same `DispatchSourceTimer` + dedicated-queue pattern
    /// as CaptureLoop/FileMonitor, just a second instance.
    func start() {
        let interrupted = Store.shared.failInterruptedRecordings()
        if interrupted > 0 {
            print("[MeetingDetector] Marked \(interrupted) interrupted recording(s) as failed (audio kept)")
        }

        MeetingConsent.shared.setup()

        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + Self.pollInterval, repeating: Self.pollInterval)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
        print("[MeetingDetector] Started — polling every \(Int(Self.pollInterval))s")
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    // MARK: - Tick

    private func tick() {
        let now = Int64(Date().timeIntervalSince1970)
        let micActive = MicrophoneMonitor.isInUse()

        if micActive {
            handleMicActive(now: now)
        } else if pending != nil {
            handleMicInactive(now: now)
        }
    }

    private func handleMicActive(now: Int64) {
        if var meeting = pending {
            meeting.lastMicActiveAt = now
            pending = meeting
            return
        }

        // Paused or outside the capture schedule: don't start tracking a new meeting.
        // A meeting already in progress keeps going (the menu can stop it).
        guard CaptureLoop.shared.skipReason(checkIdle: false) == nil else { return }
        guard let source = detectMeetingSource() else { return }

        let canRecordOS: Bool
        if #available(macOS 26.0, *) { canRecordOS = true } else { canRecordOS = false }

        // The `meetings` row is always inserted for detection/logging — that's
        // independent of the consent gate below on whether a recorder is ever allowed to
        // actually capture audio.
        let id = Store.shared.insertMeeting(
            startedAt: now,
            endedAt: nil,
            platform: source.platform.rawValue,
            externalId: source.externalId,
            title: source.title,
            url: source.url,
            transcriptStatus: TranscriptStatus.skipped.rawValue,
            audioPath: nil
        )
        guard id > 0 else { return }

        let roomKey = source.externalId ?? source.url
        pending = PendingMeeting(id: id, startedAt: now, lastMicActiveAt: now, platform: source.platform,
                                 roomKey: roomKey, title: source.title, recorder: nil,
                                 statusWithoutRecorder: .skipped)
        print("[MeetingDetector] Meeting detected — id=\(id) platform=\(source.platform.rawValue) url=\(source.url ?? "nil")")

        let config = MeetingConfig.load()
        let gate = MeetingGate.decide(config: config, canRecordOS: canRecordOS,
                                       title: source.title, url: source.url, roomKey: roomKey)

        switch gate {
        case .skipOSUnavailable:
            print("[MeetingDetector] Meeting \(id): recorder unavailable (macOS 26+ required); logging only")
        case .skipDisabled:
            print("[MeetingDetector] Meeting \(id): recording disabled (meetings.enabled=false or mode=off)")
        case .skipBlocklisted(let hit):
            print("[MeetingDetector] Skipping blocklisted meeting: title matched \"\(hit)\"")
        case .skipDomainNotAllowed:
            print("[MeetingDetector] Meeting \(id): url does not match meetings.domain_allowlist; skipping")
        case .recordImmediately:
            startRecorder(meetingId: id, startedAt: now)
        case .needsConsent:
            // The prompt blocks up to 20s, so it runs off `queue` (which also drives the
            // 5s poll timer) and applies its result back on `queue` to avoid racing a
            // tick that already finalized or replaced this meeting.
            let title = source.title
            let platform = source.platform
            Task {
                let decision = await MeetingConsent.shared.ask(meetingId: id, title: title, platform: platform)
                self.queue.async {
                    guard let current = self.pending, current.id == id, current.recorder == nil else { return }
                    switch decision {
                    case .record:
                        self.startRecorder(meetingId: id, startedAt: now)
                    case .alwaysForRoom:
                        if let roomKey { MeetingConfig.rememberAlwaysRecord(roomKey: roomKey) }
                        self.startRecorder(meetingId: id, startedAt: now)
                    case .skip:
                        print("[MeetingDetector] Meeting \(id): consent declined or timed out, not recording")
                    }
                }
            }
        }
    }

    /// Creates the recorder and starts it capturing. Must run on `queue`. Only reached
    /// once the consent gate above has cleared (auto mode, always-allowed room, or an
    /// explicit Record response).
    private func startRecorder(meetingId: Int64, startedAt: Int64) {
        guard #available(macOS 26.0, *) else { return }
        do {
            let r = try MeetingRecorder(meetingId: meetingId, startedAt: Date(timeIntervalSince1970: TimeInterval(startedAt)))
            Store.shared.updateMeeting(id: meetingId, endedAt: nil, transcriptStatus: TranscriptStatus.recording.rawValue, audioPath: r.directory.path)
            Task { await r.start() }
            if var meeting = pending, meeting.id == meetingId {
                meeting.recorder = r
                pending = meeting
            }
            print("[MeetingDetector] Meeting \(meetingId): recording started")
            onRecordingStateChanged?(true, pending?.title ?? pending?.platform.rawValue)
        } catch {
            // Could not even create the audio files: nothing to retry from.
            print("[MeetingDetector] Could not start recorder for meeting \(meetingId): \(error)")
            Store.shared.updateMeeting(id: meetingId, endedAt: nil, transcriptStatus: TranscriptStatus.failed.rawValue, audioPath: nil)
            if var meeting = pending, meeting.id == meetingId {
                meeting.statusWithoutRecorder = .failed
                pending = meeting
            }
        }
    }

    private func handleMicInactive(now: Int64) {
        guard let meeting = pending else { return }
        let idleFor = now - meeting.lastMicActiveAt
        guard idleFor >= Self.idleEndThreshold else { return }

        finalize(meeting: meeting, endedAt: meeting.lastMicActiveAt)
        pending = nil
    }

    private func finalize(meeting: PendingMeeting, endedAt: Int64) {
        let duration = endedAt - meeting.startedAt
        let discard = duration < Self.minimumDuration
        if discard {
            print("[MeetingDetector] Meeting discarded — duration \(duration)s below \(Self.minimumDuration)s minimum")
        } else {
            print("[MeetingDetector] Meeting ended — id=\(meeting.id) platform=\(meeting.platform.rawValue) duration=\(duration)s")
        }

        if meeting.recorder != nil {
            onRecordingStateChanged?(false, nil)
        }

        if #available(macOS 26.0, *), let recorder = meeting.recorder as? MeetingRecorder {
            Task {
                if discard { await recorder.discard() } else { await recorder.finish(endedAt: endedAt) }
            }
        } else if discard {
            Store.shared.deleteMeeting(id: meeting.id)
        } else {
            Store.shared.updateMeeting(id: meeting.id, endedAt: endedAt, transcriptStatus: meeting.statusWithoutRecorder.rawValue, audioPath: nil)
        }
    }

    // MARK: - Menu bar actions

    /// "Stop Recording This Meeting": ends the in-progress meeting exactly like a
    /// natural end-of-meeting (final transcript status, audio kept/dropped per
    /// `meetings.keep_audio`). No-op if nothing is pending.
    func stopCurrentRecording() {
        queue.async { [weak self] in
            guard let self, let meeting = self.pending else { return }
            print("[MeetingDetector] Recording stopped manually — id=\(meeting.id)")
            self.finalize(meeting: meeting, endedAt: Int64(Date().timeIntervalSince1970))
            self.pending = nil
        }
    }

    /// "Delete This Meeting": tears down the recorder (if any) and removes the meeting's
    /// row, segments, and audio entirely — "oops, delete what's happening right now,"
    /// regardless of the minimum-duration rule. No-op if nothing is pending. To delete a
    /// *past* meeting by id instead, use the `delete_meeting` MCP tool.
    func deleteCurrentMeeting() {
        queue.async { [weak self] in
            guard let self, let meeting = self.pending else { return }
            print("[MeetingDetector] Deleting in-progress meeting — id=\(meeting.id)")
            if meeting.recorder != nil { self.onRecordingStateChanged?(false, nil) }
            if #available(macOS 26.0, *), let recorder = meeting.recorder as? MeetingRecorder {
                Task { await recorder.discard() }
            } else {
                Store.shared.deleteMeeting(id: meeting.id)
            }
            self.pending = nil
        }
    }

    // MARK: - Source detection

    private struct DetectedSource {
        let platform: MeetingPlatform
        let externalId: String?
        let title: String?
        let url: String?
    }

    /// Signal 1: a meeting URL open in some browser tab (any window, not just frontmost).
    /// Signal 2: a known native meeting app is currently running.
    private func detectMeetingSource() -> DetectedSource? {
        for tab in ActiveContext.fetchAllTabURLs() {
            guard let match = MeetingURLMatcher.match(url: tab.url) else { continue }
            return DetectedSource(platform: match.platform, externalId: match.externalId, title: tab.title, url: tab.url)
        }

        let runningBundleIds = Set(NSWorkspace.shared.runningApplications.compactMap { $0.bundleIdentifier })
        for appBundle in MeetingAppBundle.allCases where runningBundleIds.contains(appBundle.rawValue) {
            return DetectedSource(platform: appBundle.platform, externalId: nil, title: nil, url: nil)
        }

        return nil
    }
}
