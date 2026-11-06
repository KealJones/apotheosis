/**
 * Evaluation criteria for the /cleanup-samples skill.
 *
 * Given the fixture data, a good triage should:
 * - Identify high-signal clusters (JIRA work, PR reviews)
 * - Identify low-signal clusters (personal, blips)
 * - Never suggest deleting evidence-tagged samples
 */

export const cleanupCriteria = {
  mustInclude: [
    'WID-4582',                    // High-signal work cluster
  ],

  mustNotInclude: [
    // Nothing specific — the skill shows everything for the user to decide
  ],

  mustSatisfy: [
    'evidence-tagged samples are excluded from triage',
    'clusters are scored by signal strength (high/medium/low)',
    'personal browsing clusters appear with low signal',
    'user is prompted before any deletions',
  ],

  dataChecks: {
    triage_samples: {
      hasHighSignal: true,
      hasLowSignal: true,
      excludesEvidence: true,
      clusterCount: { min: 3, max: 20 },
    },
  },
};
