import { z } from 'zod';
import { listUncorrelatedMeetings, type ListUncorrelatedMeetingsArgs } from '@apotheosis/core';

export const name = 'list_uncorrelated_meetings';
export const description =
  'List meetings that have no `calendar_event_id` yet (i.e. not yet matched to a Google ' +
  'Calendar event). Returns id, title, start/end time, url, and platform — enough to match ' +
  'each one against a calendar event by start time.';

export const inputSchema = {
  limit: z.number().optional().describe('Maximum number of meetings to return. Optional; defaults to all.'),
};

export async function handler(args: ListUncorrelatedMeetingsArgs) {
  const result = listUncorrelatedMeetings(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
