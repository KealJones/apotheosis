import { z } from 'zod';
import { getTriageSamples, type TriageSamplesArgs } from '@apotheosis/core';

export const name = 'triage_samples';
export const description =
  'Group untagged screen samples for a given date into work clusters and score them ' +
  'by evidence signal strength (high/medium/low). Use this to decide what to keep or delete. ' +
  'Use compact=true for smaller responses suitable for LLM context windows.';

export const inputSchema = {
  date: z.string().describe('Date to triage in yyyy-mm-dd format.'),
  compact: z.boolean().optional().describe('Omit ocr_excerpt from clusters for smaller responses.'),
};

export async function handler(args: TriageSamplesArgs) {
  const result = getTriageSamples(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
