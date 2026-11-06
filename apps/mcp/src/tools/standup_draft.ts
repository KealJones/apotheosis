import { z } from 'zod';
import { getStandupDraft, type StandupDraftArgs } from '@apotheosis/core';

export const name = 'standup_draft';
export const description =
  'Assemble raw data for a standup note: yesterday\'s work blocks, Slack threads I posted in or read, ' +
  'Claude Code sessions, pending follow-ups, open PRs, and recent ideas. Claude turns this into prose. ' +
  'Pass since/until to report on a range other than the day before `date` (e.g. Thursday-Friday on a Monday). ' +
  'Use compact=true for smaller responses suitable for LLM context windows.';

export const inputSchema = {
  date: z.string().optional().describe('Date for the standup in yyyy-mm-dd format. Defaults to today.'),
  compact: z.boolean().optional().describe('Omit yesterday_blocks and reduce field verbosity.'),
  since: z.string().optional().describe('ISO8601 start of the range to report on. Defaults to the day before `date`.'),
  until: z.string().optional().describe('ISO8601 end of the range to report on.'),
};

export async function handler(args: StandupDraftArgs) {
  const result = getStandupDraft(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
