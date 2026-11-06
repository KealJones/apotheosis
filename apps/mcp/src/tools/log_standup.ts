import { z } from 'zod';
import { logStandup as coreLogStandup, type LogStandupArgs } from '@apotheosis/core';

export const name = 'log_standup';
export const description =
  'Save a standup to the database. Inserts or replaces the standup for the given date.';

export const inputSchema = {
  date: z.string().describe('Date for the standup in yyyy-mm-dd format.'),
  yesterday: z.string().describe('The "yesterday" section of the standup.'),
  today: z.string().optional().describe('The "today" section.'),
  blockers: z.string().optional().describe('The "blockers" section.'),
  today_commitment_ids: z.array(z.number().nullable()).optional().describe(
    'Parallel to the "today" section\'s split lines: the commitment id (from todo_list) each line came from, or null ' +
    'for a freehand line. Populates standup_items.commitment_id.'
  ),
};

export async function handler(args: LogStandupArgs & { today_commitment_ids?: (number | null)[] }) {
  coreLogStandup({ ...args, todayCommitmentIds: args.today_commitment_ids });

  return {
    content: [{ type: 'text' as const, text: `Standup logged for ${args.date}.` }],
  };
}
