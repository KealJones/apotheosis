import Foundation

/// Deletes old capture data. Two jobs:
///
/// - Leftover screenshots. OCR deletes each screenshot as soon as it has the text, so
///   any image file older than a day is one whose OCR never ran (the daemon quit with
///   it queued). Those are always removed, except ones belonging to evidence samples.
/// - Raw rows, only when `capture.retention_days` is set in `user-config.json`:
///   samples, context events, Slack messages, meeting transcripts and meeting audio
///   older than that many days. Samples marked as evidence, meeting rows with their
///   summaries, and everything derived (standups, to-dos, projects, ideas) are kept.
final class Retention {
    static let shared = Retention()

    private let queue = DispatchQueue(label: "com.kealjones.apotheosis.retention", qos: .background)
    private var timer: DispatchSourceTimer?

    /// `capture.retention_days`, or nil (keep forever) when missing or not positive.
    static func retentionDays() -> Int? {
        let capture = UserConfigFile.read()?["capture"] as? [String: Any]
        guard let n = capture?["retention_days"] as? Int, n > 0 else { return nil }
        return n
    }

    /// Runs a minute after launch, then every 6 hours.
    func start() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 60, repeating: 6 * 60 * 60)
        t.setEventHandler { [weak self] in self?.run() }
        t.resume()
        timer = t
    }

    func run(now: Date = Date()) {
        var files = sweepScreenshots(olderThan: now.addingTimeInterval(-86_400))
        var rows = 0
        if let days = Self.retentionDays() {
            let cutoff = Int64(now.timeIntervalSince1970) - Int64(days) * 86_400
            let result = Store.shared.deleteRawRows(before: cutoff)
            rows = result.rows
            files += delete(result.meetingAudio)
        }
        if files > 0 || rows > 0 {
            print("[Retention] Deleted \(rows) row(s) and \(files) file(s)")
        }
    }

    /// Removes screenshot files modified before `cutoff`, then any day folder left empty.
    private func sweepScreenshots(olderThan cutoff: Date) -> Int {
        let fm = FileManager.default
        let dir = Store.dataDirectory.appendingPathComponent("screenshots", isDirectory: true)
        guard let days = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return 0 }
        let evidence = Store.shared.evidenceScreenshotPaths()
        var count = 0
        for day in days {
            let files = (try? fm.contentsOfDirectory(
                at: day, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
            for file in files where !evidence.contains(file.path) {
                let modified = try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
                if let modified, modified < cutoff, (try? fm.removeItem(at: file)) != nil { count += 1 }
            }
            // Only old folders: today's may be empty for a moment between CaptureLoop
            // creating it and writing the first screenshot.
            let dayModified = try? day.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
            if let dayModified, dayModified < cutoff,
               (try? fm.contentsOfDirectory(atPath: day.path))?.isEmpty == true {
                try? fm.removeItem(at: day)
            }
        }
        return count
    }

    /// Deletes files or folders, but only inside the data directory, so a bad path in the
    /// database can never reach anything else.
    private func delete(_ paths: [String]) -> Int {
        let root = Store.dataDirectory.standardizedFileURL.path + "/"
        var count = 0
        for path in paths {
            let url = URL(fileURLWithPath: path).standardizedFileURL
            guard url.path.hasPrefix(root) else {
                print("[Retention] Refusing to delete outside the data directory: \(path)")
                continue
            }
            if (try? FileManager.default.removeItem(at: url)) != nil { count += 1 }
        }
        return count
    }
}
