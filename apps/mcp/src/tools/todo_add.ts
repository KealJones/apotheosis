import { z } from 'zod';
import { addManualCommitment, type AddManualCommitmentArgs } from '@apotheosis/core';

export const name = 'todo_add';
export const description =
  'Manually add a commitment (source "manual") for anything the automated detectors miss. Writes directly to the ledger, ' +
  'bypassing the detector framework. Always full-confidence, so it lands in the main ranked list, never the "maybe?" tray.';

export const inputSchema = {
  title: z.string().describe('Short, imperative title.'),
  detail: z.string().optional().describe('Optional longer detail.'),
  counterparty: z.string().optional().describe('Optional: who this is owed to, when known.'),
  due_hint: z.string().optional().describe('Optional due date or phrase, e.g. "Friday", "EOD".'),
};

export async function handler(args: AddManualCommitmentArgs) {
  const commitment = addManualCommitment(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(commitment, null, 2) }],
  };
}
