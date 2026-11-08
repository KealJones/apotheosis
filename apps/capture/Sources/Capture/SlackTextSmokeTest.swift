import Foundation

/// `Capture --smoke-slack-text` checks the pure text helpers SlackExtractor uses to build
/// message bodies. The AX walk itself needs a live Slack, so it is checked by hand with
/// `--slack-messages`; this covers how quote blocks end up in the stored text.
enum SlackTextSmokeTest {
    static func run() -> Never {
        var failures = 0
        func check(_ name: String, _ got: String, _ want: String) {
            let ok = got == want
            print("[\(ok ? "PASS" : "FAIL")] \(name)\(ok ? "" : "\n  got:  \(got.debugDescription)\n  want: \(want.debugDescription)")")
            if !ok { failures += 1 }
        }

        check("single quoted line",
              SlackExtractor.quoteLines("Could we ship the beta flag first?"),
              "> Could we ship the beta flag first?")
        check("multi-line quote trims edges and each line",
              SlackExtractor.quoteLines("\n  first line \nsecond line\n"),
              "> first line\n> second line")
        // What parseItem builds for a quote followed by the sender's own reply.
        let raw = SlackExtractor.quoteLines("Could we ship the beta flag first?") + "\n" + "Sounds good, I'll do it today\n"
        check("quote stays on its own lines before the reply",
              SlackExtractor.normalizeBody(raw),
              "> Could we ship the beta flag first?\nSounds good, I'll do it today")

        print(failures == 0 ? "smoke: all passed" : "smoke: \(failures) failed")
        exit(failures == 0 ? 0 : 1)
    }
}
