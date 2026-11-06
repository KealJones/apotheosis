import type { CommitmentCandidate, Detector } from '../types.js';
import { accepted } from './slackClassify.js';
import { classifyOutbound, clipTitle, counterpartyOf, loadScan } from './slackScan.js';

/**
 * Something *you* said you'd do, in your own captured Slack messages. Regex prefilter on
 * first-person future forms ("I'll", "ill take", "let me", "on my list"), then the local
 * model decides whether it's a real commitment. `detail` is the verbatim quote it rests on.
 *
 * No reconcile: saying "done" in Slack is too loose a signal to auto-close on. These close
 * by hand or age out via the runner's 30-day expiry, measured from when you said it.
 */
export const slackPromise: Detector = {
  id: 'slack_promise',
  sources: ['slack_promise'],

  async detect(ctx) {
    const scan = loadScan(ctx);
    const results = await classifyOutbound(scan, scan.mine, { cache: ctx.cache });
    const candidates: CommitmentCandidate[] = [];
    for (const x of results) {
      if (!accepted(x.c, 'is_commitment')) continue;
      candidates.push({
        source: 'slack_promise',
        source_ref: x.m.dedupe_hash,
        title: clipTitle(x.c.title || x.c.quote),
        detail: x.c.quote,
        counterparty: counterpartyOf(x),
        due_hint: x.c.due_hint,
        committed_at: x.m.sentAt,
        confidence: x.c.confidence,
        last_activity_at: x.m.sentAt,
      });
    }
    return candidates;
  },

  async reconcile() {
    return [];
  },
};
