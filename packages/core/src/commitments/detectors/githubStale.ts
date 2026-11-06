import type { CommitmentCandidate, Detector, Resolution } from '../types.js';
import { myPrByUrl, myPrsAcrossActiveRepos, toUnix, type RepoPr } from './myPrs.js';

const DAY = 86_400;
/** No update in this long and an open PR counts as stale. A week matches the standup/inbox
 *  cadence — anything older than that has fallen off a normal weekly rhythm. */
const STALE_DAYS = 7;
/** Drafts get a longer leash: two weeks is "you clearly meant to keep working on this and
 *  didn't", vs. a week which is a completely normal draft lifetime. */
const DRAFT_STALE_DAYS = 14;

function staleReasons(pr: RepoPr, now: number): string[] {
  const reasons: string[] = [];
  if (now - toUnix(pr.updatedAt) > STALE_DAYS * DAY) reasons.push(`no activity in ${STALE_DAYS}+ days`);
  if (pr.reviewDecision === 'APPROVED') reasons.push('approved but unmerged');
  if (pr.isDraft && now - toUnix(pr.createdAt) > DRAFT_STALE_DAYS * DAY) reasons.push(`draft for ${DRAFT_STALE_DAYS}+ days`);
  return reasons;
}

/**
 * Your own open PR that's gone quiet: no activity in a week, approved but not merged, or a
 * draft that's sat for two weeks. Three different flavors of "this needs a nudge", one
 * detector because they share the same remedy (go look at it) and the same resolution rule
 * (merged/closed, or no longer meets any of the conditions).
 */
export const githubStale: Detector = {
  id: 'github_stale',
  sources: ['github_stale'],

  async detect(ctx) {
    const candidates: CommitmentCandidate[] = [];
    for (const pr of myPrsAcrossActiveRepos(ctx)) {
      if (pr.state !== 'OPEN') continue;
      const reasons = staleReasons(pr, ctx.now);
      if (reasons.length === 0) continue;

      candidates.push({
        source: 'github_stale',
        source_ref: pr.url,
        title: `Stale PR: ${pr.title}`,
        detail: `${reasons.join('; ')} — repo: ${pr.nwo}`,
        confidence: 0.75,
        last_activity_at: toUnix(pr.updatedAt),
      });
    }
    return candidates;
  },

  async reconcile(open, ctx) {
    const resolutions: Resolution[] = [];
    for (const c of open) {
      const pr = myPrByUrl(c.source_ref);
      if (!pr) continue; // couldn't refresh this run — leave open, retry later

      if (pr.state === 'MERGED') {
        resolutions.push({ id: c.id, status: 'done', note: 'PR merged' });
      } else if (pr.state === 'CLOSED') {
        resolutions.push({ id: c.id, status: 'dismissed', note: 'PR closed without merging' });
      } else if (staleReasons(pr, ctx.now).length === 0) {
        resolutions.push({ id: c.id, status: 'done', note: 'No longer stale' });
      }
    }
    return resolutions;
  },
};
