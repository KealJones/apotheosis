import type { CommitmentCandidate, Detector } from '../types.js';
import { accepted } from './slackClassify.js';
import { classifyInbound, clipTitle, counterpartyOf, loadScan } from './slackScan.js';

/**
 * Someone asked *you* to do something: a DM, a mention, a group DM, or a thread you're in,
 * shaped like a request ("can you", "take a look", "RFR", "?"), confirmed by the local model.
 * `detail` is the verbatim span of their message.
 *
 * No reconcile: replying isn't doing. Close by hand or let the 30-day expiry take it.
 */
export const slackAsk: Detector = {
  id: 'slack_ask',
  sources: ['slack_ask'],
  usesLocalModel: true,

  async detect(ctx) {
    const scan = loadScan(ctx);
    const results = await classifyInbound(scan, scan.all, { cache: ctx.cache });
    const candidates: CommitmentCandidate[] = [];
    for (const x of results) {
      if (!accepted(x.c, 'is_commitment')) continue;
      candidates.push({
        source: 'slack_ask',
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
