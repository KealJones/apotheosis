import { getPendingReviews, getPrState } from '../../integrations/github.js';
import type { CommitmentCandidate, Detector, DetectorContext, Resolution } from '../types.js';

const ROUND_SUFFIX = /#round=(\d+)$/;

/**
 * GitHub clears a PR from `review-requested:@me` the moment you submit a review, so the same
 * PR can legitimately come back later (changes pushed, review re-requested) — a fresh round,
 * not a reopen of the terminal row from last time. `source_ref` encodes that round as
 * `<pr-url>#round=N`, found by looking at the most recent row for this URL: if it's terminal
 * (done/dismissed), this detection is the *next* round; otherwise it's the same one.
 */
function currentRound(ctx: DetectorContext, url: string): number {
  const row = ctx.db.prepare(`
    SELECT source_ref, status FROM commitments
    WHERE source = 'github_review_requested' AND source_ref LIKE ?
    ORDER BY id DESC LIMIT 1
  `).get(`${url}#round=%`) as { source_ref: string; status: string } | undefined;
  if (!row) return 0;
  const m = row.source_ref.match(ROUND_SUFFIX);
  const round = m ? Number(m[1]) : 0;
  return row.status === 'done' || row.status === 'dismissed' ? round + 1 : round;
}

function urlOf(sourceRef: string): string {
  return sourceRef.replace(ROUND_SUFFIX, '');
}

export const githubReviewRequested: Detector = {
  id: 'github_review_requested',
  sources: ['github_review_requested'],

  async detect(ctx) {
    const prs = getPendingReviews();
    return prs.map((pr): CommitmentCandidate => ({
      source: 'github_review_requested',
      source_ref: `${pr.url}#round=${currentRound(ctx, pr.url)}`,
      title: `Review requested: ${pr.title}`,
      detail: pr.repo ? `Repo: ${pr.repo}` : undefined,
      confidence: 0.95,
      last_activity_at: pr.updatedAt ? Math.floor(new Date(pr.updatedAt).getTime() / 1000) : ctx.now,
    }));
  },

  async reconcile(open) {
    const stillRequested = new Set(getPendingReviews().map((p) => p.url));
    const resolutions: Resolution[] = [];
    for (const c of open) {
      const url = urlOf(c.source_ref);
      if (stillRequested.has(url)) continue; // still outstanding, nothing to do

      // Bounded by how many requests resolved this run, not by how many are open.
      const state = getPrState(url);
      if (!state) continue; // couldn't determine (gh error, deleted PR) — leave open, retry next run

      if (state.state === 'MERGED') {
        resolutions.push({ id: c.id, status: 'done', note: 'PR merged' });
      } else if (state.state === 'CLOSED') {
        resolutions.push({ id: c.id, status: 'dismissed', note: 'PR closed without merging' });
      } else {
        // Still open on GitHub, but you're no longer a requested reviewer: your review landed.
        resolutions.push({ id: c.id, status: 'done', note: 'Review submitted' });
      }
    }
    return resolutions;
  },
};
