import AVFoundation
import Foundation
import Speech

// MARK: - Shared types

enum AudioChannel: String, CaseIterable {
    case me     // microphone
    case them   // system audio
}

struct MeetingSegment {
    let startedMs: Int64   // offset from meeting start
    let endedMs: Int64
    let channel: AudioChannel
    let text: String
}

/// Values of `meetings.transcript_status` this recorder produces.
enum TranscriptStatus: String {
    case recording      // live; left behind only if the daemon dies mid-meeting
    case transcribing   // analyzer fell behind; audio kept for a catch-up pass
    case done
    case failed         // something threw; audio kept for a retry
    case skipped        // no recorder (OS too old)
}

enum MeetingRecorderError: Error, CustomStringConvertible {
    case localeUnsupported
    case assetsUnavailable
    case formatMismatch(String)
    case conversionFailed(String)
    case segmentWriteFailed

    var description: String {
        switch self {
        case .localeUnsupported: return "en-US is not supported by SpeechTranscriber on this machine"
        case .assetsUnavailable: return "SpeechTranscriber assets are unavailable"
        case .formatMismatch(let f): return "SpeechAnalyzer wants \(f), expected 16kHz mono Int16"
        case .conversionFailed(let f): return "cannot convert audio from \(f)"
        case .segmentWriteFailed: return "failed to write transcript segments to the database"
        }
    }
}

/// The one format everything is converted to before it touches the analyzer or disk.
/// A1: `SpeechAnalyzer.bestAvailableAudioFormat` is 16kHz mono Int16, and feeding it any
/// other format (even SCStream's 16kHz Float32) traps inside `SpeechRecognizerWorker`
/// instead of throwing. So every source goes through `StreamingConverter` first.
enum MeetingAudioFormat {
    static let canonical = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    static var framesPerSecond: Int64 { Int64(canonical.sampleRate) }
}

// MARK: - Recorder

/// Records and transcribes one meeting: mic -> "me", system audio -> "them".
///
/// Per channel: source -> convert to 16kHz Int16 -> append to `<channel>.caf` -> feed a
/// dedicated `SpeechAnalyzer`. Audio always hits disk first, so whatever happens to
/// transcription the meeting can be re-transcribed from the files.
///
/// Final status (see `finish`):
/// - any error on any channel -> `failed`, audio kept regardless of config
/// - otherwise, any channel fell behind -> `transcribing`, audio kept
/// - otherwise `done`, audio deleted unless `keep_meeting_audio`
@available(macOS 26.0, *)
final class MeetingRecorder {
    let meetingId: Int64
    let directory: URL
    private let sources: [AudioChannel: AudioSource]
    private let pipelines: [AudioChannel: ChannelPipeline]
    private let batcher: SegmentBatcher

    static func directory(forMeeting id: Int64) -> URL {
        Store.dataDirectory
            .appendingPathComponent("meetings", isDirectory: true)
            .appendingPathComponent(String(id), isDirectory: true)
    }

    /// Live meeting: mic + system audio.
    convenience init(meetingId: Int64, startedAt: Date) throws {
        try self.init(meetingId: meetingId, startedAt: startedAt,
                      sources: [.me: MicAudioSource(), .them: SystemAudioSource()])
    }

    init(meetingId: Int64, startedAt: Date, sources: [AudioChannel: AudioSource]) throws {
        self.meetingId = meetingId
        self.directory = Self.directory(forMeeting: meetingId)
        self.sources = sources
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let batcher = SegmentBatcher(meetingId: meetingId)
        self.batcher = batcher
        var pipelines: [AudioChannel: ChannelPipeline] = [:]
        for channel in sources.keys {
            pipelines[channel] = try ChannelPipeline(
                channel: channel,
                fileURL: directory.appendingPathComponent("\(channel.rawValue).caf"),
                meetingStart: startedAt,
                onSegment: { batcher.add($0) }
            )
        }
        self.pipelines = pipelines
    }

    /// Starts capture immediately and transcription as soon as the speech assets are
    /// ready (downloading them first if needed). Never throws: failures are recorded on
    /// the affected channel and surface as `failed` at `finish`.
    func start() async {
        let locale = Task { try await SpeechAssets.prepare() }
        for pipeline in pipelines.values { pipeline.startAnalysis(locale: locale) }
        batcher.start()

        for (channel, source) in sources {
            guard let pipeline = pipelines[channel] else { continue }
            do {
                try await source.start(onBuffer: pipeline.append, onError: pipeline.record)
                print("[MeetingRecorder] meeting \(meetingId): \(channel.rawValue) source started")
            } catch {
                pipeline.record(error)
            }
        }
    }

    /// Stops capture, drains transcription, writes remaining segments, and records the
    /// final status. Returns the status written.
    @discardableResult
    func finish(endedAt: Int64) async -> TranscriptStatus {
        await stopAndDrain()
        var errors = pipelines.values.flatMap { p in p.errors.map { "\(p.channel.rawValue): \($0)" } }
        if batcher.stop() {
            EchoFilter.apply(meetingId: meetingId)
        } else {
            errors.append(String(describing: MeetingRecorderError.segmentWriteFailed))
        }
        let behind = pipelines.values.filter(\.fellBehind).map(\.channel.rawValue)

        let status: TranscriptStatus
        var audioPath: String? = directory.path
        if !errors.isEmpty {
            status = .failed
            print("[MeetingRecorder] meeting \(meetingId) failed, keeping audio at \(directory.path): \(errors.joined(separator: "; "))")
        } else if !behind.isEmpty {
            status = .transcribing
            print("[MeetingRecorder] meeting \(meetingId): analyzer fell behind on \(behind.joined(separator: ",")), keeping audio for catch-up")
        } else {
            status = .done
            if !MeetingConfig.load().keepAudio {
                do {
                    try FileManager.default.removeItem(at: directory)
                    audioPath = nil
                } catch {
                    print("[MeetingRecorder] meeting \(meetingId): could not delete audio: \(error)")
                }
            }
        }

        Store.shared.updateMeeting(id: meetingId, endedAt: endedAt, transcriptStatus: status.rawValue, audioPath: audioPath)
        print("[MeetingRecorder] meeting \(meetingId) finished: status=\(status.rawValue) segments=\(batcher.totalWritten) audio=\(audioPath ?? "deleted")")
        return status
    }

    /// Stops everything and removes the meeting entirely (below the minimum duration).
    func discard() async {
        await stopAndDrain()
        _ = batcher.stop()
        try? FileManager.default.removeItem(at: directory)
        Store.shared.deleteMeeting(id: meetingId)
    }

    private func stopAndDrain() async {
        for source in sources.values { await source.stop() }
        await withTaskGroup(of: Void.self) { group in
            for pipeline in pipelines.values { group.addTask { await pipeline.finish() } }
        }
    }
}

// MARK: - Speech assets

@available(macOS 26.0, *)
enum SpeechAssets {
    static func makeTranscriber(locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(locale: locale, preset: .transcription)
    }

    /// Resolves en-US and makes sure the on-device model is installed, downloading it on
    /// first use (A1: <10s on a fast network; status is per-app, so a fresh binary
    /// identity can see `.supported` even when another app already installed it).
    static func prepare() async throws -> Locale {
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) else {
            throw MeetingRecorderError.localeUnsupported
        }
        let transcriber = makeTranscriber(locale: locale)
        switch await AssetInventory.status(forModules: [transcriber]) {
        case .installed:
            return locale
        case .unsupported:
            throw MeetingRecorderError.assetsUnavailable
        default:
            print("[MeetingRecorder] Downloading speech assets for \(locale.identifier)")
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await request.downloadAndInstall()
            }
            guard await AssetInventory.status(forModules: [transcriber]) == .installed else {
                throw MeetingRecorderError.assetsUnavailable
            }
            print("[MeetingRecorder] Speech assets installed")
            return locale
        }
    }
}

// MARK: - Channel pipeline

/// One channel: converter -> .caf writer -> analyzer input, plus that channel's analyzer.
///
/// Backpressure: lag = audio fed to the analyzer minus audio it has analyzed (the end of
/// its volatile range). Two alternatives were measured and rejected: counting frames the
/// analyzer has *pulled* (it pulls eagerly and ships audio to the out-of-process
/// recognizer, so the backlog lives there), and the *finalized* boundary (range start),
/// which stalls during silence and falsely tripped on a quiet mic.
/// If lag exceeds `maxLagSeconds` (slow model, or assets still downloading), the
/// analyzer input is closed: the analyzer finishes what it already has, nothing more is
/// queued, and the .caf keeps recording. The channel is then `fellBehind`, which makes
/// the meeting `transcribing` rather than `done`. Unprocessed audio held in memory
/// (ours or the recognizer's) is therefore capped at ~60s per channel (~1.9 MB).
///
/// `@unchecked Sendable`: mutable state is either confined to `queue`, guarded by `lock`,
/// or written once by `setupTask` and read only after awaiting it.
@available(macOS 26.0, *)
final class ChannelPipeline: @unchecked Sendable {
    static let maxLagSeconds: Int64 = 60
    /// Arrival jitter is well under this; anything longer is a real hole in the source.
    private static let gapThresholdSeconds: Double = 2
    /// Upper bound on waiting for the analyzer at meeting end (asset download + draining
    /// up to `maxLagSeconds` of backlog). Hitting it counts as falling behind, not failure.
    private static let finishTimeout: Double = 180

    let channel: AudioChannel
    private let meetingStart: Date
    private let onSegment: (MeetingSegment) -> Void
    private let converter = StreamingConverter(output: MeetingAudioFormat.canonical)

    // Confined to `queue`.
    private let queue: DispatchQueue
    private var file: AVAudioFile?
    private var inputOpen = true

    private let input: AsyncStream<AnalyzerInput>
    private let continuation: AsyncStream<AnalyzerInput>.Continuation

    // Guarded by `lock`.
    private let lock = NSLock()
    /// Position of the next buffer on the meeting timeline, in frames since the first
    /// buffer. Advances past source gaps (see `write`), so it can exceed frames received.
    private var timelineFrames: Int64 = 0
    private var processedSeconds: Double = 0
    private var _fellBehind = false
    private var _errors: [String] = []
    private var firstBufferAt: Date?
    private var finished = false

    // Written by `setupTask`, read only after awaiting it.
    private var setupTask: Task<Void, Never>?
    private var analyzer: SpeechAnalyzer?
    private var resultsTask: Task<Void, Error>?

    init(channel: AudioChannel, fileURL: URL, meetingStart: Date, onSegment: @escaping (MeetingSegment) -> Void) throws {
        self.channel = channel
        self.meetingStart = meetingStart
        self.onSegment = onSegment
        self.queue = DispatchQueue(label: "com.kealjones.apotheosis.meeting.\(channel.rawValue)", qos: .userInitiated)
        let format = MeetingAudioFormat.canonical
        self.file = try AVAudioFile(forWriting: fileURL, settings: format.settings,
                                    commonFormat: format.commonFormat, interleaved: format.isInterleaved)
        (input, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    }

    var fellBehind: Bool { lock.withLock { _fellBehind } }
    var errors: [String] { lock.withLock { _errors } }

    func record(_ error: Error) {
        print("[MeetingRecorder] \(channel.rawValue) error: \(error)")
        lock.withLock { _errors.append(String(describing: error)) }
    }

    // MARK: Audio path

    /// Called on the source's thread. Conversion happens here because source buffers are
    /// only valid for the duration of the callback; the converted copy is ours.
    func append(_ buffer: AVAudioPCMBuffer) {
        let receivedAt = Date()
        let converted: AVAudioPCMBuffer?
        do { converted = try converter.convert(buffer) } catch { record(error); return }
        guard let converted else { return }
        queue.async { self.write(converted, receivedAt: receivedAt) }
    }

    private func write(_ buffer: AVAudioPCMBuffer, receivedAt: Date) {
        guard let file else { return }
        do {
            try file.write(from: buffer)
        } catch {
            record(error)
            self.file = nil
            closeInput()
            return
        }

        guard inputOpen else { return }
        let rate = MeetingAudioFormat.canonical.sampleRate
        let (lag, startTime) = lock.withLock { () -> (Double, CMTime?) in
            if firstBufferAt == nil {
                firstBufferAt = receivedAt.addingTimeInterval(-Double(buffer.frameLength) / rate)
            }
            // A source that stopped and came back (screen lock, device switch) leaves a hole
            // in the audio. Jump the timeline over it and tell the analyzer where this buffer
            // really starts, so later segments keep wall-clock-accurate offsets.
            var startTime: CMTime?
            let expectedEnd = firstBufferAt!.addingTimeInterval(Double(timelineFrames + Int64(buffer.frameLength)) / rate)
            let gap = receivedAt.timeIntervalSince(expectedEnd)
            if gap > Self.gapThresholdSeconds {
                timelineFrames += Int64(gap * rate)
                startTime = CMTime(value: timelineFrames, timescale: CMTimeScale(rate))
                print("[MeetingRecorder] \(channel.rawValue): \(Int(gap))s audio gap, skipping ahead")
            }
            timelineFrames += Int64(buffer.frameLength)
            return (Double(timelineFrames) / rate - processedSeconds, startTime)
        }
        if lag > Double(Self.maxLagSeconds) {
            lock.withLock { _fellBehind = true }
            print("[MeetingRecorder] \(channel.rawValue): analyzer >\(Self.maxLagSeconds)s behind, closing analyzer input; audio still recording")
            closeInput()
            return
        }
        continuation.yield(AnalyzerInput(buffer: buffer, bufferStartTime: startTime))
    }

    private func closeInput() {
        guard inputOpen else { return }
        inputOpen = false
        continuation.finish()
    }

    // MARK: Analyzer

    func startAnalysis(locale: Task<Locale, Error>) {
        setupTask = Task {
            do {
                let transcriber = SpeechAssets.makeTranscriber(locale: try await locale.value)
                let analyzer = SpeechAnalyzer(modules: [transcriber])
                let best = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
                guard let best, best == MeetingAudioFormat.canonical else {
                    throw MeetingRecorderError.formatMismatch(best.map { "\($0)" } ?? "nil")
                }
                try await analyzer.prepareToAnalyze(in: MeetingAudioFormat.canonical)

                resultsTask = Task { [weak self] in
                    for try await result in transcriber.results where result.isFinal {
                        self?.handle(result)
                    }
                }
                await analyzer.setVolatileRangeChangedHandler { [weak self] range, _, _ in
                    guard let self else { return }
                    let analyzed = range.end.seconds
                    if analyzed.isFinite { self.lock.withLock { self.processedSeconds = max(self.processedSeconds, analyzed) } }
                }
                try await analyzer.start(inputSequence: input)
                self.analyzer = analyzer
            } catch {
                record(error)
            }
        }
    }

    private func handle(_ result: SpeechTranscriber.Result) {
        let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let (offsetMs, done) = lock.withLock { () -> (Int64, Bool) in
            let offset = firstBufferAt.map { Int64($0.timeIntervalSince(meetingStart) * 1000) } ?? 0
            return (max(0, offset), finished)
        }
        // Results arriving after a timed-out finish belong to a meeting that is already
        // marked `transcribing`; the catch-up pass will redo them, so don't double-write.
        guard !done else { return }
        onSegment(MeetingSegment(
            startedMs: offsetMs + Int64(result.range.start.seconds * 1000),
            endedMs: offsetMs + Int64(result.range.end.seconds * 1000),
            channel: channel,
            text: text
        ))
    }

    /// Call after the source has stopped. Flushes queued audio to disk, closes the
    /// analyzer input, and waits (bounded) for the last results.
    func finish() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queue.async { self.closeInput(); done.resume() }
        }

        do {
            try await withTimeout(seconds: Self.finishTimeout) { [self] in
                await setupTask?.value
                if let analyzer {
                    try await analyzer.finalizeAndFinishThroughEndOfInput()
                }
                try await resultsTask?.value
            }
        } catch is TimeoutError {
            print("[MeetingRecorder] \(channel.rawValue): analyzer did not finish within \(Int(Self.finishTimeout))s, leaving for catch-up")
            lock.withLock { _fellBehind = true }
            if let analyzer { await analyzer.cancelAndFinishNow() }
        } catch {
            record(error)
        }
        resultsTask?.cancel()
        lock.withLock { finished = true }

        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queue.async { self.file = nil; done.resume() }   // closes the .caf
        }
    }
}

// MARK: - Format conversion

/// Streaming converter to a fixed output format. Rebuilds itself when the input format
/// changes (e.g. mic device switch). Uses `.noDataNow` so resampler state carries over
/// between buffers instead of being flushed each call.
final class StreamingConverter {
    private let output: AVAudioFormat
    private var converter: AVAudioConverter?

    init(output: AVAudioFormat) {
        self.output = output
    }

    func convert(_ input: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer? {
        if converter == nil || converter?.inputFormat != input.format {
            guard let c = AVAudioConverter(from: input.format, to: output) else {
                throw MeetingRecorderError.conversionFailed("\(input.format)")
            }
            c.downmix = true
            converter = c
        }
        guard let converter else { return nil }

        let ratio = output.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount((Double(input.frameLength) * ratio).rounded(.up)) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else {
            throw MeetingRecorderError.conversionFailed("\(input.format)")
        }

        var supplied = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return input
        }
        if status == .error {
            throw error ?? MeetingRecorderError.conversionFailed("\(input.format)")
        }
        return out.frameLength > 0 ? out : nil
    }
}

// MARK: - Segment batching

/// Collects finalized segments from both channels and writes them in batches: every
/// `flushInterval` seconds or `maxBatch` segments, whichever comes first.
final class SegmentBatcher {
    private static let flushInterval: TimeInterval = 5
    private static let maxBatch = 25

    private let meetingId: Int64
    private let queue = DispatchQueue(label: "com.kealjones.apotheosis.meeting.segments", qos: .utility)
    private var timer: DispatchSourceTimer?

    private let lock = NSLock()
    private var pending: [MeetingSegment] = []
    private var writeFailed = false
    private(set) var totalWritten = 0

    init(meetingId: Int64) {
        self.meetingId = meetingId
    }

    func start() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + Self.flushInterval, repeating: Self.flushInterval)
        t.setEventHandler { [weak self] in self?.flush() }
        t.resume()
        timer = t
    }

    func add(_ segment: MeetingSegment) {
        let full = lock.withLock { () -> Bool in
            pending.append(segment)
            return pending.count >= Self.maxBatch
        }
        if full { queue.async { self.flush() } }
    }

    /// Stops the timer and writes whatever is left. Returns false if any batch failed.
    func stop() -> Bool {
        timer?.cancel()
        timer = nil
        queue.sync { flush() }
        return lock.withLock { !writeFailed }
    }

    /// Runs on `queue` only, so batches are written in order.
    private func flush() {
        let batch = lock.withLock { () -> [MeetingSegment] in
            defer { pending.removeAll() }
            return pending
        }
        guard !batch.isEmpty else { return }
        let ok = Store.shared.insertSegments(meetingId: meetingId, batch)
        lock.withLock {
            if ok { totalWritten += batch.count } else { writeFailed = true }
        }
    }
}

// MARK: - Timeout

struct TimeoutError: Error {}

/// Races `operation` against a deadline. Unlike a task group, this returns at the
/// deadline even if `operation` ignores cancellation (it is cancelled and abandoned).
func withTimeout<T>(seconds: Double, _ operation: @escaping () async throws -> T) async throws -> T {
    let claimed = NSLock()
    var resumed = false
    func claim() -> Bool { claimed.withLock { defer { resumed = true }; return !resumed } }

    return try await withCheckedThrowingContinuation { continuation in
        let work = Task {
            do {
                let value = try await operation()
                if claim() { continuation.resume(returning: value) }
            } catch {
                if claim() { continuation.resume(throwing: error) }
            }
        }
        Task {
            try? await Task.sleep(for: .seconds(seconds))
            if claim() {
                work.cancel()
                continuation.resume(throwing: TimeoutError())
            }
        }
    }
}
