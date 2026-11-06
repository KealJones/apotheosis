import { z } from 'zod';
import { deleteSamples as coreDeleteSamples, type DeleteSamplesArgs } from '@apotheosis/core';

export const name = 'delete_samples';
export const description =
  'Delete screen samples by ID. Refuses to delete samples marked as evidence (is_evidence=1). ' +
  'Also removes the screenshot file from disk.';

export const inputSchema = {
  ids: z.array(z.number()).describe('Array of sample IDs to delete.'),
};

export async function handler(args: DeleteSamplesArgs) {
  const result = coreDeleteSamples(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
