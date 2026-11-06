import Foundation

/// `Capture --smoke-consent-gate` exercises the real `MeetingConfig`/`MeetingConsent`
/// code (not a reimplementation of it) against a throwaway `user-config.json`, without
/// needing the menu bar app, real meeting detection, or an interactive 20s wait. Covers
/// what A4's acceptance criteria can't be driven end-to-end as a background agent:
/// the opt-in default, the blocklist/domain-allowlist gates, the keep-audio naming
/// migration, "always for this room" persistence, and the consent-timeout default.
///
/// Refuses to run unless `DATA_DIR` is set, same guard as `MeetingSmokeTest`.
enum MeetingGateSmokeTest {
    static func run() -> Never {
        guard let dataDir = ProcessInfo.processInfo.environment["DATA_DIR"], !dataDir.isEmpty else {
            print("smoke: refusing to run without DATA_DIR (would touch the real config file)")
            exit(2)
        }

        var failures = 0
        func check(_ name: String, _ condition: @autoclosure () -> Bool) {
            let ok = condition()
            print("[\(ok ? "PASS" : "FAIL")] \(name)")
            if !ok { failures += 1 }
        }

        let configURL = URL(fileURLWithPath: dataDir, isDirectory: true).appendingPathComponent("user-config.json")
        func write(_ json: [String: Any]) {
            let data = try! JSONSerialization.data(withJSONObject: json)
            try! data.write(to: configURL)
        }

        // 1. No config file at all: recording stays opt-in (the actual acceptance
        // criterion — no file, no `meetings` key, nothing to accidentally record with).
        try? FileManager.default.removeItem(at: configURL)
        var cfg = MeetingConfig.load()
        check("no config file => enabled=false", cfg.enabled == false)
        check("no config file => mode=off", cfg.mode == "off")

        // 2. Explicit `meetings.enabled=false`.
        write(["meetings": ["enabled": false]])
        cfg = MeetingConfig.load()
        check("explicit enabled=false => enabled=false", cfg.enabled == false)

        // 3. Enabled + auto + blocklist, matching MeetingDetector's actual match logic.
        write(["meetings": ["enabled": true, "mode": "auto", "blocklist": ["1:1", "therapy"]]])
        cfg = MeetingConfig.load()
        check("enabled=true round-trips", cfg.enabled == true)
        check("mode=auto round-trips", cfg.mode == "auto")
        let title = "Weekly 1:1 with Sam"
        let hit = cfg.blocklist.first(where: { title.localizedCaseInsensitiveContains($0) })
        check("blocklist matches title substring case-insensitively", hit == "1:1")

        // 4. Domain allowlist.
        write(["meetings": ["enabled": true, "domain_allowlist": ["meet.google.com"]]])
        cfg = MeetingConfig.load()
        check("domain_allowlist round-trips", cfg.domainAllowlist == ["meet.google.com"])
        let url = "https://meet.google.com/abc-defg-hij"
        check("domain_allowlist matches a real meeting url",
              cfg.domainAllowlist.contains { url.localizedCaseInsensitiveContains($0) })

        // 5. keep_audio naming migration: legacy top-level key still honored...
        write(["keep_meeting_audio": true])
        cfg = MeetingConfig.load()
        check("legacy top-level keep_meeting_audio honored as fallback", cfg.keepAudio == true)
        // ...but the new nested key wins when both are present.
        write(["meetings": ["enabled": true, "keep_audio": true], "keep_meeting_audio": false])
        cfg = MeetingConfig.load()
        check("meetings.keep_audio takes priority over legacy top-level key", cfg.keepAudio == true)

        // 6. "Always for this room" persistence round-trip, including that unrelated
        // sibling keys in `meetings` survive the read-modify-write.
        write(["meetings": ["enabled": true, "mode": "ask"]])
        MeetingConfig.rememberAlwaysRecord(roomKey: "abc-defg-hij")
        cfg = MeetingConfig.load()
        check("rememberAlwaysRecord persists the room", cfg.alwaysRecordRooms.contains("abc-defg-hij"))
        check("rememberAlwaysRecord preserves sibling meetings.* keys", cfg.enabled == true && cfg.mode == "ask")
        MeetingConfig.rememberAlwaysRecord(roomKey: "abc-defg-hij")
        cfg = MeetingConfig.load()
        check("rememberAlwaysRecord does not duplicate an already-remembered room",
              cfg.alwaysRecordRooms.filter { $0 == "abc-defg-hij" }.count == 1)

        // 7. MeetingGate.decide: the actual gate MeetingDetector calls, exercised
        // exhaustively since it's pure (no mic/NSWorkspace faking needed). This is the
        // real proof that "meetings.enabled=false => no recorder ever starts": every
        // path but `.recordImmediately`/`.needsConsent` is a skip, and only those two
        // ever reach `MeetingDetector.startRecorder`.
        let disabledCfg = MeetingConfig(enabled: false, mode: "off", keepAudio: false,
                                         domainAllowlist: [], blocklist: [], alwaysRecordRooms: [])
        check("gate: enabled=false => skipDisabled",
              MeetingGate.decide(config: disabledCfg, canRecordOS: true, title: "Standup", url: nil, roomKey: nil) == .skipDisabled)
        check("gate: no config file default (MeetingConfig.disabled) => skipDisabled",
              MeetingGate.decide(config: .disabled, canRecordOS: true, title: nil, url: nil, roomKey: nil) == .skipDisabled)
        check("gate: canRecordOS=false => skipOSUnavailable regardless of config",
              MeetingGate.decide(config: MeetingConfig(enabled: true, mode: "auto", keepAudio: false, domainAllowlist: [], blocklist: [], alwaysRecordRooms: []),
                                  canRecordOS: false, title: nil, url: nil, roomKey: nil) == .skipOSUnavailable)

        let blocklistCfg = MeetingConfig(enabled: true, mode: "auto", keepAudio: false,
                                          domainAllowlist: [], blocklist: ["1:1", "therapy"], alwaysRecordRooms: [])
        check("gate: blocklisted title => skipBlocklisted(\"1:1\")",
              MeetingGate.decide(config: blocklistCfg, canRecordOS: true, title: "Weekly 1:1 with Sam", url: nil, roomKey: nil) == .skipBlocklisted(match: "1:1"))
        check("gate: non-blocklisted title in auto mode => recordImmediately",
              MeetingGate.decide(config: blocklistCfg, canRecordOS: true, title: "Sprint planning", url: nil, roomKey: nil) == .recordImmediately)

        let domainCfg = MeetingConfig(enabled: true, mode: "auto", keepAudio: false,
                                       domainAllowlist: ["meet.google.com"], blocklist: [], alwaysRecordRooms: [])
        check("gate: url outside domain_allowlist => skipDomainNotAllowed",
              MeetingGate.decide(config: domainCfg, canRecordOS: true, title: nil, url: "https://zoom.us/j/12345", roomKey: nil) == .skipDomainNotAllowed)
        check("gate: url inside domain_allowlist => recordImmediately",
              MeetingGate.decide(config: domainCfg, canRecordOS: true, title: nil, url: "https://meet.google.com/abc-defg-hij", roomKey: nil) == .recordImmediately)
        check("gate: native app meeting (no url) bypasses domain_allowlist",
              MeetingGate.decide(config: domainCfg, canRecordOS: true, title: nil, url: nil, roomKey: nil) == .recordImmediately)

        let askCfg = MeetingConfig(enabled: true, mode: "ask", keepAudio: false,
                                    domainAllowlist: [], blocklist: [], alwaysRecordRooms: ["always-room"])
        check("gate: ask mode, unknown room => needsConsent",
              MeetingGate.decide(config: askCfg, canRecordOS: true, title: nil, url: nil, roomKey: "new-room") == .needsConsent)
        check("gate: ask mode, room on always_record_rooms => recordImmediately (skips the prompt)",
              MeetingGate.decide(config: askCfg, canRecordOS: true, title: nil, url: nil, roomKey: "always-room") == .recordImmediately)

        // 8. Consent prompt defaults to .skip when nothing responds in time — exercised
        // for real with a short timeout instead of the interactive 20s wait.
        let group = DispatchGroup()
        group.enter()
        Task {
            let decision = await MeetingConsent.shared.ask(
                meetingId: 999_999, title: "smoke test meeting", platform: .zoom, timeout: 0.3
            )
            if case .skip = decision {
                check("consent prompt times out to .skip", true)
            } else {
                check("consent prompt times out to .skip", false)
            }
            group.leave()
        }
        group.wait()

        // URL matching: join codes directly under the host or behind extra path segments.
        for url in ["https://meet.google.com/tuu-pzie-kgd",
                    "https://meet.google.com/meet/tuu-pzie-kgd?authuser=0"] {
            let match = MeetingURLMatcher.match(url: url)
            check("matches Meet code in \(url)", match == MeetingURLMatch(platform: .googleMeet, externalId: "tuu-pzie-kgd"))
        }
        check("Meet landing page has no match", MeetingURLMatcher.match(url: "https://meet.google.com/landing") == nil)

        print("smoke-consent-gate: \(failures == 0 ? "ALL PASS" : "\(failures) FAILURE(S)")")
        exit(failures == 0 ? 0 : 1)
    }
}
