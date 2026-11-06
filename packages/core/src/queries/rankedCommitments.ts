import { getDb, type Db } from '../db.js';
import type { Commitment, CommitmentSource } from '../commitments/types.js';

const DAY = 86_400;
const HOUR = 3_600;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ── Ranking ──────────────────────────────────────────────────────────────
//
// Four inputs, combined into one weighted sum. None of this is "the" right answer —
// it's a product judgment call, documented here so it's cheap to retune once real
// dismissal data (see NOT_A_THING_TAG below) says a weight is off.
//
//   source weight (35%)  — is a human actually blocked on you, or is this a note to
//                          yourself? See SOURCE_WEIGHTS below for the per-source call.
//   age (25%)            — older = more overdue, but with diminishing returns (sqrt,
//                          not linear): the jump from "1 day old" to "3 days old" should
//                          matter more than "20 days old" to "22 days old". Reaches its
//                          max at AGE_SATURATION_DAYS and is flat after that — an item
//                          that's been open two months isn't "more overdue" than one
//                          open two weeks in any way that should keep pushing it up;
//                          that's what auto-expiry is for, not ranking.
//   due proximity (20%)  — a due_hint that parses to "soon" (or already past) boosts the
//                          score; no hint, or one that fails to parse, contributes 0
//                          (never a penalty — most items never had a hint captured).
//   confidence (20%)     — the detector's own 0..1 confidence, taken as-is.
//
// Weights sum to 1, so the resulting score is always in [0, 1].
export const SCORE_WEIGHTS = {
  source: 0.35,
  age: 0.25,
  due: 0.20,
  confidence: 0.20,
} as const;

/** Age score hits its ceiling (1.0) at this many days open; sqrt-shaped before that. */
export const AGE_SATURATION_DAYS = 14;

/** A due date this far out (or closer) starts contributing to the due-proximity score. */
export const DUE_HORIZON_HOURS = 7 * 24;

/**
 * Base weight per source: roughly "how likely is it a specific other human is waiting
 * on you, versus this being a note you left yourself." Intentionally coarse-grained —
 * the point isn't to model every nuance, it's to make sure "someone's blocked on me"
 * categorically outranks "stale draft only I care about" even when the stale draft is
 * older. Tune these once `resolution_note` tagging (NOT_A_THING_TAG) shows a source is
 * consistently over- or under-ranked.
 */
export const SOURCE_WEIGHTS: Record<CommitmentSource, number> = {
  // A reviewer is explicitly named on this PR — the clearest "blocked on you" signal there is.
  github_review_requested: 1.00,
  // Someone directly asked you something.
  slack_ask: 0.95,
  // You already got feedback and haven't responded — the other person is mid-conversation, waiting.
  github_unaddressed: 0.90,
  // You explicitly said you'd do this — an outbound promise, not an inference.
  slack_promise: 0.85,
  // You're inferred to owe a reply, but it's a classifier's read on directedness, not your own words.
  slack_unanswered: 0.75,
  // Someone mentioned you; may or may not need action.
  mention: 0.65,
  // Self-attested in your own words (carried over from a prior standup), but still self-directed.
  standup: 0.60,
  // Assigned to you in a meeting — real human context, but async and sometimes soft.
  meeting: 0.55,
  // A manual entry has no detector confidence signal to lean on either way; treat as neutral.
  manual: 0.50,
  // Your own PR's CI is red — self-interest to fix, not something another person is blocked on.
  github_ci_failing: 0.50,
  // Your own PR going quiet — mostly a note to self ("should probably merge this").
  github_stale: 0.35,
  // An unpushed or PR-less local branch — the least "someone else is waiting" of the bunch.
  git_local: 0.30,
  // Explicitly the lowest-confidence, self-directed bucket (see idea.ts) — barely above zero.
  idea: 0.15,
};

/**
 * Confidence floor for the main ranked list. Below this, an item goes into the "maybe?"
 * tray instead — it never pollutes the top-7 or the full list, no matter how old or how
 * "someone's waiting" its source weight implies.
 *
 * Picked at 0.4, just above idea.ts's documented 0.3 ("potential ideas, not confirmed
 * commitments") so ideas always land in the tray, but at or below git_local's 0.4
 * "pushed_no_pr" signal, which — despite the uncertainty about whether a PR already
 * exists — comes from real repo state (a pushed, diverged, quiet branch), not a guess,
 * so it stays eligible for the main list.
 */
export const MAYBE_CONFIDENCE_THRESHOLD = 0.4;

/** Row count for the default "top" view. */
export const TOP_CAP = 7;

function dueProximityScore(dueHint: string | null, now: number): number {
  const dueAt = parseDueHint(dueHint, now);
  if (dueAt == null) return 0;
  const hoursUntilDue = (dueAt - now) / HOUR;
  // Overdue (negative hoursUntilDue) clamps at the max boost; anything beyond the
  // horizon contributes nothing.
  return clamp(1 - hoursUntilDue / DUE_HORIZON_HOURS, 0, 1);
}

/** The single sort score for one commitment. Always in [0, 1]. See SCORE_WEIGHTS above. */
export function scoreCommitment(c: Pick<Commitment, 'source' | 'confidence' | 'detected_at' | 'due_hint'>, now: number): number {
  const sourceWeight = SOURCE_WEIGHTS[c.source] ?? 0.5;
  const ageDays = Math.max(0, (now - c.detected_at) / DAY);
  const ageScore = clamp(Math.sqrt(ageDays / AGE_SATURATION_DAYS), 0, 1);
  const dueScore = dueProximityScore(c.due_hint, now);
  const confidence = clamp(c.confidence, 0, 1);

  return (
    SCORE_WEIGHTS.source * sourceWeight +
    SCORE_WEIGHTS.age * ageScore +
    SCORE_WEIGHTS.due * dueScore +
    SCORE_WEIGHTS.confidence * confidence
  );
}

export interface RankedCommitment extends Commitment {
  score: number;
}

export interface RankedCommitmentsResult {
  /** Confidence >= MAYBE_CONFIDENCE_THRESHOLD, sorted by score descending, capped at TOP_CAP
   * unless `all` was requested. */
  ranked: RankedCommitment[];
  /** Confidence < MAYBE_CONFIDENCE_THRESHOLD. Never capped; the tray is meant to be browsed, not ranked. */
  maybe: RankedCommitment[];
  /** Count of open/snoozed commitments across both buckets, before any cap. */
  total_open: number;
}

export interface GetRankedCommitmentsOptions {
  /** Unix seconds. Defaults to the wall clock. */
  now?: number;
  /** "show all" mode: skip the TOP_CAP cap on `ranked`. */
  all?: boolean;
}

/** Ranks every open/snoozed commitment. See module doc comment for the scoring formula. */
export function getRankedCommitments(opts: GetRankedCommitmentsOptions = {}): RankedCommitmentsResult {
  const db = getDb();
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  const rows = db.prepare(`
    SELECT * FROM commitments WHERE status IN ('open', 'snoozed')
  `).all() as Commitment[];

  const scored: RankedCommitment[] = rows.map((c) => ({ ...c, score: scoreCommitment(c, now) }));
  const byScoreDesc = (a: RankedCommitment, b: RankedCommitment) => b.score - a.score || a.id - b.id;

  const main = scored.filter((c) => c.confidence >= MAYBE_CONFIDENCE_THRESHOLD).sort(byScoreDesc);
  const maybe = scored.filter((c) => c.confidence < MAYBE_CONFIDENCE_THRESHOLD).sort(byScoreDesc);

  return {
    ranked: opts.all ? main : main.slice(0, TOP_CAP),
    maybe,
    total_open: rows.length,
  };
}

// ── due_hint / snooze-target parsing ────────────────────────────────────────
//
// due_hint is free text an LLM classifier lifted from a message ("tomorrow", "by
// Friday", "after lunch", "EOD", "before standup" — see slackClassify.ts's prompts).
// This is a best-effort heuristic parser, not real NLP date parsing: it recognizes the
// common phrases the classifiers actually emit plus bare weekday/"next weekday" names,
// and falls back to `Date.parse` for anything already looking like a real date. All
// arithmetic is UTC-day-based, so "today"/"tomorrow" etc. are approximate to within a
// timezone's worth of hours — acceptable for a ranking boost, not for a calendar
// invite. Returns null (no boost, not a penalty) when nothing matches.
export function parseDueHint(hint: string | null | undefined, now: number): number | null {
  if (!hint) return null;
  const h = hint.trim().toLowerCase();
  if (!h) return null;

  const base = new Date(now * 1000);
  const atUtcHour = (daysFromNow: number, hour: number): number =>
    Math.floor(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + daysFromNow, hour, 0, 0) / 1000);

  if (/\b(asap|immediately|right away)\b/.test(h)) return now;
  if (/\b(eod|end of day)\b/.test(h)) return atUtcHour(0, 23);
  if (/\bafter lunch\b/.test(h)) return atUtcHour(0, 13);
  if (/\bbefore standup\b/.test(h)) return atUtcHour(1, 9);
  if (/\btoday\b/.test(h)) return atUtcHour(0, 17);
  if (/\btomorrow\b/.test(h)) return atUtcHour(1, 12);
  if (/\bthis week\b/.test(h)) return nextWeekdayTimestamp(now, 5, false); // Friday, this week
  if (/\bnext week\b/.test(h)) return atUtcHour(7, 12);

  const weekdayMatch = h.match(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (weekdayMatch) {
    const isNext = Boolean(weekdayMatch[1]);
    const targetDow = WEEKDAYS.indexOf(weekdayMatch[2] as (typeof WEEKDAYS)[number]);
    return nextWeekdayTimestamp(now, targetDow, isNext);
  }

  // Fallback: an explicit date the classifier or a user already spelled out ("Oct 3", "2026-10-03").
  const parsed = Date.parse(hint);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

/**
 * Next occurrence of `targetDow` (0=Sunday..6=Saturday) strictly after today, at noon UTC.
 * `skipOneMore` (the "next Monday" vs bare "Monday" distinction) pushes it out one more
 * week — the usual meaning of "next" when the target day hasn't happened yet this week.
 */
function nextWeekdayTimestamp(now: number, targetDow: number, skipOneMore: boolean): number {
  const base = new Date(now * 1000);
  const currentDow = base.getUTCDay();
  let diff = (targetDow - currentDow + 7) % 7;
  if (diff === 0) diff = 7; // "today" doesn't count; the next occurrence is a week out
  if (skipOneMore) diff += 7;
  return Math.floor(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + diff, 12, 0, 0) / 1000);
}

// ── Row actions ──────────────────────────────────────────────────────────
//
// Data/mutation layer only — no UI here. Each function loads and returns the row it
// touched so a caller (or a test) can verify the mutation without a second query.

export interface MutationResult {
  ok: boolean;
  commitment?: Commitment;
  error?: string;
}

function loadCommitment(db: Db, id: number): Commitment | undefined {
  return db.prepare('SELECT * FROM commitments WHERE id = ?').get(id) as Commitment | undefined;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Marks a commitment done. User-initiated, so resolved_by is always 'user'. */
export function markCommitmentDone(id: number, note?: string, now: number = nowSeconds()): MutationResult {
  const db = getDb();
  if (!loadCommitment(db, id)) return { ok: false, error: `Commitment #${id} not found` };

  db.prepare(`
    UPDATE commitments
    SET status = 'done', resolved_at = ?, resolved_by = 'user', resolution_note = ?, snoozed_until = NULL
    WHERE id = ?
  `).run(now, note?.trim() || 'Marked done', id);

  return { ok: true, commitment: loadCommitment(db, id) };
}

/**
 * Snoozes until `until` — either a unix-seconds timestamp, or free text parsed with the
 * same `parseDueHint` heuristics used for due-date ranking ("next Monday" works here for
 * the same reason it works as a due hint). Doesn't touch resolved_at/resolved_by: a
 * snooze isn't a resolution, and `runDetectors()`'s `wakeSnoozed()` reopens it on its own.
 */
export function snoozeCommitment(id: number, until: number | string, now: number = nowSeconds()): MutationResult {
  const db = getDb();
  if (!loadCommitment(db, id)) return { ok: false, error: `Commitment #${id} not found` };

  const untilTs = typeof until === 'number' ? until : parseDueHint(until, now);
  if (untilTs == null) return { ok: false, error: `Could not parse snooze target "${until}"` };
  if (untilTs <= now) return { ok: false, error: 'Snooze target must be in the future' };

  db.prepare(`UPDATE commitments SET status = 'snoozed', snoozed_until = ? WHERE id = ?`).run(untilTs, id);
  return { ok: true, commitment: loadCommitment(db, id) };
}

/**
 * Tags a resolution_note with this prefix instead of inventing a new column. Chosen over a
 * schema change because: (1) it's backward-compatible with every existing row and query,
 * (2) `resolution_note` is already exactly "why this was resolved", which is what this is,
 * and (3) it's trivially machine-parseable (`isNotAThing()` below, or
 * `resolution_note LIKE 'not_a_thing%'` in SQL) for a future tuning pass that counts, per
 * source, how often users say "not a thing" — which is the actual signal the plan wants
 * eventually feeding back into SOURCE_WEIGHTS. If that aggregate ever needs richer
 * structure (a reason code, a "why" enum) it can graduate to a real column then; nothing
 * about this scheme forecloses that.
 */
export const NOT_A_THING_TAG = 'not_a_thing';

/** Dismisses a commitment as "not actually a thing" — recorded as a tunable signal, not a generic dismiss. */
export function markCommitmentNotAThing(id: number, note?: string, now: number = nowSeconds()): MutationResult {
  const db = getDb();
  if (!loadCommitment(db, id)) return { ok: false, error: `Commitment #${id} not found` };

  const resolutionNote = note?.trim() ? `${NOT_A_THING_TAG}: ${note.trim()}` : NOT_A_THING_TAG;
  db.prepare(`
    UPDATE commitments
    SET status = 'dismissed', resolved_at = ?, resolved_by = 'user', resolution_note = ?, snoozed_until = NULL
    WHERE id = ?
  `).run(now, resolutionNote, id);

  return { ok: true, commitment: loadCommitment(db, id) };
}

export function isNotAThing(c: Pick<Commitment, 'resolution_note'>): boolean {
  return c.resolution_note?.startsWith(NOT_A_THING_TAG) ?? false;
}

/**
 * Generic dismiss: dropped without being done, but — unlike {@link markCommitmentNotAThing} —
 * without the NOT_A_THING_TAG marker. This is the distinction `todo_resolve` exposes: "not a
 * thing" means the item should never have been detected at all (tunable detector-precision
 * signal); a plain dismiss just means "not doing this, but the detection was fair." Note is
 * required here (unlike the other two mutators' optional note-with-fallback) because
 * `todo_resolve`'s whole contract is "always say why".
 */
export function markCommitmentDismissed(id: number, note: string, now: number = nowSeconds()): MutationResult {
  const db = getDb();
  if (!loadCommitment(db, id)) return { ok: false, error: `Commitment #${id} not found` };
  if (!note?.trim()) return { ok: false, error: 'note is required' };

  db.prepare(`
    UPDATE commitments
    SET status = 'dismissed', resolved_at = ?, resolved_by = 'user', resolution_note = ?, snoozed_until = NULL
    WHERE id = ?
  `).run(now, note.trim(), id);

  return { ok: true, commitment: loadCommitment(db, id) };
}

// ── "Open source" resolution ────────────────────────────────────────────
//
// Not a mutation: resolves a commitment to the URL/reference a UI should link to,
// per the actual source_ref/detail shape each detector writes (see each detector file
// for the format). Web-addressable sources (GitHub PRs, Slack permalinks, meeting
// recording URLs) resolve to a real https URL. Purely-internal sources (standups,
// ideas) resolve to a synthetic `apotheosis://` deep link rather than null, so the UI
// has one consistent "is there something to open" check instead of two special cases;
// git_local resolves to the repo's `file://` path (the branch itself isn't independently
// addressable). Truly unresolvable refs (manual entries, an unclaimed 'mention' source)
// fall back to source_ref itself if it already looks like a URL, else null.
const ROUND_SUFFIX = /#round=\d+$/;

export function resolveCommitmentSource(c: Pick<Commitment, 'source' | 'source_ref'>): string | null {
  const db = getDb();

  switch (c.source) {
    case 'github_review_requested':
      // source_ref is `<pr-url>#round=N` (see githubReviewRequested.ts) — strip the round suffix.
      return c.source_ref.replace(ROUND_SUFFIX, '');

    case 'github_unaddressed':
    case 'github_stale':
    case 'github_ci_failing':
      // These three detectors write the PR url as source_ref directly.
      return c.source_ref;

    case 'slack_ask':
    case 'slack_promise':
    case 'slack_unanswered': {
      // source_ref is the message's dedupe_hash; the permalink lives on the row it came from.
      const row = db.prepare('SELECT permalink FROM slack_messages WHERE dedupe_hash = ?')
        .get(c.source_ref) as { permalink: string | null } | undefined;
      return row?.permalink ?? null;
    }

    case 'meeting': {
      // source_ref is `meeting:<id>:<hash>` (see meeting.ts).
      const m = c.source_ref.match(/^meeting:(\d+):/);
      if (!m) return null;
      const row = db.prepare('SELECT url FROM meetings WHERE id = ?').get(Number(m[1])) as { url: string | null } | undefined;
      return row?.url ?? null;
    }

    case 'standup': {
      // source_ref is `standup:<id>#(today|blockers)#<position>` (see standupCarryover.ts).
      const m = c.source_ref.match(/^standup:(\d+)#/);
      if (!m) return null;
      const row = db.prepare('SELECT date FROM standups WHERE id = ?').get(Number(m[1])) as { date: string } | undefined;
      return row ? `apotheosis://standup/${row.date}` : null;
    }

    case 'idea': {
      // source_ref is `idea:<id>` (see idea.ts) — no web resource, just the row itself.
      const m = c.source_ref.match(/^idea:(\d+)$/);
      return m ? `apotheosis://idea/${m[1]}` : null;
    }

    case 'git_local': {
      // source_ref is `local:<repo-root>#<branch>` (see gitLocal.ts).
      const m = c.source_ref.match(/^local:(.+)#([^#]+)$/);
      return m ? `file://${m[1]}` : null;
    }

    case 'mention':
    case 'manual':
    default:
      return c.source_ref.startsWith('http') ? c.source_ref : null;
  }
}
