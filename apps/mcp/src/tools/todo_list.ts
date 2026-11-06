import { z } from 'zod';
import { getTodoList, type TodoListArgs } from '@apotheosis/core';

export const name = 'todo_list';
export const description =
  'Ranked list of open commitments — "what did I say I would do and never did", across standups, Slack, PRs, meetings, ' +
  'and local git. Wraps the C6 ranking function (age, source weight, due proximity, detector confidence). Returns at most ' +
  '`limit` items (default 7), sorted by score descending; low-confidence items go to a separate "maybe" tray instead of ' +
  'polluting the main list.';

export const inputSchema = {
  limit: z.number().optional().describe('Max items in the main ranked list. Defaults to 7.'),
  include_maybe: z.boolean().optional().describe('Include the low-confidence "maybe?" tray. Defaults to false.'),
  source: z.string().optional().describe('Filter to one commitment source (e.g. "slack_promise", "github_review_requested").'),
};

export async function handler(args: TodoListArgs) {
  const result = getTodoList(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
