import Foundation

/// Removes "me" segments that are really the call audio leaking from the speakers into the
/// mic. Without headphones nearly every "them" line shows up a second time on "me", often
/// slightly garbled ("Dar decoupling" vs "Darcy coupling").
///
/// A "me" segment counts as echo when at least half its words fuzzily match words "them"
/// said within `windowMs` of it. Tuned on a real 53-minute speakers-on call: 552 "me"
/// segments down to ~100, and what remains reads as the user's own speech. Short real
/// replies that happen to repeat a nearby word ("yeah") can be dropped too; that is the
/// accepted cost.
enum EchoFilter {
    struct Segment {
        let id: Int64
        let startedMs: Int64
        let endedMs: Int64
        let channel: AudioChannel
        let text: String
    }

    static let windowMs: Int64 = 5000
    static let matchThreshold = 0.5
    static let wordSimilarity = 0.75

    /// Ids of "me" segments to delete.
    static func echoIds(in segments: [Segment]) -> [Int64] {
        let them = segments.filter { $0.channel == .them }.map { ($0, words($0.text)) }
        return segments.filter { $0.channel == .me }.compactMap { me in
            let mine = words(me.text)
            guard !mine.isEmpty else { return me.id }
            let pool = Set(them.filter { $0.0.startedMs <= me.endedMs + windowMs && $0.0.endedMs >= me.startedMs - windowMs }
                .flatMap(\.1))
            guard !pool.isEmpty else { return nil }
            let matched = mine.filter { w in pool.contains(w) || (w.count > 2 && pool.contains { similarity(w, $0) >= wordSimilarity }) }
            return Double(matched.count) / Double(mine.count) >= matchThreshold ? me.id : nil
        }
    }

    /// Deletes echo segments for a finished meeting. Returns how many were removed.
    @discardableResult
    static func apply(meetingId: Int64) -> Int {
        let ids = echoIds(in: Store.shared.fetchSegments(meetingId: meetingId))
        Store.shared.deleteSegments(ids: ids)
        print("[EchoFilter] meeting \(meetingId): removed \(ids.count) echoed mic segments")
        return ids.count
    }

    private static func words(_ text: String) -> [String] {
        text.lowercased().split { !($0.isLetter || $0.isNumber || $0 == "'") }.map(String.init)
    }

    /// 1 - Levenshtein distance / longer length.
    private static func similarity(_ a: String, _ b: String) -> Double {
        let a = Array(a), b = Array(b)
        guard !a.isEmpty, !b.isEmpty else { return 0 }
        var prev = Array(0...b.count)
        for i in 1...a.count {
            var cur = [i] + Array(repeating: 0, count: b.count)
            for j in 1...b.count {
                cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1))
            }
            prev = cur
        }
        return 1 - Double(prev[b.count]) / Double(max(a.count, b.count))
    }
}
