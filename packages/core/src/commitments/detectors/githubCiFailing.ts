import type { CommitmentCandidate, Detector, Resolution } from '../types.js';
import { myPrByUrl, myPrsAcrossActiveRepos, toUnix, type RepoPr } from './myPrs.js';

const FAILING_CONCLUSIONS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE']);

/**
 * `statusCheckRollup` doesn't distinguish required from optional checks — that needs a
 * separate branch-protection call per repo (`gh api repos/{o}/{r}/branches/{b}/protection`),
 * which this skips to keep this detector at one `gh pr list` call per repo. Assumption: any
 * completed check reporting failure is worth surfacing. If a repo has noisy optional checks
 * that fail routinely, this will over-fire for it — tighten with the protection call later if
 * that turns out to matter in practice.
 */
function failingChecks(pr: RepoPr): string[] {
  return pr.statusCheckRollup
    .filter((c) => c.status === 'COMPLETED' && c.conclusion && FAILING_CONCLUSIONS.has(c.conclusion))
    .map((c) => c.name);
}

export const githubCiFailing: Detector = {
  id: 'github_ci_failing',
  sources: ['github_ci_failing'],

  async detect(ctx) {
    const candidates: CommitmentCandidate[] = [];
    for (const pr of myPrsAcrossActiveRepos(ctx)) {
      if (pr.state !== 'OPEN') continue;
      const failing = failingChecks(pr);
      if (failing.length === 0) continue;

      candidates.push({
        source: 'github_ci_failing',
        source_ref: pr.url,
        title: `CI failing: ${pr.title}`,
        detail: `Failing: ${failing.join(', ')} — repo: ${pr.nwo}`,
        confidence: 0.9,
        last_activity_at: toUnix(pr.updatedAt),
      });
    }
    return candidates;
  },

  async reconcile(open) {
    const resolutions: Resolution[] = [];
    for (const c of open) {
      const pr = myPrByUrl(c.source_ref);
      if (!pr) continue; // couldn't refresh this run — leave open, retry later

      if (pr.state === 'MERGED') {
        resolutions.push({ id: c.id, status: 'done', note: 'PR merged' });
      } else if (pr.state === 'CLOSED') {
        resolutions.push({ id: c.id, status: 'dismissed', note: 'PR closed without merging' });
      } else if (failingChecks(pr).length === 0) {
        resolutions.push({ id: c.id, status: 'done', note: 'CI passing now' });
      }
    }
    return resolutions;
  },
};
