import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

/// A producer of PCM buffers in whatever native format it has. `MeetingRecorder`'s
/// pipeline converts everything to the analyzer format, so sources never convert.
///
/// `onBuffer` is called serially from a single source-owned thread/queue. The buffer is
/// only guaranteed valid for the duration of the call.
protocol AudioSource: AnyObject {
    func start(onBuffer: @escaping (AVAudioPCMBuffer) -> Void, onError: @escaping (Error) -> Void) async throws
    func stop() async
}

enum AudioSourceError: Error, CustomStringConvertible {
    case microphoneDenied
    case noInputDevice
    case noDisplay
    case screenRecordingDenied
    case injectedFailure(seconds: Double)

    var description: String {
        switch self {
        case .microphoneDenied: return "microphone access denied (System Settings > Privacy & Security > Microphone)"
        case .noInputDevice: return "no usable audio input device"
        case .noDisplay: return "no display available for ScreenCaptureKit audio capture"
        case .screenRecordingDenied: return "screen recording access denied (needed for system audio; System Settings > Privacy & Security > Screen Recording)"
        case .injectedFailure(let s): return "injected source failure after \(s)s (smoke test)"
        }
    }
}

// MARK: - Microphone ("me")

/// Mic capture via an `AVAudioEngine` input tap, in the device's native format
/// (48kHz Float32 on the machine A1 was measured on).
///
/// `@unchecked Sendable`: the engine is touched from the caller and from the
/// configuration-change notification; `lock` serializes both.
final class MicAudioSource: AudioSource, @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var configObserver: NSObjectProtocol?
    private var stopped = false

    func start(onBuffer: @escaping (AVAudioPCMBuffer) -> Void, onError: @escaping (Error) -> Void) async throws {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .audio) else { throw AudioSourceError.microphoneDenied }
        default:
            throw AudioSourceError.microphoneDenied
        }

        try installTapAndStart(onBuffer: onBuffer)

        // Plugging in headphones / switching the default input mid-call stops the engine
        // and changes the input format. Reinstall the tap in the new format and restart;
        // the pipeline's converter rebuilds itself when it sees the new format.
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            print("[MeetingRecorder] Mic configuration changed, restarting input tap")
            do { try self?.installTapAndStart(onBuffer: onBuffer) } catch { onError(error) }
        }
    }

    private func installTapAndStart(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return }
        engine.stop()
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw AudioSourceError.noInputDevice }
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in onBuffer(buffer) }
        engine.prepare()
        try engine.start()
    }

    func stop() async {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        lock.withLock {
            stopped = true
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
    }
}

// MARK: - System audio ("them")

/// System audio via `SCStream` (`capturesAudio`). Covers every app's output, so the far
/// side of any call lands here regardless of platform. Our own process is excluded.
final class SystemAudioSource: NSObject, AudioSource, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var onBuffer: ((AVAudioPCMBuffer) -> Void)?
    private var restartTask: Task<Void, Never>?
    private static let restartInterval: Double = 5
    private let outputQueue = DispatchQueue(label: "com.kealjones.apotheosis.meeting.systemaudio", qos: .userInitiated)

    func start(onBuffer: @escaping (AVAudioPCMBuffer) -> Void, onError: @escaping (Error) -> Void) async throws {
        self.onBuffer = onBuffer

        // Without the grant, SCShareableContent returns an empty display list rather than
        // throwing, which would otherwise surface as a misleading "no display".
        guard CGPreflightScreenCaptureAccess() else { throw AudioSourceError.screenRecordingDenied }
        try await startStream()
    }

    private func startStream() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw AudioSourceError.noDisplay }

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.sampleRate = 16000
        config.channelCount = 1
        config.excludesCurrentProcessAudio = true
        // Video is unused; keep it as cheap as ScreenCaptureKit allows.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: outputQueue)
        // A screen output is registered (and ignored) so SCStream doesn't log a
        // "stream output NOT found" line for every dropped video frame.
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: outputQueue)
        try await stream.startCapture()
        self.stream = stream
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, let pcm = Self.pcmBuffer(from: sampleBuffer) else { return }
        onBuffer?(pcm)
    }

    /// SCStream stops when the screen locks or the display sleeps ("Failed to find any
    /// displays or windows to capture"), which is routine during a long call. Keep
    /// retrying instead of failing the channel; the pipeline fills the gap with silence
    /// so later segments keep their real timestamps.
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        print("[MeetingRecorder] system audio stream stopped (\(error)); retrying every \(Int(Self.restartInterval))s")
        self.stream = nil
        restartTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.restartInterval))
                guard let self, !Task.isCancelled else { return }
                do {
                    try await self.startStream()
                    print("[MeetingRecorder] system audio stream restarted")
                    return
                } catch {
                    continue
                }
            }
        }
    }

    func stop() async {
        restartTask?.cancel()
        restartTask = nil
        try? await stream?.stopCapture()
        stream = nil
    }

    /// `AnalyzerInput` and `AVAudioFile` only take `AVAudioPCMBuffer`, so copy the
    /// `CMSampleBuffer`'s audio out. This is the A1 spike's code verbatim in behaviour,
    /// since it is the version validated against real SCStream output.
    private static func pcmBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let desc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc),
              let format = AVAudioFormat(streamDescription: asbd) else { return nil }
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frames > 0,
              let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return nil }
        pcm.frameLength = AVAudioFrameCount(frames)

        var blockBuffer: CMBlockBuffer?
        let listSize = AudioBufferList.sizeInBytes(maximumBuffers: Int(asbd.pointee.mChannelsPerFrame))
        let raw = UnsafeMutableRawPointer.allocate(byteCount: listSize, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: listSize,
            blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0, blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return nil }

        let src = UnsafeMutableAudioBufferListPointer(list)
        let dst = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
        for i in 0..<min(src.count, dst.count) {
            guard let s = src[i].mData, let d = dst[i].mData else { continue }
            let bytes = min(Int(src[i].mDataByteSize), Int(dst[i].mDataByteSize))
            memcpy(d, s, bytes)
            dst[i].mDataByteSize = UInt32(bytes)
        }
        return pcm
    }
}

// MARK: - File (smoke tests, and the future catch-up/retry pass)

/// Replays an audio file as if it were a live source. `speed` 1 = real time,
/// 0 = as fast as possible. `failAfterSeconds` injects a source error partway through.
final class FileAudioSource: AudioSource {
    private let url: URL
    private let speed: Double
    private let failAfterSeconds: Double?
    private var task: Task<Void, Never>?

    init(url: URL, speed: Double = 1, failAfterSeconds: Double? = nil) {
        self.url = url
        self.speed = speed
        self.failAfterSeconds = failAfterSeconds
    }

    func start(onBuffer: @escaping (AVAudioPCMBuffer) -> Void, onError: @escaping (Error) -> Void) async throws {
        let file = try AVAudioFile(forReading: url)
        let format = file.processingFormat
        let chunkSeconds = 0.1
        let chunkFrames = AVAudioFrameCount(format.sampleRate * chunkSeconds)
        let speed = self.speed
        let failAfter = failAfterSeconds

        task = Task.detached {
            var elapsed = 0.0
            // Check position ourselves: reading at EOF throws a nil error rather than
            // returning zero frames.
            while !Task.isCancelled, file.framePosition < file.length {
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkFrames) else { return }
                do { try file.read(into: buffer, frameCount: chunkFrames) } catch { onError(error); return }
                if let failAfter, elapsed >= failAfter {
                    onError(AudioSourceError.injectedFailure(seconds: failAfter))
                    return
                }
                onBuffer(buffer)
                elapsed += Double(buffer.frameLength) / format.sampleRate
                if speed > 0 { try? await Task.sleep(for: .seconds(chunkSeconds / speed)) }
            }
        }
    }

    /// Returns once the whole file has been delivered (or the source failed).
    func waitUntilFinished() async {
        await task?.value
    }

    func stop() async {
        task?.cancel()
        await task?.value
    }
}
