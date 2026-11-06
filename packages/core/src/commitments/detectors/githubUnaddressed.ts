import { getViewerLogin } from '../../integrations/github.js';
import type { CommitmentCandidate, Detector, Resolution } from '../types.js';
import { myPrByUrl, myPrsAcrossActiveRepos, toUnix, unaddressedState } from './myPrs.js';

/**
 * Your own open PR has review comments or "changes requested" newer than your last push. The
 * one that silently kills PRs: reviewers respond, you're on to something else, and it never
 * comes back up. See `unaddressedState()` in ./myPrs.js for what "unaddressed" means exactly.
 */
export const githubUnaddressed: Detector = {
  id: 'github_unaddressed',
  sources: ['github_unaddressed'],

  async detect(ctx) {
    const viewer = getViewerLogin();
    const candidates: CommitmentCandidate[] = [];
    for (const pr of myPrsAcrossActiveRepos(ctx)) {
      if (pr.state !== 'OPEN') continue;
      const { unaddressed, lastPush, newestOutside } = unaddressedState(pr, viewer);
      if (!unaddressed) continue;

      candidates.push({
        source: 'github_unaddressed',
        source_ref: pr.url,
        title: `Unaddressed feedback: ${pr.title}`,
        detail: pr.reviewDecision === 'CHANGES_REQUESTED'
          ? `Changes requested, repo: ${pr.nwo}`
          : `New review activity since your last push, repo: ${pr.nwo}`,
        confidence: 0.85,
        last_activity_at: Math.max(newestOutside, lastPush, toUnix(pr.updatedAt)),
      });
    }
    return candidates;
  },

  async reconcile(open) {
    const viewer = getViewerLogin();
    const resolutions: Resolution[] = [];
    for (const c of open) {
      const pr = myPrByUrl(c.source_ref);
      if (!pr) continue; // couldn't refresh this run — leave open, retry later

      if (pr.state === 'MERGED') {
        resolutions.push({ id: c.id, status: 'done', note: 'PR merged' });
      } else if (pr.state === 'CLOSED') {
        resolutions.push({ id: c.id, status: 'dismissed', note: 'PR closed without merging' });
      } else if (!unaddressedState(pr, viewer).unaddressed) {
        resolutions.push({ id: c.id, status: 'done', note: 'Addressed: pushed after the last outside review/comment' });
      }
    }
    return resolutions;
  },
};
