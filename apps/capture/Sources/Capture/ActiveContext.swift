import AppKit
import Carbon.HIToolbox

struct AppContext {
    var bundleId: String?
    var appName: String?
    var windowTitle: String?
    var url: String?
    var documentPath: String?       // kAXDocumentAttribute — file path from document-based apps
    var selectedText: String?       // kAXSelectedTextAttribute — currently highlighted text
    var focusedElement: String?     // Role + description of focused UI element
    var visibleWindows: String?     // JSON array of all visible window titles
}

struct ActiveContext {

    // MARK: - Public API

    static func get() -> AppContext {
        guard let frontApp = NSWorkspace.shared.frontmostApplication else {
            return AppContext()
        }

        let bundleId = frontApp.bundleIdentifier
        let appName = frontApp.localizedName

        let pid = frontApp.processIdentifier
        let axApp = AXUIElementCreateApplication(pid)

        let windowTitle = fetchWindowTitle(axApp: axApp)
        let url = fetchURL(for: bundleId)
        let documentPath = fetchDocumentPath(axApp: axApp)
        let selectedText = fetchSelectedText(axApp: axApp)
        let focusedElement = fetchFocusedElement(axApp: axApp)
        let visibleWindows = fetchVisibleWindows()

        return AppContext(
            bundleId: bundleId,
            appName: appName,
            windowTitle: windowTitle,
            url: url,
            documentPath: documentPath,
            selectedText: selectedText,
            focusedElement: focusedElement,
            visibleWindows: visibleWindows
        )
    }

    static func shouldSkip(bundle: String?, windowTitle: String? = nil) -> Bool {
        SkipPatterns.shared.shouldSkip(bundle: bundle, windowTitle: windowTitle)
    }

    // MARK: - Accessibility helpers

    /// Focused window title
    private static func fetchWindowTitle(axApp: AXUIElement) -> String? {
        guard let window = axElement(axApp, kAXFocusedWindowAttribute) else { return nil }
        guard let title = axAttribute(window, kAXTitleAttribute) as? String, !title.isEmpty else { return nil }
        return title
    }

    /// Document path from document-based apps (VS Code, Xcode, TextEdit, etc.)
    private static func fetchDocumentPath(axApp: AXUIElement) -> String? {
        // Try focused window's document attribute first
        guard let window = axElement(axApp, kAXFocusedWindowAttribute) else { return nil }
        if let docUrl = axAttribute(window, kAXDocumentAttribute) as? String {
            // Often returned as a file:// URL — convert to path
            if docUrl.hasPrefix("file://") {
                return URL(string: docUrl)?.path
            }
            return docUrl
        }
        return nil
    }

    /// Currently selected/highlighted text in any app
    private static func fetchSelectedText(axApp: AXUIElement) -> String? {
        // Get the focused UI element, then its selected text
        guard let focused = axElement(axApp, kAXFocusedUIElementAttribute) else { return nil }
        guard let text = axAttribute(focused, kAXSelectedTextAttribute) as? String, !text.isEmpty else { return nil }
        // Cap at 500 chars to avoid storing entire documents
        if text.count > 500 {
            return String(text.prefix(500))
        }
        return text
    }

    /// Role + description of the focused UI element (e.g. "text area: Code Editor", "button: Submit Review")
    /// Note: Electron apps (Claude, Slack, VS Code) often return kAXErrorNoValue (-25212) for
    /// kAXFocusedUIElementAttribute. This field will be NULL for those apps — that's expected.
    /// Native macOS apps (Finder, TextEdit, Xcode, Safari) populate it reliably.
    private static func fetchFocusedElement(axApp: AXUIElement) -> String? {
        guard let focused = axElement(axApp, kAXFocusedUIElementAttribute) else { return nil }

        let role = axAttribute(focused, kAXRoleAttribute) as? String
        let roleDesc = axAttribute(focused, kAXRoleDescriptionAttribute) as? String
        let desc = axAttribute(focused, kAXDescriptionAttribute) as? String

        // Also grab the value for text fields (search bars, inputs, command palette)
        let value = axAttribute(focused, kAXValueAttribute) as? String

        var parts: [String] = []
        if let roleDesc { parts.append(roleDesc) }
        else if let role { parts.append(role) }
        if let desc, !desc.isEmpty { parts.append(desc) }

        if parts.isEmpty { return nil }

        var result = parts.joined(separator: ": ")
        if let value, !value.isEmpty {
            // Cap value at 200 chars
            let trimmed = value.count > 200 ? String(value.prefix(200)) : value
            result += " [value: \(trimmed)]"
        }
        return result
    }

    /// All visible window titles across all apps via CGWindowList
    private static func fetchVisibleWindows() -> String? {
        guard let windowList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else { return nil }

        var titles: [String] = []
        for window in windowList {
            // Skip windows without titles or with empty titles
            guard let name = window[kCGWindowName as String] as? String, !name.isEmpty else { continue }
            guard let ownerName = window[kCGWindowOwnerName as String] as? String else { continue }
            // Skip menu bar items and system UI
            guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
            titles.append("\(ownerName): \(name)")
        }

        guard !titles.isEmpty else { return nil }

        // Deduplicate while preserving order
        var seen = Set<String>()
        let unique = titles.filter { seen.insert($0).inserted }

        // Encode as JSON array
        guard let data = try? JSONSerialization.data(withJSONObject: unique),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return json
    }

    /// Generic AX attribute fetch helper
    private static func axAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var ref: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &ref)
        return result == .success ? ref : nil
    }

    /// Fetch an AX attribute as AXUIElement (avoids Swift strict-cast warnings on CFTypeRef)
    private static func axElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let ref = axAttribute(element, attribute) else { return nil }
        // AXUIElement is a CFTypeRef alias — the cast always succeeds if the attribute exists,
        // but we guard on axAttribute returning non-nil (which checks .success).
        return (ref as! AXUIElement) // swiftlint:disable:this force_cast
    }

    // MARK: - URL via AppleScript (Safari / Chrome only)

    private static func fetchURL(for bundleId: String?) -> String? {
        guard let bundleId else { return nil }

        let script: String?
        switch bundleId {
        case "com.apple.Safari":
            script = """
            tell application "Safari"
                if (count of windows) > 0 then
                    return URL of current tab of front window
                end if
            end tell
            """
        case "com.google.Chrome":
            script = """
            tell application "Google Chrome"
                if (count of windows) > 0 then
                    return URL of active tab of front window
                end if
            end tell
            """
        default:
            return nil
        }

        guard let source = script,
              let appleScript = NSAppleScript(source: source) else { return nil }

        var errorDict: NSDictionary?
        let result = appleScript.executeAndReturnError(&errorDict)
        if errorDict != nil { return nil }
        return result.stringValue
    }

    // MARK: - All-tab enumeration (Safari / Chrome only)
    //
    // Separate from `fetchURL(for:)` above, which only reads the *frontmost* tab of the
    // *active* app — that existing behavior (used by every capture tick) is untouched.
    // This enumerates every tab across every window, for callers (MeetingDetector) that
    // need to notice a meeting URL open in a background tab.

    static func fetchAllTabURLs() -> [BrowserTab] {
        var tabs: [BrowserTab] = []
        if isRunning(bundleId: "com.google.Chrome") {
            tabs.append(contentsOf: runAllTabsScript(chromeAllTabsScript))
        }
        if isRunning(bundleId: "com.apple.Safari") {
            tabs.append(contentsOf: runAllTabsScript(safariAllTabsScript))
        }
        return tabs
    }

    private static func isRunning(bundleId: String) -> Bool {
        NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == bundleId }
    }

    private static let tabFieldSeparator = "|||"

    private static let chromeAllTabsScript = """
    tell application "Google Chrome"
        set output to {}
        repeat with w in windows
            repeat with t in tabs of w
                set end of output to ((URL of t) & "|||" & (title of t))
            end repeat
        end repeat
        return output
    end tell
    """

    private static let safariAllTabsScript = """
    tell application "Safari"
        set output to {}
        repeat with w in windows
            repeat with t in tabs of w
                set end of output to ((URL of t) & "|||" & (name of t))
            end repeat
        end repeat
        return output
    end tell
    """

    private static func runAllTabsScript(_ source: String) -> [BrowserTab] {
        guard let appleScript = NSAppleScript(source: source) else { return [] }

        var errorDict: NSDictionary?
        let result = appleScript.executeAndReturnError(&errorDict)
        guard errorDict == nil else { return [] }
        guard result.numberOfItems > 0 else { return [] }

        var tabs: [BrowserTab] = []
        for i in 1...result.numberOfItems {
            guard let item = result.atIndex(i)?.stringValue else { continue }
            let parts = item.components(separatedBy: tabFieldSeparator)
            guard let url = parts.first, !url.isEmpty else { continue }
            let title = parts.count > 1 ? parts[1] : nil
            tabs.append(BrowserTab(url: url, title: title))
        }
        return tabs
    }
}

/// A single browser tab's URL and title, as enumerated by `ActiveContext.fetchAllTabURLs()`.
struct BrowserTab {
    let url: String
    let title: String?
}
