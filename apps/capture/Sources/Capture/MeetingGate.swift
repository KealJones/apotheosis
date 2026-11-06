import Foundation

/// What `MeetingDetector` should do with a just-detected meeting, given `MeetingConfig`.
/// `MeetingDetector.startRecorder` is the only place a `MeetingRecorder` gets created, and
/// it is only ever reached via `.recordImmediately` (directly, or after `.needsConsent`
/// resolves to Record/Always) — never from any `.skip*` case.
enum MeetingGateResult: Equatable {
    /// Auto mode, or the room is on `meetings.always_record_rooms` — start recording now.
    case recordImmediately
    /// `ask` mode, room not pre-approved — prompt via `MeetingConsent` before recording.
    case needsConsent
    case skipOSUnavailable
    case skipDisabled
    case skipBlocklisted(match: String)
    case skipDomainNotAllowed
}

/// Pure decision function for A4's consent gate — no I/O, no singletons, so every branch
/// is exhaustively unit-testable (see `MeetingGateSmokeTest`) without needing to fake
/// microphone state or `NSWorkspace`.
enum MeetingGate {
    static func decide(
        config: MeetingConfig,
        canRecordOS: Bool,
        title: String?,
        url: String?,
        roomKey: String?
    ) -> MeetingGateResult {
        guard canRecordOS else { return .skipOSUnavailable }
        guard config.enabled, config.mode != "off" else { return .skipDisabled }

        if let title, let hit = config.blocklist.first(where: { title.localizedCaseInsensitiveContains($0) }) {
            return .skipBlocklisted(match: hit)
        }
        if !config.domainAllowlist.isEmpty, let url,
           !config.domainAllowlist.contains(where: { url.localizedCaseInsensitiveContains($0) }) {
            return .skipDomainNotAllowed
        }

        let alwaysAllowed = roomKey.map { config.alwaysRecordRooms.contains($0) } ?? false
        return (config.mode == "auto" || alwaysAllowed) ? .recordImmediately : .needsConsent
    }
}
