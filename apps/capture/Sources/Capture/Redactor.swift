import Foundation

/// Scrubs secrets out of captured text before it reaches the database. Every text column
/// the daemon writes from screen, accessibility, Slack or audio goes through here.
enum Redactor {
    /// Known token formats. Safe on any field, including URLs and window titles, because
    /// each pattern has a distinctive prefix that ordinary text doesn't.
    private static let specific: [(NSRegularExpression, String)] = compile([
        (#"AKIA[A-Z0-9]{16}"#, "[REDACTED_AWS_KEY]"),
        (#"Bearer\s+[A-Za-z0-9\-._~+/]+=*"#, "[REDACTED_BEARER]"),
        (#"gh[posur]_[A-Za-z0-9_]{36,}"#, "[REDACTED_GH_TOKEN]"),
        (#"github_pat_[A-Za-z0-9_]{40,}"#, "[REDACTED_GH_TOKEN]"),
        (#"xo(?:xb|xp|xo|xa|xr|xs|app)-[A-Za-z0-9\-]+"#, "[REDACTED_SLACK_TOKEN]"),
        (#"npm_[A-Za-z0-9]{36,}"#, "[REDACTED_NPM_TOKEN]"),
        (#"\bsk-[A-Za-z0-9_\-]{20,}"#, "[REDACTED_API_KEY]"),
        (#"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"#, "[REDACTED_JWT]"),
        (#"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"#, "[REDACTED_PRIVATE_KEY]"),
        // Credential-looking URL query parameters (?token=..., &api_key=..., &sig=...).
        (#"(?i)([?&](?:access_token|token|api_key|apikey|key|secret|password|passwd|sig|signature|code|auth)=)[^&#\s]+"#, "$1[REDACTED]"),
    ])

    /// Generic shapes (long hex, long base64, `KEY=value` lines). These also hit commit
    /// SHAs and the like, so they only run on free text, never on URLs or titles where
    /// they'd break links. `/` is left out of the base64 class so file paths survive.
    private static let generic: [(NSRegularExpression, String)] = compile([
        (#"\b[a-fA-F0-9]{32,}\b"#, "[REDACTED_HEX]"),
        (#"\b(?=[A-Za-z0-9+]*[A-Z])(?=[A-Za-z0-9+]*[a-z])(?=[A-Za-z0-9+]*[0-9])[A-Za-z0-9+]{40,}={0,2}"#, "[REDACTED_BASE64]"),
        (#"(?m)^[A-Z_]{2,}=.{16,}$"#, "[REDACTED_ENV_VALUE]"),
    ])

    /// For URLs, window titles, meeting titles and other short structured fields.
    static func field(_ text: String?) -> String? {
        text.map { apply(specific, to: $0) }
    }

    /// For OCR, selected text, Slack messages and transcripts.
    static func freeText(_ text: String) -> String {
        apply(generic, to: apply(specific, to: text))
    }

    static func freeText(_ text: String?) -> String? {
        text.map(freeText)
    }

    private static func apply(_ rules: [(NSRegularExpression, String)], to text: String) -> String {
        var result = text
        for (regex, template) in rules {
            result = regex.stringByReplacingMatches(
                in: result, range: NSRange(result.startIndex..., in: result), withTemplate: template
            )
        }
        return result
    }

    private static func compile(_ rules: [(String, String)]) -> [(NSRegularExpression, String)] {
        rules.map { pattern, template in
            // The patterns are literals in this file; a bad one is a programming error.
            (try! NSRegularExpression(pattern: pattern), template)
        }
    }
}
