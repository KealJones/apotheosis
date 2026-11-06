import { z } from 'zod';
import { linkMeetingCalendarEvent as coreLinkMeetingCalendarEvent, type LinkMeetingCalendarEventArgs } from '@apotheosis/core';

export const name = 'link_meeting_calendar_event';
export const description =
  'Correlate a meeting with a Google Calendar event: sets `calendar_event_id`, and ' +
  'optionally the real `title` and `participants` (attendee names). Additive and ' +
  'idempotent — only ever sets `calendar_event_id` when it is currently NULL; if the ' +
  'meeting is already linked, this is a no-op that reports the existing link instead of ' +
  'overwriting it.';

export const inputSchema = {
  meeting_id: z.number().describe('ID of the meeting to correlate.'),
  calendar_event_id: z.string().describe('The Google Calendar event id to link.'),
  title: z.string().optional().describe('Optional: the calendar event\'s title, to fill in the meeting\'s title.'),
  participants: z.array(z.string()).optional().describe('Optional: attendee names from the calendar event.'),
};

export async function handler(args: LinkMeetingCalendarEventArgs) {
  const result = coreLinkMeetingCalendarEvent(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
