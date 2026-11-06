import { z } from 'zod';
import { listMeetings, type ListMeetingsArgs } from '@apotheosis/core';

export const name = 'list_meetings';
export const description =
  'List meetings attended within a date range. Returns meeting id, title, start time, duration, platform, ' +
  'whether a summary exists, and number of transcript segments.';

export const inputSchema = {
  since: z.string().optional().describe('Start date, ISO8601 (e.g. "2026-01-01"). Optional; defaults to all time.'),
  until: z.string().optional().describe('End date, ISO8601. Optional; defaults to now.'),
  platform: z.string().optional().describe('Filter by platform (e.g. "zoom", "teams", "google_meet"). Optional.'),
  limit: z.number().optional().describe('Maximum number of meetings to return. Optional; defaults to all.'),
};

export async function handler(args: ListMeetingsArgs) {
  const result = listMeetings(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
