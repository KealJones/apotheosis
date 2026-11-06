import Foundation

/// Raw access to `user-config.json` in the data dir. The file is tiny, so callers re-read it
/// whenever they need fresh values; edits then apply without restarting the daemon.
enum UserConfigFile {
    static let url = Store.dataDirectory.appendingPathComponent("user-config.json")

    static func read() -> [String: Any]? {
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json
    }

    /// Read-modify-write, so keys this daemon doesn't know about survive untouched.
    static func update(_ mutate: (inout [String: Any]) -> Void) throws {
        var root = read() ?? [:]
        mutate(&root)
        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
    }
}

/// `capture.*` keys in `user-config.json`: when and how often activity is captured.
///
/// ```json
/// "capture": {
///   "interval_seconds": 15,
///   "days": ["mon", "tue", "wed", "thu", "fri"],
///   "start_time": "00:00",
///   "end_time": "24:00",
///   "idle_after_seconds": 300
/// }
/// ```
/// Every key is optional; missing or invalid values fall back to these defaults. The
/// window is local time, `start_time` inclusive and `end_time` exclusive. An end earlier
/// than the start wraps past midnight (e.g. "22:00" to "06:00").
struct CaptureSchedule: Equatable {
    var intervalSeconds: Int
    /// `Calendar` weekday numbers: 1 = Sunday ... 7 = Saturday.
    var days: Set<Int>
    var startMinute: Int
    var endMinute: Int
    var idleAfterSeconds: Int

    static let `default` = CaptureSchedule(
        intervalSeconds: 15, days: [2, 3, 4, 5, 6], startMinute: 0, endMinute: 24 * 60, idleAfterSeconds: 300
    )

    private static let dayNames = ["sun": 1, "mon": 2, "tue": 3, "wed": 4, "thu": 5, "fri": 6, "sat": 7]

    static func load() -> CaptureSchedule {
        guard let capture = UserConfigFile.read()?["capture"] as? [String: Any] else { return .default }
        var s = CaptureSchedule.default

        if let n = capture["interval_seconds"] as? Int {
            // Below 5s the screenshot + OCR work can't keep up; above an hour it isn't a timeline.
            s.intervalSeconds = min(max(n, 5), 3600)
        }
        if let names = capture["days"] as? [String] {
            let parsed = Set(names.compactMap { dayNames[String($0.lowercased().prefix(3))] })
            if !parsed.isEmpty || names.isEmpty { s.days = parsed }
        }
        if let t = capture["start_time"] as? String, let m = minute(of: t) { s.startMinute = m }
        if let t = capture["end_time"] as? String, let m = minute(of: t) { s.endMinute = m }
        if let n = capture["idle_after_seconds"] as? Int { s.idleAfterSeconds = max(n, 30) }
        return s
    }

    /// "HH:MM" to minutes since midnight. "24:00" is allowed as an end of day.
    private static func minute(of time: String) -> Int? {
        let parts = time.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2, (0...24).contains(parts[0]), (0...59).contains(parts[1]) else { return nil }
        let m = parts[0] * 60 + parts[1]
        return m <= 24 * 60 ? m : nil
    }

    /// Whether `date` falls inside the configured days and time window.
    func isActive(at date: Date = Date(), calendar: Calendar = .current) -> Bool {
        let c = calendar.dateComponents([.weekday, .hour, .minute], from: date)
        guard let weekday = c.weekday, let hour = c.hour, let minute = c.minute else { return false }
        let now = hour * 60 + minute
        if startMinute <= endMinute {
            return days.contains(weekday) && now >= startMinute && now < endMinute
        }
        // Overnight window: the part after midnight belongs to the previous day's session.
        if now >= startMinute { return days.contains(weekday) }
        if now < endMinute { return days.contains(weekday == 1 ? 7 : weekday - 1) }
        return false
    }
}
