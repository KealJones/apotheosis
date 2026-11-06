import { getMyPrsForRepo, parsePrUrl, type GhPrRow } from '../../integrations/github.js';
import type { DetectorContext } from '../types.js';
import { discoverLocalRepos } from './repoDiscovery.js';

/**
 * How far back to look for repos you've actually worked in, when deciding which repos the
 * github_unaddressed/github_stale/github_ci_failing/git_local detectors scan. Wider than
 * `ctx.since` (the 7-day event lookback) on purpose: these are state-style detectors — a repo
 * you touched three weeks ago and have an open PR in in is still worth checking.
 */
export const REPO_DISCOVERY_LOOKBACK_SECONDS = 30 * 86_400;

export interface RepoPr extends GhPrRow {
  nwo: string;
}

/** Your own PRs (open + recently closed/merged) across every repo you've recently worked in. */
export function myPrsAcrossActiveRepos(ctx: DetectorContext): RepoPr[] {
  const repos = discoverLocalRepos(ctx.db, ctx.now - REPO_DISCOVERY_LOOKBACK_SECONDS);
  const out: RepoPr[] = [];
  for (const repo of repos) {
    if (!repo.nwo) continue;
    try {
      for (const pr of getMyPrsForRepo(repo.nwo)) out.push({ ...pr, nwo: repo.nwo });
    } catch {
      // gh error for this one repo (no access, deleted, rate-limited) — skip it, others still work
    }
  }
  return out;
}

/**
 * One PR by URL, independent of repo discovery. reconcile() uses this instead of
 * `myPrsAcrossActiveRepos` because a commitment must still be resolvable after you've moved
 * on from a repo (stopped touching its files locally) and it drops out of discovery.
 */
export function myPrByUrl(url: string): RepoPr | null {
  const parsed = parsePrUrl(url);
  if (!parsed) return null;
  try {
    const pr = getMyPrsForRepo(parsed.nwo).find((p) => p.number === parsed.number);
    return pr ? { ...pr, nwo: parsed.nwo } : null;
  } catch {
    return null;
  }
}

export function toUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/** Feedback from someone other than you, with a timestamp. */
function outsideFeedback(pr: RepoPr, viewer: string | null): { login: string; at: number }[] {
  return [
    ...pr.reviews.map((r) => ({ login: r.author?.login ?? '', at: toUnix(r.submittedAt) })),
    ...pr.comments.map((c) => ({ login: c.author?.login ?? '', at: toUnix(c.createdAt) })),
  ].filter((f) => f.login && f.login !== viewer);
}

/**
 * "Addressed" has no dedicated GitHub signal, so this treats your next push as the addressing
 * action: feedback from someone else dated after your last commit counts as unaddressed.
 * `reviewDecision === CHANGES_REQUESTED` is a stronger, always-current signal and counts
 * regardless of timing.
 */
export function unaddressedState(pr: RepoPr, viewer: string | null): { unaddressed: boolean; lastPush: number; newestOutside: number } {
  const lastPush = pr.commits.length ? Math.max(...pr.commits.map((c) => toUnix(c.committedDate))) : toUnix(pr.createdAt);
  const feedback = outsideFeedback(pr, viewer);
  const newestOutside = feedback.reduce((max, f) => Math.max(max, f.at), 0);
  const unaddressed = pr.reviewDecision === 'CHANGES_REQUESTED' || newestOutside > lastPush;
  return { unaddressed, lastPush, newestOutside };
}
