/**
 * Evaluation criteria for the /standup skill.
 *
 * Given the fixture data (synthetic workday 2026-05-18), a good standup:
 * - Must mention real work signals (JIRA, PRs, key activities)
 * - Must not include personal browsing
 * - Must follow the correct format
 */

export const standupCriteria = {
  /** Items that MUST appear in the standup output */
  mustInclude: [
    'WID-4582',                    // Primary JIRA ticket with 30+ min screen time
    '2350',                        // PR number (in any format: #2350, widgets#2350, etc.)
    'Code Connect',                // Core work theme (appears in ADR, figma files)
    'Morgan',                    // Slack DM context for follow-up mentions
  ],

  /** Items that MUST NOT appear in the standup output */
  mustNotInclude: [
    'weekend hiking trails',            // Personal browsing — should be filtered
    'Panda New Tab',               // Low-signal new tab page
  ],

  /** Structural requirements the standup must satisfy */
  mustSatisfy: [
    'has Yesterday section',
    'has Today section',
    'has Blockers section',
    'under 25 lines total',
    'no raw OCR text dumped verbatim',
  ],

  /** Checks on the MCP tool data that feeds the skill */
  dataChecks: {
    summarize_window: {
      blockCount: { min: 5, max: 25 },
      hasJiraTickets: true,
      hasPrUrls: true,
    },
    standup_draft: {
      sessionCount: { min: 3, max: 20 },
      hasContextSummary: true,
      hasFollowUps: true,
    },
  },
};
