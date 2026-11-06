import { z } from 'zod';
import { getUsageStats, type UsageStatsArgs } from '@apotheosis/core';

export const name = 'usage_stats';
export const description =
  'Show usage statistics for MCP tools and skills — total calls, calls per day, last used.';

export const inputSchema = {
  since: z.string().optional().describe('Only count usage since this ISO8601 date. Defaults to all time.'),
  kind: z.enum(['tool', 'skill']).optional().describe('Filter by "tool" or "skill". Defaults to both.'),
};

/** Skill-call bookkeeping itself; logging these to tool_usage would count every call twice. */
export const trackUsage = false;

export async function handler(args: UsageStatsArgs) {
  const result = getUsageStats(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
