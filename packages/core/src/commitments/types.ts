import type { SQLInputValue } from 'node:sqlite';

/** Every value `commitments.source` may hold. Each detector owns a disjoint subset. */
export const COMMITMENT_SOURCES = [
  'standup',
  'slack_ask',
  'slack_promise',
  'slack_unanswered',
  'github_review_requested',
  'github_unaddressed',
  'github_stale',
  'github_ci_failing',
  'meeting',
  'idea',
  'mention',
  'git_local',
  'manual',
] as const;
export type CommitmentSource = (typeof COMMITMENT_SOURCES)[number];

export type CommitmentStatus = 'open' | 'snoozed' | 'done' | 'dismissed';

/** A row of the `commitments` table. Timestamps are unix seconds. */
export interface Commitment {
  id: number;
  detected_at: number;
  committed_at: number | null;
  source: CommitmentSource;
  source_ref: string;
  title: string;
  detail: string | null;
  counterparty: string | null;
  due_hint: string | null;
  confidence: number;
  status: CommitmentStatus;
  snoozed_until: number | null;
  resolved_at: number | null;
  resolved_by: 'auto' | 'user' | null;
  resolution_note: string | null;
  last_activity_at: number | null;
}

/** What `detect()` returns. The runner turns these into rows. */
export interface CommitmentCandidate {
  /** Must be one of the detector's own `sources`. */
  source: CommitmentSource;
  /**
   * Stable identity of this commitment *instance*. Re-detecting the same ref updates the
   * existing row; it never reopens a done/dismissed one. If a thing can legitimately recur
   * (review re-requested after you reviewed), encode the round in the ref.
   */
  source_ref: string;
  title: string;
  detail?: string;
  counterparty?: string;
  committed_at?: number;
  due_hint?: string;
  /** 0..1 */
  confidence: number;
  /**
   * Unix seconds of the most recent real-world evidence this is still live (PR updated,
   * thread reply, message sent). Defaults to `ctx.now`, i.e. "seen again this run counts
   * as activity". Supply it when re-detection alone isn't evidence (e.g. re-scanning an
   * old message), or the item can never auto-expire.
   */
  last_activity_at?: number;
}

/** What `reconcile()` returns: a proposed terminal status for one open commitment. */
export interface Resolution {
  id: number;
  /**
   * `done`: the world shows it was satisfied (PR merged, reply sent).
   * `dismissed`: moot but not satisfied by you (PR closed by someone else, request withdrawn).
   */
  status: 'done' | 'dismissed';
  /** Why, in one line. Stored as resolution_note. Required. */
  note: string;
}

/** Read-only view of the DB handed to detectors. Only SELECT/WITH statements are allowed. */
export interface ReadonlyDb {
  prepare(sql: string): {
    all(...params: SQLInputValue[]): unknown[];
    get(...params: SQLInputValue[]): unknown;
  };
}

/**
 * Persistent memo for expensive, deterministic-enough work a detector would otherwise redo
 * every run (LLM classifications). The runner owns the storage (`detector_cache`), so this is
 * the one sanctioned write path out of `detect()`. Keys are global across detectors, so two
 * detectors can share an entry on purpose; namespace and version them yourself
 * (`slack:inbound:v3:<model>:<hash>`) so a prompt change invalidates old answers. Entries
 * untouched for CACHE_TTL_SECONDS are pruned at the start of a run.
 */
export interface DetectorCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface DetectorContext {
  /** Unix seconds. One clock for the whole run; use it instead of Date.now(). */
  now: number;
  /** Unix seconds. Suggested scan window start for event-style sources. State-style detectors may ignore it. */
  since: number;
  db: ReadonlyDb;
  cache: DetectorCache;
}

export interface Detector {
  /** Unique across the registry. */
  id: string;
  /** Sources this detector owns. It may only emit, and is only asked to reconcile, these. */
  sources: readonly CommitmentSource[];
  /** Find candidates. Pure: no writes. */
  detect(ctx: DetectorContext): Promise<CommitmentCandidate[]>;
  /**
   * Given this detector's open/snoozed commitments, propose which are now resolved.
   * Absence from `detect()` output never closes anything; only an explicit Resolution does.
   */
  reconcile(open: Commitment[], ctx: DetectorContext): Promise<Resolution[]>;
}
