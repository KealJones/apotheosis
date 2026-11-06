import * as fs from 'fs';
import type { CommitmentCandidate, Detector, Resolution } from '../types.js';
import { REPO_DISCOVERY_LOOKBACK_SECONDS } from './myPrs.js';
import { discoverLocalRepos, tryGit } from './repoDiscovery.js';

const DAY = 86_400;
/**
 * A pushed branch that's diverged from the default branch and gone quiet this long is treated
 * as a (lower-confidence) "probably needs a PR" signal. This detector deliberately never
 * shells out to `gh` — it's the one signal in this set that still works if `gh` is missing or
 * unauthenticated — so it can't actually confirm a PR does or doesn't exist; it approximates
 * "no PR" with "pushed, ahead of default, quiet". A real PR that's simply idle for 3 days
 * will also match this and separately get picked up by github_stale once gh reconciles it, so
 * the two detectors' overlap here is intentional, not a bug.
 */
const PUSHED_NO_PR_STALE_DAYS = 3;

interface BranchInfo {
  name: string;
  upstream: string;
  unpushedCount: number;
  aheadOfBase: number;
  lastCommitAt: number;
}

interface BranchSignal {
  kind: 'unpushed' | 'pushed_no_pr';
  detail: string;
  confidence: number;
}

function defaultBranch(root: string): string | null {
  const symbolic = tryGit(root, 'symbolic-ref --short refs/remotes/origin/HEAD');
  if (symbolic) return symbolic.replace(/^origin\//, '');
  for (const candidate of ['main', 'master']) {
    if (tryGit(root, `show-ref --verify --quiet refs/remotes/origin/${candidate}`) !== null) return candidate;
  }
  return null;
}

function listBranches(root: string, base: string | null): BranchInfo[] {
  const raw = tryGit(root, "for-each-ref refs/heads --format='%(refname:short)|%(upstream:short)|%(committerdate:unix)'");
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => {
    const [name, upstream, committerdate] = line.split('|');
    const unpushedCount = Number(
      tryGit(root, upstream ? `rev-list --count ${upstream}..${name}` : `rev-list --count ${name} --not --remotes`) ?? '0',
    );
    const aheadOfBase = base && name !== base ? Number(tryGit(root, `rev-list --count ${base}..${name}`) ?? '0') : 0;
    return { name, upstream, unpushedCount, aheadOfBase, lastCommitAt: Number(committerdate) };
  });
}

function branchSignal(b: BranchInfo, now: number): BranchSignal | null {
  if (b.unpushedCount > 0) {
    return { kind: 'unpushed', detail: `${b.unpushedCount} commit(s) not on ${b.upstream || 'any remote'}`, confidence: 0.7 };
  }
  if (b.upstream && b.aheadOfBase > 0 && now - b.lastCommitAt > PUSHED_NO_PR_STALE_DAYS * DAY) {
    return {
      kind: 'pushed_no_pr',
      detail: `Pushed, ${b.aheadOfBase} commit(s) ahead of default branch, quiet ${PUSHED_NO_PR_STALE_DAYS}+ days (can't confirm a PR without gh)`,
      confidence: 0.4,
    };
  }
  return null;
}

/**
 * A local branch with unpushed commits, or (best-effort) a pushed branch that looks like it
 * never got a PR. The only detector here with zero `gh` calls — see PUSHED_NO_PR_STALE_DAYS
 * doc above for what that costs in precision.
 */
export const gitLocal: Detector = {
  id: 'git_local',
  sources: ['git_local'],

  async detect(ctx) {
    const candidates: CommitmentCandidate[] = [];
    for (const repo of discoverLocalRepos(ctx.db, ctx.now - REPO_DISCOVERY_LOOKBACK_SECONDS)) {
      const base = defaultBranch(repo.root);
      for (const b of listBranches(repo.root, base)) {
        const signal = branchSignal(b, ctx.now);
        if (!signal) continue;
        candidates.push({
          source: 'git_local',
          source_ref: `local:${repo.root}#${b.name}`,
          title: signal.kind === 'unpushed' ? `Unpushed commits on ${b.name}` : `Pushed branch may need a PR: ${b.name}`,
          detail: `${signal.detail} — repo: ${repo.nwo ?? repo.root}`,
          confidence: signal.confidence,
          last_activity_at: b.lastCommitAt,
        });
      }
    }
    return candidates;
  },

  async reconcile(open, ctx) {
    const resolutions: Resolution[] = [];
    for (const c of open) {
      const m = c.source_ref.match(/^local:(.+)#([^#]+)$/);
      if (!m) continue;
      const [, root, branchName] = m;
      if (!fs.existsSync(root)) continue; // repo not here anymore — can't verify, leave open

      const exists = tryGit(root, `rev-parse --verify --quiet refs/heads/${branchName}`) !== null;
      if (!exists) {
        resolutions.push({ id: c.id, status: 'done', note: 'Branch no longer exists locally (merged/deleted)' });
        continue;
      }
      const base = defaultBranch(root);
      const info = listBranches(root, base).find((b) => b.name === branchName);
      if (info && !branchSignal(info, ctx.now)) {
        resolutions.push({ id: c.id, status: 'done', note: 'No longer unpushed and no longer looks like it needs a PR' });
      }
    }
    return resolutions;
  },
};
