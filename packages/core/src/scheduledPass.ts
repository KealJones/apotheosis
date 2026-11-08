import { runDetectors, type RunReport } from './commitments/runner.js';
import { localModelBlockedReason, type GuardProbe } from './llm/localGuard.js';
import { unloadModel } from './llm/ollama.js';
import { digestEnabled, runSlackDigest, type DigestRunReport } from './slack/digest.js';

export interface PassOptions {
  /**
   * Apply the battery / memory-pressure guard to local-model work. The LaunchAgent run does;
   * an explicit user-triggered run (the run_detectors tool) doesn't.
   */
  guard?: boolean;
  lookbackSeconds?: number;
  probe?: GuardProbe;
}

export interface PassReport {
  detectors: RunReport;
  /** Why local-model work (Slack detectors, digest) was skipped this pass, or null. */
  local_model_skipped: string | null;
  /** Null when `slack.local_digest` is off or local-model work was skipped. */
  digest: DigestRunReport | null;
  /** Whether the model was unloaded at the end (false when it was never loaded). */
  unloaded_model: boolean;
}

/**
 * One full background pass: commitment detectors, then the opt-in Slack digest, then unload
 * the local model so it doesn't sit in memory until the next pass. Local-model work is
 * incremental (cached per message / per conversation), so a pass with no new Slack activity
 * makes no model calls at all.
 */
export async function runScheduledPass(opts: PassOptions = {}): Promise<PassReport> {
  const blocked = opts.guard ? localModelBlockedReason(opts.probe) : null;
  const detectors = await runDetectors({ skipLocalModel: blocked !== null, lookbackSeconds: opts.lookbackSeconds });
  const digest = digestEnabled() && !blocked ? await runSlackDigest() : null;
  const unloaded_model = await unloadModel();
  return { detectors, local_model_skipped: blocked, digest, unloaded_model };
}
