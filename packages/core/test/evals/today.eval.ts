/**
 * Evaluation criteria for the /today skill.
 *
 * Given the fixture data, a good timeline should:
 * - Show chronological activity blocks
 * - Include key work context (apps, JIRA tickets)
 * - Not include noise/personal browsing
 */

export const todayCriteria = {
  mustInclude: [
    'WID-4582',                    // JIRA ticket visible across multiple sessions
    'Code',                        // VS Code app name (primary work activity)
    'Chrome',                      // Browser sessions
    'Slack',                       // Communication activity
  ],

  mustNotInclude: [
    'weekend hiking trails',            // Personal browsing
  ],

  mustSatisfy: [
    'entries are in chronological order',
    'includes time information for each block',
    'includes app context for each block',
    'no raw OCR text dumped verbatim',
  ],

  dataChecks: {
    summarize_window: {
      blockCount: { min: 5, max: 25 },
    },
    context_timeline: {
      hasEvents: true,
      hasAppSwitches: true,
    },
  },
};
