import { z } from 'zod';
import { getSummarizeWindow, type SummarizeWindowArgs } from '@apotheosis/core';

export const name = 'summarize_window';
export const description =
  'Group screen samples in a time window into contiguous work blocks. ' +
  'Returns blocks with duration, app context, and top words from OCR text. ' +
  'Use compact=true for smaller responses suitable for LLM context windows.';

export const inputSchema = {
  since: z.string().describe('Start of window, ISO8601.'),
  until: z.string().describe('End of window, ISO8601.'),
  compact: z.boolean().optional().describe('Omit ocr_excerpt, selected_texts, focused_elements for smaller responses.'),
  min_duration_min: z.number().optional().describe('Filter out blocks shorter than this many minutes.'),
  merge_gap_min: z.number().optional().describe('Merge blocks into sessions using this gap (minutes). Returns sessions instead of blocks.'),
};

export async function handler(args: SummarizeWindowArgs) {
  const result = getSummarizeWindow(args);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
