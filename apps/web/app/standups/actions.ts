'use server';

import { getStandupDraft, logStandup as coreLogStandup, listStandups } from '@apotheosis/core';

export async function getStandupDraftAction(date: string) {
  try {
    const draft = getStandupDraft({ date });
    return { success: true, data: draft };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get standup draft',
    };
  }
}

export async function logStandupAction(args: {
  date: string;
  yesterday: string;
  today?: string;
  blockers?: string;
}) {
  try {
    coreLogStandup(args);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to log standup',
    };
  }
}

export async function listStandupsAction(limit: number = 50, offset: number = 0) {
  try {
    const result = listStandups({ limit, offset });
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list standups',
    };
  }
}
