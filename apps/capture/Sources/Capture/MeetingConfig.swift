import Foundation

/// `meetings.*` keys in `user-config.json` — the consent/privacy controls that gate
/// whether `MeetingDetector` is allowed to hand a detected meeting to `MeetingRecorder`.
/// Read via `UserConfigFile` (plain `JSONSerialization`, not `Codable`). Loaded fresh on
/// every detection tick so edits apply without restarting the daemon.
///
/// Naming decision (A4): A3 wrote a top-level `keep_meeting_audio` key. This nests it
/// under `meetings.keep_audio` for consistency with every other A4 key, but still reads
/// the old top-level key as a fallback so a config file written before this change keeps
/// working. `meetings.keep_audio` wins if both are present; new configs should only set
/// the nested one.
struct MeetingConfig {
    /// Opt-in: recording is off unless explicitly enabled.
    var enabled: Bool
    /// "ask" (default, prompt before recording) | "auto" (record without prompting) |
    /// "off" (same as `enabled = false` for recording purposes).
    var mode: String
    var keepAudio: Bool
    /// Meet/Zoom/etc domains a meeting's URL must match to record. Empty means no
    /// domain restriction.
    var domainAllowlist: [String]
    /// Case-insensitive substring match against the meeting's title/tab title. Any hit
    /// skips recording.
    var blocklist: [String]
    /// Rooms (external_id, or URL when there's no external id) durably approved via the
    /// consent prompt's "Always for this room" action — skip the prompt and record.
    var alwaysRecordRooms: [String]

    static let disabled = MeetingConfig(
        enabled: false, mode: "off", keepAudio: false,
        domainAllowlist: [], blocklist: [], alwaysRecordRooms: []
    )

    static func load() -> MeetingConfig {
        guard let root = UserConfigFile.read() else { return .disabled }
        guard let meetings = root["meetings"] as? [String: Any] else {
            // No `meetings` key at all: still honor the legacy top-level keep-audio flag
            // so pre-A4 configs don't lose that setting, but recording stays opt-in.
            let legacyKeepAudio = root["keep_meeting_audio"] as? Bool ?? false
            return MeetingConfig(enabled: false, mode: "off", keepAudio: legacyKeepAudio,
                                  domainAllowlist: [], blocklist: [], alwaysRecordRooms: [])
        }

        let keepAudio = meetings["keep_audio"] as? Bool ?? root["keep_meeting_audio"] as? Bool ?? false
        return MeetingConfig(
            enabled: meetings["enabled"] as? Bool ?? false,
            mode: meetings["mode"] as? String ?? "ask",
            keepAudio: keepAudio,
            domainAllowlist: meetings["domain_allowlist"] as? [String] ?? [],
            blocklist: meetings["blocklist"] as? [String] ?? [],
            alwaysRecordRooms: meetings["always_record_rooms"] as? [String] ?? []
        )
    }

    /// Persists the consent prompt's "Always for this room" choice: appends `roomKey` to
    /// `meetings.always_record_rooms`. Read-modify-write so unrelated top-level keys
    /// (`github_username`, `mention_patterns`, etc.) survive untouched.
    static func rememberAlwaysRecord(roomKey: String) {
        do {
            try UserConfigFile.update { root in
                var meetings = root["meetings"] as? [String: Any] ?? [:]
                var rooms = meetings["always_record_rooms"] as? [String] ?? []
                guard !rooms.contains(roomKey) else { return }
                rooms.append(roomKey)
                meetings["always_record_rooms"] = rooms
                root["meetings"] = meetings
            }
            print("[MeetingConfig] Remembered \"always record\" for room \(roomKey)")
        } catch {
            print("[MeetingConfig] Could not persist always-record room \(roomKey): \(error)")
        }
    }
}
