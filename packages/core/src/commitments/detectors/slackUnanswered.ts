import type { CommitmentCandidate, Detector, Resolution } from '../types.js';
import { accepted } from './slackClassify.js';
import {
  laterReplyFromMe,
  loadIdentity,
  loadMessageByHash,
  loadMessages,
  otherHandles,
  type SlackIdentity,
} from './slackMessages.js';
import { classifyInbound, clipTitle, counterpartyOf, loadScan, type Classified } from './slackScan.js';

/** Give yourself this long to answer before it counts as unanswered. */
const GRACE_SECONDS = 2 * 3600;

/**
 * Where a question can be "waiting on me": DMs and group DMs, or a channel message that
 * mentions me and no one else. Threads I merely posted in, and channel messages that also
 * @-address someone else, are excluded: in the eval (v3 prompt) those were every false
 * positive, the model can't reliably tell who a thread question is for, and a wrong
 * "you left someone hanging" costs more trust than a missed one.
 */
export function waitsOnMe(x: Classified, id: SlackIdentity): boolean {
  if (x.how === 'dm' || x.how === 'group_dm') return true;
  return x.how === 'mention' && otherHandles(x.m.text, id).length === 0;
}

/**
 * A question aimed at you with no later captured message from you where a reply would go.
 * Shares the inbound classification with slack_ask (cache hit), flag `expects_reply`.
 *
 * Thread identity comes from the permalink (`thread_ts`), since slack_messages has no thread
 * column; see laterReplyFromMe for what counts as "where a reply would go". Capture is lossy,
 * so a reply you sent but we never captured looks like silence: this list is "unanswered in
 * captured messages".
 */
export const slackUnanswered: Detector = {
  id: 'slack_unanswered',
  sources: ['slack_unanswered'],
  usesLocalModel: true,

  async detect(ctx) {
    const scan = loadScan(ctx);
    const waiting = scan.all.filter((m) => ctx.now - m.sentAt >= GRACE_SECONDS && !laterReplyFromMe(m, scan.mine));
    const results = await classifyInbound(scan, waiting, { cache: ctx.cache });
    const candidates: CommitmentCandidate[] = [];
    for (const x of results) {
      if (!accepted(x.c, 'expects_reply') || !waitsOnMe(x, scan.id)) continue;
      const who = counterpartyOf(x);
      candidates.push({
        source: 'slack_unanswered',
        source_ref: x.m.dedupe_hash,
        title: clipTitle(`Reply to ${who ?? 'message'}: ${x.c.title || x.c.quote}`),
        detail: x.c.quote,
        counterparty: who,
        due_hint: x.c.due_hint,
        committed_at: x.m.sentAt,
        confidence: x.c.confidence,
        last_activity_at: x.m.sentAt,
      });
    }
    return candidates;
  },

  async reconcile(open, ctx) {
    const id = loadIdentity();
    if (!id.name || open.length === 0) return [];
    const resolutions: Resolution[] = [];
    const earliest = Math.min(...open.map((c) => c.committed_at ?? c.detected_at));
    const mine = loadMessages(ctx.db, earliest, id).filter((m) => m.fromMe);
    for (const c of open) {
      const q = loadMessageByHash(ctx.db, c.source_ref, id);
      if (!q) continue;
      const reply = laterReplyFromMe(q, mine);
      if (reply) resolutions.push({ id: c.id, status: 'done', note: 'You replied in Slack' });
    }
    return resolutions;
  },
};
