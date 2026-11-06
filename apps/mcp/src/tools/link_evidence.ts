import { z } from 'zod';
import { linkEvidence as coreLinkEvidence, type LinkEvidenceArgs } from '@apotheosis/core';

export const name = 'link_evidence';
export const description =
  'Mark screen samples as evidence for a project. Sets is_evidence=1 on the samples ' +
  'and records the link in project_links.';

export const inputSchema = {
  project_slug: z.string().describe('Slug of the project to link evidence to.'),
  sample_ids: z.array(z.number()).describe('Array of sample IDs to mark as evidence.'),
};

export async function handler(args: LinkEvidenceArgs) {
  const result = coreLinkEvidence(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
