import { z } from 'zod';
import { getMeeting, type GetMeetingArgs } from '@apotheosis/core';

export const name = 'get_meeting';
export const description =
  'Get a meeting by id. Returns meeting details (title, time, platform, summary, action items, participants) ' +
  'and optionally the full transcript.';

export const inputSchema = {
  meeting_id: z.number().describe('The meeting ID to fetch.'),
  include_transcript: z.boolean().optional().describe('If true, include the full transcript as [mm:ss] speaker: text lines. Default false.'),
};

export async function handler(args: GetMeetingArgs) {
  const result = getMeeting(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
