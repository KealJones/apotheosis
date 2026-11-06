import { z } from 'zod';
import { resolveTodo, type TodoResolveArgs } from '@apotheosis/core';

export const name = 'todo_resolve';
export const description =
  'Resolve a commitment as "done" (satisfied), "dismissed" (dropped without being done, but the detection was fair), or ' +
  '"not_a_thing" (the item should never have been detected at all — a tunable, distinct signal from a generic dismiss, used ' +
  'to tune detector precision later). Always requires a one-line note explaining why.';

export const inputSchema = {
  id: z.number().describe('The commitment id.'),
  resolution: z.enum(['done', 'dismissed', 'not_a_thing']).describe('How to resolve it.'),
  note: z.string().describe('Required one-line reason.'),
};

export async function handler(args: TodoResolveArgs) {
  const result = resolveTodo(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
