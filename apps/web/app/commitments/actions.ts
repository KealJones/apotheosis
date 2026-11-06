'use server';

import {
  resolveTodo as coreResolveTodo,
  snoozeCommitment as coreSnoozeCommitment,
  type TodoResolution,
} from '@apotheosis/core';

/**
 * Backs the Done / Not a thing row actions (see todo_resolve). Returns only success/error,
 * not the mutated row: `node:sqlite`'s row objects aren't plain enough for Next.js to pass a
 * Server Action's return value to a Client Component (a real bug hit during manual
 * verification -- "Only plain objects... can be passed to Client Components"), and callers
 * only ever call `router.refresh()` afterward anyway, so there's nothing to gain by shipping
 * the row across the boundary.
 */
export async function resolveCommitmentAction(id: number, resolution: TodoResolution, note: string) {
  try {
    const result = coreResolveTodo({ id, resolution, note });
    if (!result.ok) {
      return { success: false, error: result.error ?? 'Failed to resolve commitment' };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to resolve commitment',
    };
  }
}

/** `until` is free text - "tomorrow", "next monday", "next week" - parsed by parseDueHint. */
export async function snoozeCommitmentAction(id: number, until: string) {
  try {
    const result = coreSnoozeCommitment(id, until);
    if (!result.ok) {
      return { success: false, error: result.error ?? 'Failed to snooze commitment' };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to snooze commitment',
    };
  }
}
