import { z } from 'zod';
import { getEvidenceReport, type EvidenceReportArgs } from '@apotheosis/core';

export const name = 'evidence_report';
export const description =
  'Aggregate captured activity into a compact evidence payload for performance reviews, ' +
  'promo packets, brag docs, and self-assessments. Pulls tracked projects and their linked ' +
  'evidence, logged standups in range, AI tool/skill usage stats, captured ideas, and Slack ' +
  'signals matching recognition/leadership keywords (praise, handoffs, thanks, shout-outs). ' +
  'This is the data pass for the /evidence skill — feed it a date range and narrate the result.';

export const inputSchema = {
  since: z.string().optional().describe('Start of range, ISO8601 (e.g. 2026-01-01). Defaults to all time.'),
  until: z.string().optional().describe('End of range, ISO8601. Defaults to now.'),
  slack_keywords: z.array(z.string()).optional().describe('Override recognition/leadership keywords searched in Slack. Defaults to a built-in set.'),
  include_standups: z.boolean().optional().describe('Include full logged standups in range. Default true.'),
};

export async function handler(args: EvidenceReportArgs) {
  const result = getEvidenceReport(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
