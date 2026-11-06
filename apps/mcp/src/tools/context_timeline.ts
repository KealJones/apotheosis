import { z } from 'zod';
import { getContextTimeline, type ContextTimelineArgs } from '@apotheosis/core';

export const name = 'context_timeline';
export const description =
  'Return context events (app switches, window focus changes, title changes, file modifications) ' +
  'for a time range. These are event-driven signals captured between screen samples.';

export const inputSchema = {
  since: z.string().describe('Start of range, ISO8601 (e.g. 2025-01-01T09:00:00).'),
  until: z.string().optional().describe('End of range, ISO8601. Defaults to now.'),
  event_type: z.string().optional().describe('Optional filter: app_switch, window_focus, title_change, file_modified.'),
};

export async function handler(args: ContextTimelineArgs) {
  const result = getContextTimeline(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
