import { z } from 'zod';
import { runScheduledPass } from '@apotheosis/core';

export const name = 'run_detectors';
export const description =
  'Force an immediate detector run (detect -> upsert -> reconcile -> auto-expire, across every registered commitment ' +
  'detector) instead of waiting for the next scheduled run. The Slack detectors call a local Ollama model for classification, ' +
  'so a full run can legitimately take anywhere from a few seconds to a few minutes depending on how much is unclassified — ' +
  'this call has no artificial timeout of its own and simply awaits the whole run, returning the full per-detector report ' +
  '(detected/inserted/resolved/errors, plus woken and expired counts) once it finishes. If your own client enforces a tool-call ' +
  'timeout, that limit belongs to the client, not this tool. Also refreshes Slack digests when slack.local_digest is on, ' +
  'then unloads the local model. Unlike the scheduled run, it ignores the battery / memory-pressure guard.';

export const inputSchema = {
  lookback_seconds: z.number().optional().describe('Override the default 7-day lookback window. Optional.'),
};

export async function handler(args: { lookback_seconds?: number }) {
  const { detectors, ...pass } = await runScheduledPass({ guard: false, lookbackSeconds: args.lookback_seconds });
  const report = { ...detectors, ...pass };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
  };
}
