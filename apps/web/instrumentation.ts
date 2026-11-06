// Runs once when the Next.js server process starts (both `next dev` and
// `next start`), before any request is served. See lib/host-guard.ts for why.
//
// Next.js only surfaces a thrown error here as a per-request 500 (the
// process itself keeps listening) — not a real "refuse to start". For a
// check this security-sensitive we want a hard process exit instead, so the
// bad config is impossible to miss and nothing is ever served.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertSafeHost } = await import("./lib/host-guard");
    try {
      assertSafeHost();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }
}
