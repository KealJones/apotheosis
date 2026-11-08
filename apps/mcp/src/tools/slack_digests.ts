import { z } from 'zod';
import { getSlackDigests } from '@apotheosis/core';

export const name = 'slack_digests';
export const description =
  'Short local-model digests of Slack conversations active in a time range: channel, participants, a one or two ' +
  'sentence summary, urgency, my to-dos, and open items, most urgent first. Use it to answer "what was I doing?" and ' +
  'to spot things I promised or left unsettled, without reading raw messages. Only populated when slack.local_digest ' +
  'is on in user-config.json (the response says so when it is off). `undigested` counts active conversations the local ' +
  'model has not caught up on yet; use slack_search for those.';

export const inputSchema = {
  since: z.string().describe('ISO8601 start of the range.'),
  until: z.string().optional().describe('ISO8601 end of the range. Defaults to now.'),
};

export async function handler(args: { since: string; until?: string }) {
  const since = Math.floor(Date.parse(args.since) / 1000);
  const until = Math.floor((args.until ? Date.parse(args.until) : Date.now()) / 1000);
  if (Number.isNaN(since) || Number.isNaN(until)) throw new Error('since/until must be ISO8601 timestamps');
  const result = getSlackDigests({ since, until });
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}
