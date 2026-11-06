import { z } from 'zod';
import { logIdea as coreLogIdea, type LogIdeaArgs } from '@apotheosis/core';

export const name = 'log_idea';
export const description =
  'Record a new idea or observation. Returns the saved idea and any similar existing ideas ' +
  'so you can spot duplicates before they pile up.';

export const inputSchema = {
  body: z.string().describe('The idea text.'),
  source: z.string().optional().describe('Where the idea came from.'),
};

export async function handler(args: LogIdeaArgs) {
  const result = coreLogIdea(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
