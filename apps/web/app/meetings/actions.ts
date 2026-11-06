'use server';

import { listMeetings as coreListMeetings, getMeeting as coreGetMeeting, deleteMeeting as coreDeleteMeeting, summarizeMeeting as coreSummarizeMeeting, searchMeetings as coreSearchMeetings } from '@apotheosis/core';

export async function listMeetingsAction(since?: string, until?: string, limit: number = 50) {
  try {
    const result = coreListMeetings({ since, until, limit });
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list meetings',
    };
  }
}

export async function getMeetingAction(meeting_id: number) {
  try {
    const result = coreGetMeeting({ meeting_id, include_transcript: true });
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get meeting',
    };
  }
}

export async function deleteMeetingAction(meeting_id: number) {
  try {
    const result = coreDeleteMeeting({ meeting_id });
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete meeting',
    };
  }
}

export async function summarizeMeetingAction(meeting_id: number, force: boolean = false) {
  try {
    const result = await coreSummarizeMeeting({ meeting_id, force });
    if ('error' in result) {
      return { success: false, error: result.error };
    }
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to summarize meeting',
    };
  }
}

export async function searchMeetingsAction(query: string, limit: number = 50) {
  try {
    const result = coreSearchMeetings({ query, limit });
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to search meetings',
    };
  }
}
