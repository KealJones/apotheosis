import { z } from 'zod';
import { snoozeCommitment } from '@apotheosis/core';

export const name = 'todo_snooze';
export const description =
  'Snooze a commitment until a date ("2026-10-03") or a relative phrase ("next Monday", "EOD", "tomorrow") — reuses the same ' +
  'due-hint parser C6 uses for ranking (parseDueHint), so no new date parser was written for this. The detector runner wakes ' +
  'it back to "open" automatically once snoozed_until passes.';

export const inputSchema = {
  id: z.number().describe('The commitment id.'),
  until: z.string().describe('A date or relative phrase, e.g. "2026-10-03", "next Monday", "EOD", "tomorrow".'),
};

export async function handler(args: { id: number; until: string }) {
  const result = snoozeCommitment(args.id, args.until);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
