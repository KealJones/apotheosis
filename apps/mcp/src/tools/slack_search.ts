import { z } from 'zod';
import { slackSearch as coreSlackSearch, type SlackSearchArgs } from '@apotheosis/core';

export const name = 'slack_search';
export const description =
  'Search structured Slack messages extracted from the accessibility tree by the capture daemon. ' +
  'Unlike OCR-based mentions, these rows have clean sender/text separation. ' +
  'Filter by free-text query, channel, sender, and time range. ' +
  'Each message has its conversation kind (dm, group_dm, channel), whether it is a thread reply, ' +
  'and reactions. Pass `context` to also get the thread parent and earlier messages around each hit. ' +
  'Only messages that were on screen while Slack was focused are captured.';

export const inputSchema = {
  q: z.string().optional().describe('Substring to search for in message text (case-insensitive).'),
  channel: z.string().optional().describe('Filter by channel/DM name substring.'),
  sender: z.string().optional().describe('Filter by sender display-name substring.'),
  since: z.string().optional().describe('Only messages captured on or after this ISO8601 timestamp.'),
  until: z.string().optional().describe('Only messages captured before this ISO8601 timestamp.'),
  limit: z.number().optional().describe('Max rows to return. Defaults to 50.'),
  context: z.number().optional().describe('Include the thread parent and up to this many earlier messages from the same thread/conversation. Max 20.'),
};

export async function handler(args: SlackSearchArgs) {
  const result = coreSlackSearch(args);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(result, null, 2),
    }],
  };
}
