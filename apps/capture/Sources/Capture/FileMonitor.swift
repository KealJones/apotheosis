import Foundation

/// Tracks recently modified files via NSMetadataQuery (Spotlight).
/// Logs `file_modified` events to the context_events table.
final class FileMonitor {
    static let shared = FileMonitor()

    private var query: NSMetadataQuery?
    private var config: WatchedPathsConfig

    /// Binary/generated file extensions to always skip
    private static let skipExtensions: Set<String> = [
        "o", "pyc", "pyo", "class", "jar", "dSYM", "a", "dylib", "so",
        "DS_Store", "swp", "swo", "lock", "log",
    ]

    private init() {
        config = FileMonitor.loadConfig()
    }

    // MARK: - Lifecycle

    /// Must be called on the main thread (NSMetadataQuery requires an active RunLoop).
    func start() {
        let q = NSMetadataQuery()
        q.searchScopes = resolvedSearchScopes()

        // Find files modified after we started watching
        q.predicate = NSPredicate(
            format: "%K >= %@",
            NSMetadataItemContentModificationDateKey,
            Date() as NSDate
        )

        // Debounce Spotlight result delivery
        q.notificationBatchingInterval = 5.0

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(queryDidUpdate(_:)),
            name: .NSMetadataQueryDidUpdate,
            object: q
        )

        q.start()
        query = q
        print("[FileMonitor] Started — watching \(config.paths.count) paths")
    }

    func stop() {
        query?.stop()
        query = nil
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Notification handler

    @objc private func queryDidUpdate(_ notification: Notification) {
        guard CaptureLoop.shared.skipReason(checkIdle: false) == nil else { return }

        // Only this batch's added/changed items. The query's full result set is every file
        // modified since startup, so walking it on each update grows without bound.
        let info = notification.userInfo ?? [:]
        let items = (info[NSMetadataQueryUpdateAddedItemsKey] as? [NSMetadataItem] ?? [])
            + (info[NSMetadataQueryUpdateChangedItemsKey] as? [NSMetadataItem] ?? [])
        guard !items.isEmpty else { return }

        let takenAt = Int64(Date().timeIntervalSince1970)
        var events: [(event: Store.FileEvent, repoRoot: String?)] = []
        var perRepo: [String: Int] = [:]

        for item in items {
            guard let filePath = item.value(forAttribute: NSMetadataItemPathKey) as? String else { continue }

            // Filter: skip excluded patterns
            if shouldExclude(path: filePath) { continue }

            // Agent worktrees and other linked checkouts aren't my edits.
            let repo = repoInfo(forFile: filePath)
            if repo?.isLinkedWorktree == true { continue }

            // Extract metadata for the detail field
            let displayName = item.value(forAttribute: NSMetadataItemDisplayNameKey) as? String
            let contentType = item.value(forAttribute: NSMetadataItemContentTypeKey) as? String
            let fileSize = item.value(forAttribute: NSMetadataItemFSSizeKey) as? Int64

            // Folders carry no real "modified" signal — their mtime bumps whenever
            // any child changes, including excluded children, so they never settle.
            if contentType == "public.folder" { continue }

            var detailDict: [String: Any] = [:]
            if let contentType { detailDict["content_type"] = contentType }
            if let fileSize { detailDict["size_bytes"] = fileSize }

            let detail: String?
            if !detailDict.isEmpty,
               let data = try? JSONSerialization.data(withJSONObject: detailDict),
               let json = String(data: data, encoding: .utf8) {
                detail = json
            } else {
                detail = nil
            }

            if let root = repo?.root { perRepo[root, default: 0] += 1 }
            events.append((Store.FileEvent(path: filePath, windowTitle: displayName, detail: detail), repo?.root))
        }

        // A checkout, rebase, install or codegen run touches a pile of files in one repo at
        // once. Those aren't edits, so drop that repo's share of the batch.
        let bulkRepos = Set(perRepo.filter { $0.value > FileMonitor.bulkChangeThreshold }.keys)
        for root in bulkRepos {
            print("[FileMonitor] Skipping bulk change: \(perRepo[root] ?? 0) files in \(root)")
        }

        // Collapsed to one row per (path, day) in the store; repeat hits bump change_count.
        Store.shared.upsertFileModified(
            takenAt: takenAt,
            events: events.filter { !bulkRepos.contains($0.repoRoot ?? "") }.map(\.event)
        )
    }

    // MARK: - Path filtering

    /// More files than this from one repo in a single batch reads as tooling, not editing.
    private static let bulkChangeThreshold = 40

    /// Always skipped, on top of the config's excludePatterns: build output, dependency
    /// caches and agent worktrees that churn files nobody edited by hand.
    private static let builtinExcludes = [
        "/.git/", "/node_modules/", "/.pnpm-store/", "/.yarn/", "/.build/", "/build/", "/dist/",
        "/.next/", "/.turbo/", "/.nuxt/", "/.svelte-kit/", "/coverage/", "/DerivedData/",
        "/Pods/", "/.swiftpm/", "/.dart_tool/", "/.gradle/", "/target/", "/__pycache__/",
        "/.venv/", "/venv/", "/.cache/", "/.claude/worktrees/",
    ]

    private struct RepoInfo {
        let root: String
        /// `.git` is a file, not a folder: a linked worktree (or submodule).
        let isLinkedWorktree: Bool
    }

    /// Nearest enclosing git checkout, cached per directory.
    private var repoCache: [String: RepoInfo?] = [:]

    private func repoInfo(forFile path: String) -> RepoInfo? {
        var dir = (path as NSString).deletingLastPathComponent
        var visited: [String] = []
        var found: RepoInfo?
        while dir.count > 1 {
            if let cached = repoCache[dir] {
                found = cached
                break
            }
            visited.append(dir)
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: dir + "/.git", isDirectory: &isDir) {
                found = RepoInfo(root: dir, isLinkedWorktree: !isDir.boolValue)
                break
            }
            dir = (dir as NSString).deletingLastPathComponent
        }
        for d in visited { repoCache[d] = found }
        return found
    }

    private func shouldExclude(path: String) -> Bool {
        if FileMonitor.builtinExcludes.contains(where: path.contains) { return true }

        // Same sensitive names (credentials, .pem, id_rsa, ...) the screen capture skips.
        if SkipPatterns.shared.matchesSensitiveName(path) { return true }

        // Check exclude patterns from config
        for pattern in config.excludePatterns {
            if path.contains(pattern) { return true }
        }

        // Skip dotfiles (hidden files)
        let filename = (path as NSString).lastPathComponent
        if filename.hasPrefix(".") { return true }

        // Skip binary/generated extensions
        let ext = (path as NSString).pathExtension.lowercased()
        if FileMonitor.skipExtensions.contains(ext) { return true }

        return false
    }

    // MARK: - Search scopes

    private func resolvedSearchScopes() -> [Any] {
        config.paths.compactMap { rawPath -> URL? in
            let expanded = NSString(string: rawPath).expandingTildeInPath
            let url = URL(fileURLWithPath: expanded, isDirectory: true)
            // Only include directories that exist
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir),
                  isDir.boolValue else {
                print("[FileMonitor] Skipping non-existent path: \(rawPath)")
                return nil
            }
            return url
        }
    }

    // MARK: - Config

    private static let configFileName = "watched-paths.json"

    private static var configURL: URL {
        let appSupport = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first!
            .appendingPathComponent("apotheosis", isDirectory: true)
        return appSupport.appendingPathComponent(configFileName)
    }

    private static func loadConfig() -> WatchedPathsConfig {
        let url = configURL

        if let data = try? Data(contentsOf: url),
           let config = try? JSONDecoder().decode(WatchedPathsConfig.self, from: data) {
            print("[FileMonitor] Loaded config: \(config.paths.count) paths, \(config.excludePatterns.count) excludes")
            return config
        }

        // Create defaults
        let defaults = WatchedPathsConfig.defaults
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(defaults) {
            let dir = url.deletingLastPathComponent()
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? data.write(to: url)
            print("[FileMonitor] Created default config at \(url.path)")
        }
        return defaults
    }
}

// MARK: - Config model

struct WatchedPathsConfig: Codable {
    var paths: [String]
    var excludePatterns: [String]

    static let defaults = WatchedPathsConfig(
        paths: [
            "~/Documents",
            "~/Desktop",
            "~/Git",
        ],
        excludePatterns: [
            ".git/",
            "node_modules/",
            ".build/",
            "dist/",
            "DerivedData/",
            "__pycache__/",
            ".cache/",
            "Pods/",
            ".swiftpm/",
        ]
    )
}
