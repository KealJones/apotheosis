import { z } from 'zod';
import { createProject as coreCreateProject, type CreateProjectArgs } from '@apotheosis/core';

export const name = 'create_project';
export const description =
  'Create a new project to track a body of work. Projects group evidence samples and ideas into a portfolio.';

export const inputSchema = {
  slug: z.string().describe('URL-friendly identifier. Must be unique.'),
  name: z.string().describe('Human-readable project name.'),
  description: z.string().optional().describe('What this project is about.'),
};

export async function handler(args: CreateProjectArgs) {
  const result = coreCreateProject(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
