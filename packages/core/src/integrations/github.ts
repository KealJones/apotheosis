import { execSync } from 'child_process';

export interface PrItem {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  /** "owner/repo", when gh returns a repository object for this query. */
  repo?: string;
}

export interface GhReview {
  author: { login: string } | null;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  submittedAt: string;
}

export interface GhComment {
  author: { login: string } | null;
  createdAt: string;
}

export interface GhCommit {
  oid: string;
  committedDate: string;
  authoredDate: string;
}

export interface GhCheck {
  name: string;
  status: string; // COMPLETED | IN_PROGRESS | QUEUED | ...
  conclusion: string | null; // SUCCESS | FAILURE | CANCELLED | SKIPPED | ... | null while running
  workflowName?: string;
}

/** One row of `gh pr list --state all --json ...` for a single repo, author=@me. */
export interface GhPrRow {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  reviewDecision: string; // '' | APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED
  mergeable: string; // MERGEABLE | CONFLICTING | UNKNOWN
  headRefName: string;
  reviews: GhReview[];
  comments: GhComment[];
  commits: GhCommit[];
  statusCheckRollup: GhCheck[];
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * TTL cache for `gh` subprocess calls, keyed by the exact command. Every detector's
 * detect()+reconcile() (and the pending_reviews/standup/inbox tools) share this cache, so a
 * Today-page render that touches several of these in the same few minutes costs at most one
 * subprocess per distinct query, not one per caller. 5 minutes balances "fresh enough for a
 * commitment tracker" against "don't shell out to gh on every render". No pattern for this
 * already existed in the codebase (usage_stats etc. all read straight from sqlite), so this
 * is a small bespoke Map — swap for something fancier only if a second consumer needs it.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry<unknown>>();

/** @internal test-only: force the next call for `key` to miss the cache. */
export function _clearGithubCache(): void {
  cache.clear();
}

function cachedExec<T>(key: string, cmd: string, parse: (out: string) => T, ttlMs = CACHE_TTL_MS): T {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const output = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
  const parsed = parse(output);
  cache.set(key, { value: parsed, expiresAt: Date.now() + ttlMs });
  return parsed;
}

function cachedJson<T>(key: string, cmd: string): T {
  return cachedExec(key, cmd, (out) => JSON.parse(out) as T);
}

/**
 * Your own GitHub login. Used to tell "someone else reviewed/commented" apart from your own
 * activity on a PR. Doesn't change during a session, so it gets an hour-long TTL instead of
 * the usual 5 minutes.
 */
export function getViewerLogin(): string | null {
  try {
    return cachedExec('viewer-login', 'gh api user --jq .login', (out) => out.trim() || null, 60 * 60 * 1000);
  } catch {
    return null;
  }
}

/**
 * PRs where your review is currently requested and still outstanding, across every repo you
 * have access to.
 *
 * Previously this ran `gh pr list --assignee @me --state open`, which is wrong on two counts:
 * it returns PRs *assigned* to you (mostly your own), not ones awaiting your review, and
 * `gh pr list` without `--repo` is scoped to whatever repo the current working directory
 * happens to be in — for a personal, multi-repo tool that silently made it useless outside
 * one checkout. `gh search prs --review-requested=@me` is cross-repo and matches GitHub's own
 * "review requested" qualifier: it already drops a PR the moment you submit any review
 * (approve/request-changes/comment) and only reappears if changes are pushed and your review
 * is re-requested — so this single query is already "awaiting your review", no follow-up call
 * needed to check review state.
 */
export function getPendingReviews(): PrItem[] {
  try {
    const rows = cachedJson<Array<{ number: number; title: string; url: string; updatedAt: string; repository?: { nameWithOwner: string } }>>(
      'review-requested',
      'gh search prs --review-requested=@me --state=open --json number,title,url,updatedAt,repository --limit 50',
    );
    return rows.map((r) => ({
      number: r.number,
      title: r.title,
      url: r.url,
      updatedAt: r.updatedAt,
      repo: r.repository?.nameWithOwner,
    }));
  } catch {
    // gh not available or not authenticated — return empty gracefully
    return [];
  }
}

/**
 * Lightweight current state for one PR (used by github_review_requested's reconcile() to
 * find out *why* a previously-outstanding review request disappeared: your review landed, or
 * the PR closed/merged out from under it). Only called for commitments that actually fell out
 * of `getPendingReviews()` this run — bounded by how many requests resolved, not by how many
 * are open — so it doesn't turn into "one gh call per open commitment on every render".
 */
export function getPrState(url: string): { state: 'OPEN' | 'CLOSED' | 'MERGED'; reviews: GhReview[] } | null {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url)) return null;
  try {
    return cachedJson(`pr-state:${url}`, `gh pr view ${shellQuote(url)} --json state,reviews`);
  } catch {
    return null;
  }
}

/**
 * Your own open-or-recently-closed PRs in one repo, one call, everything the
 * github_unaddressed/github_stale/github_ci_failing detectors need: `state=all` (not just
 * `open`) so the same cached response serves both detect() (filter to OPEN) and reconcile()
 * (a ref no longer OPEN here means merged/closed) without a second query.
 */
export function getMyPrsForRepo(nwo: string): GhPrRow[] {
  if (!/^[\w.-]+\/[\w.-]+$/.test(nwo)) throw new Error(`Not an "owner/repo": ${nwo}`);
  return cachedJson<GhPrRow[]>(
    `my-prs:${nwo}`,
    `gh pr list --repo ${shellQuote(nwo)} --author @me --state all --limit 50 ` +
      '--json number,title,url,state,isDraft,createdAt,updatedAt,closedAt,mergedAt,reviewDecision,mergeable,headRefName,reviews,comments,commits,statusCheckRollup',
  );
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Pulls "owner/repo" and the PR number out of a `https://github.com/owner/repo/pull/N` URL. */
export function parsePrUrl(url: string): { nwo: string; number: number } | null {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  return m ? { nwo: m[1], number: Number(m[2]) } : null;
}
