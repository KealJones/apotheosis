import { z } from 'zod';
import { getProject as coreGetProject, type GetProjectArgs } from '@apotheosis/core';

export const name = 'get_project';
export const description =
  'Fetch a project by slug, including all its linked evidence and external references.';

export const inputSchema = {
  slug: z.string().describe('The project slug.'),
};

export async function handler(args: GetProjectArgs) {
  const result = coreGetProject(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
