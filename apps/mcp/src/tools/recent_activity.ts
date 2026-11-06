import { z } from 'zod';
import { getRecentActivity, type RecentActivityArgs } from '@apotheosis/core';

export const name = 'recent_activity';
export const description =
  'Return a list of screen samples (activity) captured between two timestamps. ' +
  'Each sample includes OCR excerpt and accessibility context.';

export const inputSchema = {
  since: z.string().describe('Start of range, ISO8601 (e.g. 2025-01-01T09:00:00)'),
  until: z.string().optional().describe('End of range, ISO8601. Defaults to now.'),
  app: z.string().optional().describe('Optional filter: app name or bundle substring.'),
};

export async function handler(args: RecentActivityArgs) {
  const result = getRecentActivity(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
