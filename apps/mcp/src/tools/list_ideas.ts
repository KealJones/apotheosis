import { z } from 'zod';
import { listIdeas as coreListIdeas, type ListIdeasArgs } from '@apotheosis/core';

export const name = 'list_ideas';
export const description =
  'List recorded ideas, optionally filtered by date or search term.';

export const inputSchema = {
  since: z.string().optional().describe('Only return ideas created on or after this ISO8601 timestamp.'),
  search: z.string().optional().describe('Full-text substring search in idea body.'),
};

export async function handler(args: ListIdeasArgs) {
  const result = coreListIdeas(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
