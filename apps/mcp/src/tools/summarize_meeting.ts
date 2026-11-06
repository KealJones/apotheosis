import { z } from 'zod';
import { summarizeMeeting, type SummarizeMeetingArgs } from '@apotheosis/core';

export const name = 'summarize_meeting';
export const description =
  'Generate a structured summary of a meeting transcript (tldr, topics, decisions, action items, ' +
  'open questions, my_contributions) using a local Ollama model. Caches the result on the meeting; ' +
  'pass force:true to regenerate. Returns a clear error (not a fake summary) if Ollama is unreachable.';

export const inputSchema = {
  meeting_id: z.number().describe('The meeting ID to summarize.'),
  force: z.boolean().optional().describe('Regenerate even if a cached summary already exists. Optional; defaults to false.'),
};

export async function handler(args: SummarizeMeetingArgs) {
  const result = await summarizeMeeting(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
