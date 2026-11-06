import { z } from 'zod';
import { reviewStatus, type ReviewStatusArgs } from '@apotheosis/core';

export const name = 'review_status';
export const description =
  'Score captured evidence against the configured leveling guide (promo-packet.yaml) for a promo packet or ' +
  'review. Grades each criterion met/partial/gap against the TARGET level (current level text is included ' +
  'for contrast), with citations that are refs to real records (resolve at /review/evidence/<ref> in the ' +
  'dashboard). A criterion without evidence is always gap. Uses a local Ollama model; cached per evidence ' +
  'fingerprint, so repeat calls are fast. If Ollama is unreachable, affected criteria are "unscored" and ' +
  'llm_error explains why. Only cite what this returns; do not upgrade a status in prose.';

export const inputSchema = {
  target_level: z.string().optional().describe('Level to score against (p1..p7). Defaults to promo-packet.yaml defaults.target_level.'),
  current_level: z.string().optional().describe('Current level (p1..p7). Defaults to promo-packet.yaml defaults.current_level.'),
  since: z.string().optional().describe('Start of evidence range, ISO8601. Defaults to Jan 1 of this year.'),
  until: z.string().optional().describe('End of evidence range, ISO8601. Defaults to now.'),
  force: z.boolean().optional().describe('Rescore instead of using cached scores. Default false.'),
};

export async function handler(args: ReviewStatusArgs) {
  const result = await reviewStatus(args);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
