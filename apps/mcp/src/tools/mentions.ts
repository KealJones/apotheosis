import { z } from 'zod';
import { getMentions, type MentionsArgs } from '@apotheosis/core';

export const name = 'mentions';
export const description =
  'Search OCR text from screen samples for @-mentions and name references. ' +
  'Patterns are configured in user-config.json in the data directory. ' +
  'Groups matches by context (app + window + url) and returns excerpts with timestamps. ' +
  'Use compact=true for smaller responses with just group summaries.';

export const inputSchema = {
  since: z.string().describe('Start of search range, ISO8601.'),
  compact: z.boolean().optional().describe('Return only grouped summaries without individual mention excerpts.'),
};

export async function handler(args: MentionsArgs) {
  const result = getMentions(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
