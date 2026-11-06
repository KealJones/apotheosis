import { z } from 'zod';
import { getInbox as coreGetInbox, type GetInboxArgs } from '@apotheosis/core';

export const name = 'get_inbox';
export const description =
  'Consolidated inbox: unread mentions, pending PR reviews, and open follow-ups in one call. ' +
  'Designed for compact LLM consumption — no disk saves or jq needed.';

export const inputSchema = {
  mentions_since: z.string().optional().describe('Start of mention search range, ISO8601. Defaults to 48 hours ago.'),
};

export async function handler(args: GetInboxArgs) {
  const result = coreGetInbox(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
