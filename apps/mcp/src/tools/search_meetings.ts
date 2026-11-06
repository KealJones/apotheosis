import { z } from 'zod';
import { searchMeetings, type SearchMeetingsArgs } from '@apotheosis/core';

export const name = 'search_meetings';
export const description =
  'Full-text search across meeting transcripts. Returns matching segments with meeting context ' +
  '(meeting id, title, start time) and segment timestamp.';

export const inputSchema = {
  query: z.string().describe('Full-text search query. FTS5 syntax supported (e.g. "word1 AND word2", "word1 OR word2").'),
  limit: z.number().optional().describe('Maximum results to return. Optional; defaults to 50.'),
};

export async function handler(args: SearchMeetingsArgs) {
  const result = searchMeetings(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
