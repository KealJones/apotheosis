import { z } from 'zod';
import { logUsage } from '@apotheosis/core';

export const name = 'log_usage';
export const description =
  'Log a skill invocation for usage tracking. Call this as the first step in any skill.';

export const inputSchema = {
  skill: z.string().describe('The skill name (e.g. "standup", "today", "cleanup-samples").'),
  args: z.string().optional().describe('Optional: the arguments passed to the skill.'),
};

/** Skill-call bookkeeping itself; logging these to tool_usage would count every call twice. */
export const trackUsage = false;

interface Args {
  skill: string;
  args?: string;
}

export async function handler(args: Args) {
  logUsage('skill', args.skill, args.args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ logged: true, skill: args.skill }) }],
  };
}
