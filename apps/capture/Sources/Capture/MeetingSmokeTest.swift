import Foundation

/// `Capture --smoke-meeting ...` runs one meeting through the real `MeetingRecorder`
/// pipeline (conversion, .caf writing, two analyzers, batched segment writes, status and
/// cleanup) without the menu bar app or meeting detection.
///
///   --me <file> --them <file> [--speed N] [--fail-them-after S]   replay audio files
///   --live --duration S                                           real mic + system audio
///
/// Refuses to run unless `DATA_DIR` is set, so it can never touch the real database.
@available(macOS 26.0, *)
enum MeetingSmokeTest {
    static func run(_ args: [String]) -> Never {
        guard let dataDir = ProcessInfo.processInfo.environment["DATA_DIR"], !dataDir.isEmpty else {
            print("smoke: refusing to run without DATA_DIR (would write to the real database)")
            exit(2)
        }
        func value(_ flag: String) -> String? {
            args.firstIndex(of: flag).flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil }
        }

        Task {
            let startedAt = Date()
            let id = Store.shared.insertMeeting(
                startedAt: Int64(startedAt.timeIntervalSince1970), endedAt: nil, platform: "unknown",
                externalId: nil, title: "smoke test", url: nil,
                transcriptStatus: TranscriptStatus.recording.rawValue,
                audioPath: nil
            )

            var sources: [AudioChannel: AudioSource] = [:]
            var fileSources: [FileAudioSource] = []
            if args.contains("--live") {
                sources = [.me: MicAudioSource(), .them: SystemAudioSource()]
            } else {
                let speed = value("--speed").flatMap(Double.init) ?? 1
                let failAfter = value("--fail-them-after").flatMap(Double.init)
                let me = FileAudioSource(url: URL(fileURLWithPath: value("--me") ?? ""), speed: speed)
                let them = FileAudioSource(url: URL(fileURLWithPath: value("--them") ?? ""), speed: speed, failAfterSeconds: failAfter)
                sources = [.me: me, .them: them]
                fileSources = [me, them]
            }

            do {
                let recorder = try MeetingRecorder(meetingId: id, startedAt: startedAt, sources: sources)
                Store.shared.updateMeeting(id: id, endedAt: nil, transcriptStatus: TranscriptStatus.recording.rawValue, audioPath: recorder.directory.path)
                print("smoke: meeting \(id), DATA_DIR=\(dataDir), pid=\(getpid())")
                await recorder.start()

                if args.contains("--live") {
                    let duration = value("--duration").flatMap(Double.init) ?? 30
                    let deadline = Date().addingTimeInterval(duration)
                    while Date() < deadline {
                        try? await Task.sleep(for: .seconds(5))
                        print("smoke: other process using mic = \(MicrophoneMonitor.isInUse())")
                    }
                } else {
                    for source in fileSources { await source.waitUntilFinished() }
                }

                let status = await recorder.finish(endedAt: Int64(Date().timeIntervalSince1970))
                print("smoke: final status = \(status.rawValue), elapsed \(Int(Date().timeIntervalSince(startedAt)))s")
                exit(0)
            } catch {
                print("smoke: could not create recorder: \(error)")
                exit(1)
            }
        }
        dispatchMain()
    }
}
