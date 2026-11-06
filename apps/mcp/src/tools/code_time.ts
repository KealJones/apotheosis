import { z } from 'zod';
import { getCodeTime, type CodeTimeArgs } from '@apotheosis/core';

export const name = 'code_time';
export const description =
  'Show coding activity for a git repo: commits authored since a date, ' +
  'plus estimated active time from screen samples matching the repo name.';

export const inputSchema = {
  repo_path: z.string().describe('Absolute path to the git repository.'),
  since: z.string().describe('Start date, ISO8601 or git-date format.'),
};

export async function handler(args: CodeTimeArgs) {
  const result = getCodeTime(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
