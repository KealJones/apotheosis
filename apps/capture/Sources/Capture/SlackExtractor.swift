import AppKit
import ApplicationServices
import CryptoKit

/// A structured Slack message extracted from the accessibility tree.
struct SlackMessage {
    let channel: String?
    let sender: String
    let text: String
    let dateBucket: String?     // Slack's date separator label, e.g. "Today", "Thursday, June 4th"
    let timeLabel: String?      // Slack's per-message timestamp label, e.g. "11:09 AM"
    let permalink: String?      // Message archive URL from the timestamp link's AXURL
    let reactions: String?      // ":eyes: 1, :+1: 3"
    let replyCount: Int?        // Thread roots: the "21 replies" bar

    func with(channel: String?) -> SlackMessage {
        SlackMessage(channel: channel, sender: sender, text: text, dateBucket: dateBucket, timeLabel: timeLabel,
                     permalink: permalink, reactions: reactions, replyCount: replyCount)
    }
}

/// Extracts structured Slack messages via the macOS Accessibility API.
///
/// Slack is an Electron app, which ships with its accessibility tree DISABLED
/// until a client sets the `AXManualAccessibility` attribute on the app element.
/// Without that, the tree appears empty — this is why naive AX reads of Slack fail.
///
/// The flag persists for the lifetime of the Slack process, so we re-assert it:
///   1. at daemon startup (App.swift),
///   2. whenever Slack is activated (AppSwitchMonitor) — warms the tree before the next tick,
///   3. before every extraction (safety net; the call is cheap and idempotent).
/// Together these guarantee the tree is available even across Slack restarts.
///
/// Limits: Slack virtualizes its message list, so only the currently rendered
/// view is in the tree. This matches the daemon's sampling model — we capture
/// what's on screen, structured instead of OCR'd.
final class SlackExtractor {
    static let shared = SlackExtractor()
    static let slackBundleId = "com.tinyspeck.slackmacgap"

    /// PID we last enabled AX for — used only to log transitions, not to skip the set call.
    private var lastEnabledPid: pid_t = -1

    private init() {}

    // MARK: - AXManualAccessibility

    /// Idempotently enable the Electron accessibility tree on the running Slack process.
    @discardableResult
    func ensureAXEnabled() -> Bool {
        guard let slack = NSRunningApplication
            .runningApplications(withBundleIdentifier: Self.slackBundleId)
            .first else { return false }

        let pid = slack.processIdentifier
        let app = AXUIElementCreateApplication(pid)
        let result = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)

        if result == .success && pid != lastEnabledPid {
            print("[SlackExtractor] AXManualAccessibility enabled for Slack pid=\(pid)")
            lastEnabledPid = pid
        }
        return result == .success
    }

    // MARK: - Extraction

    /// Walk Slack's AX tree and persist any structured messages found.
    /// Called from the capture queue when a tick lands on Slack.
    /// Returns how many messages were visible (new or already stored); 0 means the view
    /// isn't a message list or AX failed, so the caller should fall back to a screenshot.
    @discardableResult
    func captureMessages(windowTitle: String?) -> Int {
        guard ensureAXEnabled() else { return 0 }
        guard let slack = NSRunningApplication
            .runningApplications(withBundleIdentifier: Self.slackBundleId)
            .first else { return 0 }

        let app = AXUIElementCreateApplication(slack.processIdentifier)
        let channel = parseChannel(fromWindowTitle: windowTitle)
        let messages = extractMessages(root: app, channel: channel)

        guard !messages.isEmpty else { return 0 }

        let now = Int64(Date().timeIntervalSince1970)
        var inserted = 0
        for msg in messages {
            let hash = dedupeHash(msg)
            if Store.shared.insertSlackMessage(
                capturedAt: now,
                channel: msg.channel,
                sender: msg.sender,
                text: msg.text,
                dateBucket: msg.dateBucket,
                timeLabel: msg.timeLabel,
                permalink: msg.permalink,
                reactions: msg.reactions,
                replyCount: msg.replyCount,
                dedupeHash: hash
            ) {
                inserted += 1
            }
        }
        if inserted > 0 {
            print("[SlackExtractor] Stored \(inserted) new message(s) (\(messages.count) visible) in \(channel ?? "?")")
        }
        return messages.count
    }

    // MARK: - Tree walking

    /// Slack's main pane (`p-view_contents--primary`) and the thread side pane
    /// (`--secondary`) are separate views. Each message is one virtual-list item holding a
    /// sender button (only on the first of a run from one person), a timestamp link whose
    /// URL is the permalink, rich-text body, reactions and a reply bar. Composer, header
    /// and sidebar chrome sit outside the list items, so they never leak into message text.
    private func extractMessages(root: AXUIElement, channel: String?) -> [SlackMessage] {
        var views: [(element: AXUIElement, primary: Bool)] = []
        var visited = 0
        func findViews(_ el: AXUIElement, depth: Int) {
            visited += 1
            guard visited < 20000, depth < 40 else { return }
            let cls = classes(el)
            if cls.contains("p-view_contents--primary") || cls.contains("p-view_contents--secondary") {
                views.append((el, cls.contains("p-view_contents--primary")))
                return
            }
            for child in children(el) { findViews(child, depth: depth + 1) }
        }
        findViews(root, depth: 0)

        var messages: [SlackMessage] = []
        var primaryChannelId: String?
        for view in views.sorted(by: { $0.primary && !$1.primary }) {
            var parsed = parseView(view.element)
            if view.primary {
                primaryChannelId = parsed.lazy.compactMap { Self.channelId($0.permalink) }.first
            }
            // A thread pane usually belongs to the primary conversation; when it doesn't
            // (opened from Activity or Threads), name it from the pane's own label.
            let label = view.primary ? channel : threadPaneLabel(view.element) ?? channel
            parsed = parsed.map { m in
                let sameConvo = Self.channelId(m.permalink) == primaryChannelId
                return m.with(channel: view.primary || sameConvo ? channel : label)
            }
            messages += parsed
        }
        return messages
    }

    /// One message per virtual-list item that has a timestamp link. Sender carries
    /// forward across Slack's run of consecutive messages from the same person.
    private func parseView(_ view: AXUIElement) -> [SlackMessage] {
        var messages: [SlackMessage] = []
        var sender: String?
        var visited = 0
        func walk(_ el: AXUIElement, depth: Int) {
            visited += 1
            guard visited < 20000, depth < 40 else { return }
            if classes(el).contains("c-virtual_list__item") {
                if let m = parseItem(el, carriedSender: sender) {
                    sender = m.sender
                    messages.append(m)
                }
                return
            }
            for child in children(el) { walk(child, depth: depth + 1) }
        }
        walk(view, depth: 0)
        return messages
    }

    private func parseItem(_ item: AXUIElement, carriedSender: String?) -> SlackMessage? {
        var sender: String?
        var stamp: String?
        var permalink: String?
        var reactions: [String] = []
        var replyCount: Int?
        var text = ""
        var afterMention = false
        var seenLinks: Set<String> = []

        func newline() {
            if !text.isEmpty, !text.hasSuffix("\n") { text += "\n" }
        }

        /// One "[file: name](url)" line per attachment; a later sighting with a URL fills it in.
        func addFile(name: String, url href: String?) {
            guard !name.isEmpty else { return }
            let bare = "[file: \(name)]\n"
            let line = href.map { "[file: \(name)](\($0))\n" } ?? bare
            if let href { seenLinks.insert(href) }
            if let r = text.range(of: bare) {
                text.replaceSubrange(r, with: line)
            } else if !text.contains("[file: \(name)](") {
                newline()
                text += line
            }
        }

        func walk(_ el: AXUIElement, depth: Int) {
            guard depth < 30 else { return }
            let cls = classes(el)
            let r = role(el)

            if cls.contains("c-message__sender_button") { sender = title(el); return }
            if cls.contains("c-timestamp") {
                stamp = description(el)
                permalink = url(el)
                return
            }
            if cls.contains("c-message_actions__container") || cls.contains("c-reaction_add")
                || cls.contains("c-message__reply_bar_description") { return }
            if cls.contains("c-reaction"), r == "AXCheckBox" {
                if let reaction = parseReaction(description(el)) { reactions.append(reaction) }
                return
            }
            if cls.contains("c-message__reply_count") {
                replyCount = Int(title(el).prefix(while: \.isNumber))
                return
            }
            // Everything before the timestamp is avatar, status emoji and spacing.
            guard stamp != nil else {
                for child in children(el) { walk(child, depth: depth + 1) }
                return
            }

            if cls.contains("c-mrkdwn__br") { text += "\n"; return }
            if cls.contains("c-emoji") || (r == "AXImage" && description(el).hasSuffix(" emoji")) {
                let name = description(el).isEmpty
                    ? children(el).lazy.map(self.description).first(where: { !$0.isEmpty }) ?? ""
                    : description(el)
                if name.hasSuffix(" emoji") { text += ":\(name.dropLast(" emoji".count).replacingOccurrences(of: " ", with: "_")):" }
                return
            }
            if cls.contains("c-mrkdwn__code") { text += "`\(leafText(el))`"; return }
            if cls.contains("c-mrkdwn__pre") { newline(); text += "```\n\(leafText(el))\n```\n"; return }
            // Video: skip the player controls ("0:06", "1x"); its overlay carries the filename.
            if cls.contains("p-video_message_file") {
                if let overlay = firstDescendant(el, withClass: "p-video_controls_overlay") {
                    addFile(name: description(overlay), url: nil)
                }
                return
            }
            if cls.contains("c-message_attachment") {
                // Shared message or link preview, kept as quoted context with its link.
                let author = firstDescendant(el, withClass: "c-message_attachment__author_name").map(title)
                let href = links(in: el).first?.url
                // A preview of a link the message already has adds nothing.
                if author == nil, let href, seenLinks.contains(href) { return }
                if let href { seenLinks.insert(href) }
                let context = links(in: el).map(\.label).first { $0.contains(" in ") } ?? ""
                // Shared messages keep their text in rich-text sections; previews are plain text.
                let sections = descendants(el, withClass: "p-rich_text_section").map { leafText($0) }
                let body = sections.isEmpty
                    ? leafText(el, separator: " ", skipping: ["c-message_attachment__author_name"])
                    : sections.joined(separator: " ")
                newline()
                text += "> " + [author, context.isEmpty ? nil : "(\(context))"].compactMap { $0 }.joined(separator: " ")
                text += (author == nil ? "" : ": ") + body + (href.map { " \($0)" } ?? "") + "\n"
                return
            }
            if cls.contains("c-message_kit__file") {
                // Header: one file's name, or "N attachments" for a gallery. Gallery thumbnails
                // may sit inside it; a single image's sits beside it and is handled on its own.
                for name in leafText(el, separator: "\n", skipping: ["p-file_image_thumbnail__wrapper"])
                    .components(separatedBy: "\n")
                    where name.range(of: #"^\d+ attachments?$"#, options: .regularExpression) == nil {
                    addFile(name: name, url: nil)
                }
                for thumb in descendants(el, withClass: "p-file_image_thumbnail__wrapper") {
                    addFile(name: description(thumb), url: url(thumb))
                }
                return
            }
            if cls.contains("p-file_image_thumbnail__wrapper") {
                addFile(name: description(el), url: url(el))
                return
            }
            if r == "AXListMarker" { text += value(el); return }
            if r == "AXList" {
                // Ordered items carry an AXListMarker ("1. "); bullet items render theirs in CSS.
                newline()
                for item in children(el) {
                    newline()
                    if !hasDescendant(item, role: "AXListMarker") { text += "• " }
                    walk(item, depth: depth + 1)
                }
                newline()
                return
            }
            if r == "AXLink" {
                let label = leafText(el)
                let href = url(el) ?? ""
                if cls.contains("c-member_slug") {
                    if text.last?.isLetter == true || text.last?.isNumber == true { text += " " }
                    text += label.isEmpty ? description(el) : label
                    afterMention = true
                    return
                }
                // Link previews repeat a URL the message already has.
                guard href.isEmpty || seenLinks.insert(href).inserted else { return }
                if href.isEmpty || label == href || label == "[link]" || label.isEmpty {
                    text += href.isEmpty ? (label.isEmpty ? description(el) : label) : href
                } else {
                    text += "[\(label)](\(href))"
                }
                return
            }
            if r == "AXStaticText" {
                let v = value(el)
                guard !isUIMetadata(v) else { return }
                // Slack drops the space between a mention and a following word.
                if afterMention, v.first?.isLetter == true { text += " " }
                afterMention = false
                text += v
                return
            }

            let block = cls.contains("p-rich_text_section")
            if block { newline() }
            for child in children(el) { walk(child, depth: depth + 1) }
            if block { newline() }
        }

        walk(item, depth: 0)

        let body = text
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .joined(separator: "\n")
            .replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let stamp, !body.isEmpty else { return nil }

        let (date, time) = parseTimestamp(stamp)
        return SlackMessage(
            channel: nil,
            sender: sender ?? carriedSender ?? "(unknown)",
            text: body,
            dateBucket: date,
            timeLabel: time,
            permalink: permalink,
            reactions: reactions.isEmpty ? nil : reactions.joined(separator: ", "),
            replyCount: replyCount
        )
    }

    /// "Thread in channel frontend (private)" → "frontend".
    private func threadPaneLabel(_ view: AXUIElement) -> String? {
        var label = description(view)
        guard label.hasPrefix("Thread in ") else { return nil }
        label = String(label.dropFirst("Thread in ".count))
        if label.hasPrefix("channel ") { label = String(label.dropFirst("channel ".count)) }
        label = label.replacingOccurrences(of: #" \([^)]*\)$"#, with: "", options: .regularExpression)
        return label.isEmpty ? nil : label
    }

    /// "2 reactions, react with thumbsup emoji" → ":thumbsup: 2".
    private func parseReaction(_ desc: String) -> String? {
        guard let r = desc.range(of: #"^\d+ reactions?, react with .+ emoji"#, options: .regularExpression) else { return nil }
        let match = desc[r]
        let count = match.prefix(while: \.isNumber)
        guard let with = match.range(of: "react with ") else { return nil }
        let name = match[with.upperBound...].dropLast(" emoji".count).replacingOccurrences(of: " ", with: "_")
        return ":\(name): \(count)"
    }

    private func hasDescendant(_ el: AXUIElement, role wanted: String, depth: Int = 0) -> Bool {
        guard depth < 6 else { return false }
        return children(el).contains { role($0) == wanted || hasDescendant($0, role: wanted, depth: depth + 1) }
    }

    /// AXLinks in a subtree with a URL, as (label, url).
    private func links(in el: AXUIElement) -> [(label: String, url: String)] {
        var found: [(String, String)] = []
        func walk(_ e: AXUIElement, depth: Int) {
            guard depth < 20 else { return }
            if role(e) == "AXLink", let u = url(e) {
                let label = leafText(e)
                found.append((label.isEmpty ? description(e) : label, u))
                return
            }
            for child in children(e) { walk(child, depth: depth + 1) }
        }
        walk(el, depth: 0)
        return found
    }

    private func firstDescendant(_ el: AXUIElement, withClass cls: String) -> AXUIElement? {
        descendants(el, withClass: cls).first
    }

    /// Outermost descendants carrying `cls` (doesn't look inside a match).
    private func descendants(_ el: AXUIElement, withClass cls: String, depth: Int = 0) -> [AXUIElement] {
        guard depth < 20 else { return [] }
        return children(el).flatMap { child in
            classes(child).contains(cls) ? [child] : descendants(child, withClass: cls, depth: depth + 1)
        }
    }

    /// Concatenated AXStaticText values in a subtree, skipping video controls and any
    /// subtree whose element has one of `skipping`'s classes.
    private func leafText(_ el: AXUIElement, separator: String = "", skipping: Set<String> = []) -> String {
        var parts: [String] = []
        func walk(_ e: AXUIElement, depth: Int) {
            guard depth < 20 else { return }
            let cls = classes(e)
            if cls.contains("p-video_message_file") || cls.contains(where: skipping.contains) { return }
            if role(e) == "AXStaticText" {
                let v = value(e).trimmingCharacters(in: .whitespaces)
                if !v.isEmpty, !isUIMetadata(v) { parts.append(separator.isEmpty ? value(e) : v) }
                return
            }
            for child in children(e) { walk(child, depth: depth + 1) }
        }
        walk(el, depth: 0)
        return parts.joined(separator: separator).trimmingCharacters(in: .whitespaces)
    }

    /// Channel id from a permalink: `/archives/C0123ABCDEF/p…`.
    private static func channelId(_ permalink: String?) -> String? {
        guard let permalink, let r = permalink.range(of: #"/archives/[A-Z0-9]+/"#, options: .regularExpression)
        else { return nil }
        return String(permalink[r].dropFirst("/archives/".count).dropLast())
    }

    // MARK: - Parsing heuristics

    /// "design-system-help (Channel) - Acme Corp - 26 new items - Slack"
    ///   → "design-system-help"
    /// "Jane Doe (She/Her) (DM) - Acme Corp - 36 new items - Slack"
    ///   → "Jane Doe (She/Her) (DM)"
    private func parseChannel(fromWindowTitle title: String?) -> String? {
        guard var first = title?.components(separatedBy: " - ").first, !first.isEmpty else { return nil }
        if first.hasSuffix(" (Channel)") {
            first = String(first.dropLast(" (Channel)".count))
        }
        return first
    }

    /// Slack message timestamps are AXLinks described like "Today at 3:04:59 AM",
    /// "Yesterday at 5:12 PM", or "June 4th at 9:01 AM".
    private func isTimestampLink(_ el: AXUIElement) -> Bool {
        guard role(el) == "AXLink" else { return false }
        return description(el).range(of: #" at \d{1,2}:\d{2}"#, options: .regularExpression) != nil
    }

    /// "Today at 3:04:59 AM" → (date: "Today", time: "3:04 AM").
    /// Drops seconds so the time label matches what Slack shows in compact rows,
    /// and keeps dedupe stable when the seconds component isn't always present.
    private func parseTimestamp(_ desc: String) -> (date: String?, time: String?) {
        // Thread-pane stamps read "Today at 10:13:26 AM. Open in channel".
        let desc = desc.replacingOccurrences(of: ". Open in channel", with: "")
        guard let r = desc.range(of: " at ") else { return (nil, nil) }
        let date = String(desc[desc.startIndex..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
        var time = String(desc[r.upperBound...]).trimmingCharacters(in: .whitespaces)
        // "3:04:59 AM" → "3:04 AM"
        time = time.replacingOccurrences(
            of: #"^(\d{1,2}:\d{2})(:\d{2})?( [AP]M)$"#,
            with: "$1$3",
            options: .regularExpression
        )
        return (date.isEmpty ? nil : date, time.isEmpty ? nil : time)
    }

    /// Sender buttons carry display names; reject icon buttons and long fragments.
    private func looksLikeDisplayName(_ s: String) -> Bool {
        s.count >= 2 && s.count <= 60 && !s.contains("\n")
    }

    /// Trailing UI chrome inside message rows that is not message content.
    private func isUIMetadata(_ s: String) -> Bool {
        let trimmed = s.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return false } // keep whitespace fragments — they separate words
        if trimmed == "(edited)" || trimmed == "View thread" { return true }
        if trimmed == "View reply" || trimmed == "View replies" || trimmed == "|" { return true }
        if trimmed == "replied to a thread:" || trimmed == "Thread response:" || trimmed == "Show description" { return true }
        if trimmed.hasPrefix("Last reply ") { return true }
        if trimmed.range(of: #"^\d+ repl(y|ies)$"#, options: .regularExpression) != nil { return true }
        // A bare "H:MM AM" / "H:MM:SS AM" fragment is the timestamp echo, not body.
        if trimmed.range(of: #"^\d{1,2}:\d{2}(:\d{2})? [AP]M$"#, options: .regularExpression) != nil { return true }
        return false
    }

    /// Permalink is globally unique per message, so prefer it as the dedupe key.
    /// Composite fallback excludes date_bucket on purpose: Slack relabels "Today" →
    /// "Yesterday" → weekday, and including it would re-insert under each label.
    private func dedupeHash(_ msg: SlackMessage) -> String {
        let input = msg.permalink ?? "\(msg.channel ?? "")|\(msg.sender)|\(msg.timeLabel ?? "")|\(msg.text)"
        let digest = SHA256.hash(data: Data(input.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Debug

    /// `Capture --slack-messages`: prints what a capture would store, without storing it.
    func printMessages() {
        guard ensureAXEnabled(), let slack = NSRunningApplication
            .runningApplications(withBundleIdentifier: Self.slackBundleId).first else { return }
        let app = AXUIElementCreateApplication(slack.processIdentifier)
        let title = (axAttribute(app, kAXFocusedWindowAttribute) as! AXUIElement?).map(self.title)
        for m in extractMessages(root: app, channel: parseChannel(fromWindowTitle: title)) {
            print("--- [\(m.channel ?? "?")] \(m.sender) | \(m.dateBucket ?? "") \(m.timeLabel ?? "") | reactions=\(m.reactions ?? "-") replies=\(m.replyCount.map(String.init) ?? "-")")
            print("    \(m.permalink ?? "no permalink")")
            print(m.text)
        }
    }

    /// `Capture --dump-slack`: prints Slack's AX tree (role, DOM classes, title, description,
    /// value, URL) so parser changes can be checked against what Slack actually exposes.
    func dumpTree() {
        guard ensureAXEnabled(), let slack = NSRunningApplication
            .runningApplications(withBundleIdentifier: Self.slackBundleId).first else {
            print("Slack not running or AX not trusted (trusted=\(AXIsProcessTrusted()))")
            return
        }
        var visited = 0
        func walk(_ el: AXUIElement, depth: Int) {
            visited += 1
            guard visited < 20000, depth < 45 else { return }
            let classes = (axAttribute(el, "AXDOMClassList") as? [String])?.joined(separator: ".") ?? ""
            let url = (axAttribute(el, kAXURLAttribute) as? NSURL)?.absoluteString ?? ""
            let fields = [role(el), classes.isEmpty ? "" : ".\(classes)", "t=\(title(el))", "d=\(description(el))",
                          "v=\(value(el).prefix(160))", url.isEmpty ? "" : "u=\(url)"]
                .filter { !$0.isEmpty && !$0.hasSuffix("=") }
            print(String(repeating: " ", count: depth) + fields.joined(separator: " | ").replacingOccurrences(of: "\n", with: "⏎"))
            for child in children(el) { walk(child, depth: depth + 1) }
        }
        walk(AXUIElementCreateApplication(slack.processIdentifier), depth: 0)
    }

    // MARK: - AX helpers

    private func axAttribute(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var ref: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, name as CFString, &ref) == .success ? ref : nil
    }

    private func role(_ el: AXUIElement) -> String {
        (axAttribute(el, kAXRoleAttribute) as? String) ?? ""
    }

    private func description(_ el: AXUIElement) -> String {
        (axAttribute(el, kAXDescriptionAttribute) as? String) ?? ""
    }

    private func title(_ el: AXUIElement) -> String {
        (axAttribute(el, kAXTitleAttribute) as? String) ?? ""
    }

    private func value(_ el: AXUIElement) -> String {
        (axAttribute(el, kAXValueAttribute) as? String) ?? ""
    }

    /// Electron exposes the DOM class list, which is far steadier than AX roles.
    private func classes(_ el: AXUIElement) -> [String] {
        (axAttribute(el, "AXDOMClassList") as? [String]) ?? []
    }

    private func url(_ el: AXUIElement) -> String? {
        (axAttribute(el, kAXURLAttribute) as? NSURL)?.absoluteString
    }

    private func children(_ el: AXUIElement) -> [AXUIElement] {
        (axAttribute(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    }
}
