import { z } from 'zod';
import { deleteMeeting as coreDeleteMeeting, type DeleteMeetingArgs } from '@apotheosis/core';

export const name = 'delete_meeting';
export const description =
  'Delete a meeting by ID: removes its `meetings` row, all `meeting_segments`, and any ' +
  'audio still on disk under `audio_path`.';

export const inputSchema = {
  meeting_id: z.number().describe('ID of the meeting to delete.'),
};

export async function handler(args: DeleteMeetingArgs) {
  const result = coreDeleteMeeting(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
