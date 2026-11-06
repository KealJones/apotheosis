import { z } from 'zod';
import { runDetectors } from '@apotheosis/core';

export const name = 'run_detectors';
export const description =
  'Force an immediate detector run (detect -> upsert -> reconcile -> auto-expire, across every registered commitment ' +
  'detector) instead of waiting for the next scheduled run. The Slack detectors call a local Ollama model for classification, ' +
  'so a full run can legitimately take anywhere from a few seconds to a few minutes depending on how much is unclassified — ' +
  'this call has no artificial timeout of its own and simply awaits the whole run, returning the full per-detector report ' +
  '(detected/inserted/resolved/errors, plus woken and expired counts) once it finishes. If your own client enforces a tool-call ' +
  'timeout, that limit belongs to the client, not this tool.';

export const inputSchema = {
  lookback_seconds: z.number().optional().describe('Override the default 7-day lookback window. Optional.'),
};

export async function handler(args: { lookback_seconds?: number }) {
  const report = await runDetectors({ lookbackSeconds: args.lookback_seconds });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
  };
}
