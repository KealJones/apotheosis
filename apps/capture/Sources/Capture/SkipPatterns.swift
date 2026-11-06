import Foundation

/// Config-driven skip patterns loaded from `skip-patterns.json`.
/// Edit the JSON file in ~/Library/Application Support/apotheosis/ to customize.
final class SkipPatterns {
    static let shared = SkipPatterns()

    private var config: SkipPatternsConfig

    private init() {
        config = SkipPatterns.load()
    }

    // MARK: - Public API

    func shouldSkip(bundle: String?, windowTitle: String?) -> Bool {
        guard let bundle else { return true }

        // Exact bundle blocklist
        if config.bundleBlocklist.contains(bundle) { return true }

        // Bundle keyword substring match
        let lowerBundle = bundle.lowercased()
        for keyword in config.bundleKeywords {
            if lowerBundle.contains(keyword.lowercased()) { return true }
        }

        if let windowTitle, matchesSensitiveName(windowTitle) { return true }

        return false
    }

    /// Whether a window title or file path contains one of `windowTitlePatterns`.
    func matchesSensitiveName(_ text: String) -> Bool {
        let lower = text.lowercased()
        return config.windowTitlePatterns.contains { lower.contains($0.lowercased()) }
    }

    /// Reload config from disk (e.g. after user edits the JSON file).
    func reload() {
        config = SkipPatterns.load()
    }

    // MARK: - Config file management

    private static let configFileName = "skip-patterns.json"

    private static var configURL: URL {
        Store.dataDirectory.appendingPathComponent(configFileName)
    }

    private static func load() -> SkipPatternsConfig {
        let url = configURL

        // Try to read existing config
        if let data = try? Data(contentsOf: url),
           let config = try? JSONDecoder().decode(SkipPatternsConfig.self, from: data) {
            print("[SkipPatterns] Loaded \(config.bundleBlocklist.count) bundle blocks, "
                  + "\(config.bundleKeywords.count) keywords, "
                  + "\(config.windowTitlePatterns.count) title patterns")
            return config
        }

        // File doesn't exist or is invalid — create defaults
        let defaults = SkipPatternsConfig.defaults
        writeDefaults(defaults, to: url)
        return defaults
    }

    private static func writeDefaults(_ config: SkipPatternsConfig, to url: URL) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]

        guard let data = try? encoder.encode(config) else {
            print("[SkipPatterns] Could not encode default config")
            return
        }

        // Ensure directory exists
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        do {
            try data.write(to: url)
            print("[SkipPatterns] Created default config at \(url.path)")
        } catch {
            print("[SkipPatterns] Could not write default config: \(error)")
        }
    }
}

// MARK: - Config model

struct SkipPatternsConfig: Codable {
    /// Exact bundle identifiers to skip (e.g. "com.1password.1password")
    var bundleBlocklist: [String]

    /// Substrings to match in bundle ID, case-insensitive (e.g. "bank")
    var bundleKeywords: [String]

    /// Substrings to match in window title, case-insensitive (e.g. ".env")
    var windowTitlePatterns: [String]

    static let defaults = SkipPatternsConfig(
        bundleBlocklist: [
            "com.1password.1password",
            "com.agilebits.onepassword7",
            "com.apple.loginwindow",
            "com.apple.FaceTime",
            "com.apple.ScreenSaverEngine",
        ],
        bundleKeywords: [
            "bank",
            "password",
        ],
        windowTitlePatterns: [
            ".env",
            "credentials",
            ".pem",
            ".key",
            "id_rsa",
            "id_ed25519",
        ]
    )
}
