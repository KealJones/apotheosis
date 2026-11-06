import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import {
  getRankedCommitments,
  scoreCommitment,
  parseDueHint,
  markCommitmentDone,
  snoozeCommitment,
  markCommitmentNotAThing,
  markCommitmentDismissed,
  isNotAThing,
  resolveCommitmentSource,
  MAYBE_CONFIDENCE_THRESHOLD,
  TOP_CAP,
  NOT_A_THING_TAG,
} from '../../src/queries/rankedCommitments.js';
import type { Commitment, CommitmentSource } from '../../src/commitments/types.js';

let db: ReturnType<typeof setupTestDb>;

beforeAll(() => { db = setupTestDb(); });
afterAll(() => { teardownTestDb(); });

// Every test gets a clean slate: seed-test-db.ts ships one pre-seeded 'mention' commitment
// (and other fixture rows) for unrelated suites; this suite owns its own fixtures exclusively.
beforeEach(() => {
  db.exec('DELETE FROM commitments');
  db.exec('DELETE FROM slack_messages');
  db.exec('DELETE FROM meetings');
  db.exec('DELETE FROM standups');
});

let refCounter = 0;

interface CommitmentOverrides {
  source: CommitmentSource;
  source_ref?: string;
  title?: string;
  detail?: string | null;
  due_hint?: string | null;
  confidence: number;
  status?: string;
  detected_at: number;
  last_activity_at?: number | null;
  snoozed_until?: number | null;
  resolved_at?: number | null;
  resolved_by?: string | null;
  resolution_note?: string | null;
}

function insertCommitment(o: CommitmentOverrides): number {
  const source_ref = o.source_ref ?? `ref-${++refCounter}`;
  const result = db.prepare(`
    INSERT INTO commitments
      (detected_at, source, source_ref, title, detail, counterparty, due_hint, confidence,
       status, snoozed_until, resolved_at, resolved_by, resolution_note, last_activity_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    o.detected_at,
    o.source,
    source_ref,
    o.title ?? `Title for ${source_ref}`,
    o.detail ?? null,
    o.due_hint ?? null,
    o.confidence,
    o.status ?? 'open',
    o.snoozed_until ?? null,
    o.resolved_at ?? null,
    o.resolved_by ?? null,
    o.resolution_note ?? null,
    o.last_activity_at ?? o.detected_at,
  );
  return Number(result.lastInsertRowid);
}

function loadRow(id: number): Commitment {
  return db.prepare('SELECT * FROM commitments WHERE id = ?').get(id) as Commitment;
}

const NOW = 1_700_000_000; // arbitrary fixed epoch; due_hint left null in these fixtures so
                           // dueScore is always 0 and doesn't need calendar-relative reasoning

describe('scoreCommitment', () => {
  // Same four-source mix the plan calls out: an explicit promise, a review someone's
  // waiting on, an old low-confidence idea, and a stale PR only the author cares about.
  it('ranks "someone is waiting on you" sources above "note to yourself" sources, with the exact weighted scores', () => {
    const promise = { source: 'slack_promise' as const, confidence: 0.8, detected_at: NOW - 5 * 86_400, due_hint: null };
    const reviewRequested = { source: 'github_review_requested' as const, confidence: 0.95, detected_at: NOW - 2 * 86_400, due_hint: null };
    const staleIdea = { source: 'idea' as const, confidence: 0.3, detected_at: NOW - 40 * 86_400, due_hint: null };
    const stalePr = { source: 'github_stale' as const, confidence: 0.6, detected_at: NOW - 20 * 86_400, due_hint: null };

    // score = 0.35*sourceWeight + 0.25*sqrt(min(1, ageDays/14)) + 0.20*dueScore(=0, no hint) + 0.20*confidence
    expect(scoreCommitment(promise, NOW)).toBeCloseTo(0.60690, 4);
    expect(scoreCommitment(reviewRequested, NOW)).toBeCloseTo(0.63449, 4);
    expect(scoreCommitment(staleIdea, NOW)).toBeCloseTo(0.36250, 4);
    expect(scoreCommitment(stalePr, NOW)).toBeCloseTo(0.49250, 4);

    // The two "a human is blocked on you" items outrank the two "note to self" items,
    // despite the note-to-self items being much older (age is only 25% of the score).
    const scores = {
      reviewRequested: scoreCommitment(reviewRequested, NOW),
      promise: scoreCommitment(promise, NOW),
      stalePr: scoreCommitment(stalePr, NOW),
      staleIdea: scoreCommitment(staleIdea, NOW),
    };
    expect(scores.reviewRequested).toBeGreaterThan(scores.promise);
    expect(scores.promise).toBeGreaterThan(scores.stalePr);
    expect(scores.stalePr).toBeGreaterThan(scores.staleIdea);
  });

  it('boosts an item whose due_hint parses to "soon" over an identical item with none', () => {
    const mondayNoon = Math.floor(Date.UTC(2026, 8, 21, 15, 0, 0) / 1000); // a Monday, 15:00 UTC
    const noDueHint = { source: 'meeting' as const, confidence: 0.7, detected_at: mondayNoon, due_hint: null };
    const dueEod = { source: 'meeting' as const, confidence: 0.7, detected_at: mondayNoon, due_hint: 'EOD' };

    // due 8h out (23:00 same day): dueScore = 1 - 8/168 = 0.952381
    // score = 0.35*0.55 + 0.25*0 (age=0) + 0.20*dueScore + 0.20*0.7
    expect(scoreCommitment(noDueHint, mondayNoon)).toBeCloseTo(0.3325, 4);
    expect(scoreCommitment(dueEod, mondayNoon)).toBeCloseTo(0.522976, 4);
    expect(scoreCommitment(dueEod, mondayNoon)).toBeGreaterThan(scoreCommitment(noDueHint, mondayNoon));
  });
});

describe('getRankedCommitments', () => {
  it('sorts by score, splits low-confidence items into the maybe tray, and reports total_open', () => {
    const reviewId = insertCommitment({ source: 'github_review_requested', confidence: 0.95, detected_at: NOW - 2 * 86_400 });
    const promiseId = insertCommitment({ source: 'slack_promise', confidence: 0.8, detected_at: NOW - 5 * 86_400 });
    const staleId = insertCommitment({ source: 'github_stale', confidence: 0.6, detected_at: NOW - 20 * 86_400 });
    const ideaId = insertCommitment({ source: 'idea', confidence: 0.3, detected_at: NOW - 40 * 86_400 }); // below threshold -> tray

    const result = getRankedCommitments({ now: NOW });

    expect(result.total_open).toBe(4);
    expect(result.ranked.map((c) => c.id)).toEqual([reviewId, promiseId, staleId]);
    expect(result.maybe.map((c) => c.id)).toEqual([ideaId]);

    // The scores attached to the ranked rows match the standalone scoring function.
    expect(result.ranked.find((c) => c.id === reviewId)!.score).toBeCloseTo(0.63449, 4);
    expect(result.maybe[0].confidence).toBeLessThan(MAYBE_CONFIDENCE_THRESHOLD);
  });

  it('includes snoozed (not just open) commitments in the ranking', () => {
    const id = insertCommitment({ source: 'slack_ask', confidence: 0.9, detected_at: NOW - 86_400, status: 'snoozed', snoozed_until: NOW + 86_400 });
    const result = getRankedCommitments({ now: NOW });
    expect(result.ranked.map((c) => c.id)).toContain(id);
  });

  it('excludes done and dismissed commitments entirely', () => {
    insertCommitment({ source: 'slack_ask', confidence: 0.9, detected_at: NOW, status: 'done' });
    insertCommitment({ source: 'slack_ask', confidence: 0.9, detected_at: NOW, status: 'dismissed' });
    const result = getRankedCommitments({ now: NOW });
    expect(result.total_open).toBe(0);
    expect(result.ranked).toEqual([]);
    expect(result.maybe).toEqual([]);
  });

  it('caps the ranked list at TOP_CAP by default, and lifts the cap with all:true', () => {
    // 10 candidates, same source/confidence, distinct ages 1..10 days (all under the 14-day
    // age-saturation point) so age alone gives each one a strictly higher score than the last.
    const ids: number[] = [];
    for (let ageDays = 1; ageDays <= 10; ageDays++) {
      ids.push(insertCommitment({
        source: 'github_review_requested',
        confidence: 0.9,
        detected_at: NOW - ageDays * 86_400,
      }));
    }
    // ids[9] is the oldest (10 days) -> highest score; ids[0] is the newest (1 day) -> lowest.
    const oldestFirst = [...ids].reverse();

    const capped = getRankedCommitments({ now: NOW });
    expect(capped.ranked.length).toBe(TOP_CAP);
    expect(capped.ranked.map((c) => c.id)).toEqual(oldestFirst.slice(0, TOP_CAP));
    expect(capped.total_open).toBe(10);

    const full = getRankedCommitments({ now: NOW, all: true });
    expect(full.ranked.length).toBe(10);
    expect(full.ranked.map((c) => c.id)).toEqual(oldestFirst);
  });
});

describe('parseDueHint', () => {
  const now = Math.floor(Date.UTC(2026, 8, 21, 15, 0, 0) / 1000); // Monday 2026-09-21, 15:00 UTC

  it('returns null for empty/unrecognized text', () => {
    expect(parseDueHint(null, now)).toBeNull();
    expect(parseDueHint(undefined, now)).toBeNull();
    expect(parseDueHint('', now)).toBeNull();
    expect(parseDueHint('whenever, no rush', now)).toBeNull();
  });

  it('parses common relative phrases the Slack classifiers actually emit', () => {
    expect(parseDueHint('today', now)).toBe(1790010000);
    expect(parseDueHint('Tomorrow', now)).toBe(1790078400);
    expect(parseDueHint('EOD', now)).toBe(1790031600);
    expect(parseDueHint('after lunch', now)).toBe(1789995600);
    expect(parseDueHint('before standup', now)).toBe(1790067600);
  });

  it('parses bare and "next" weekday names relative to the given now', () => {
    // now is itself Monday -> bare "monday" means the next Monday (7 days out)
    expect(parseDueHint('monday', now)).toBe(1790596800);
    // "next monday" skips an extra week beyond that
    expect(parseDueHint('next Monday', now)).toBe(1791201600);
    // "by Friday" -> this week's Friday
    expect(parseDueHint('by Friday', now)).toBe(1790337600);
  });

  it('falls back to Date.parse for an explicit date', () => {
    expect(parseDueHint('2026-12-25', now)).toBe(1798156800);
  });
});

describe('row actions', () => {
  it('markCommitmentDone marks the row done and records the note', () => {
    const id = insertCommitment({ source: 'slack_promise', confidence: 0.8, detected_at: NOW });
    const result = markCommitmentDone(id, 'Shipped the PR', NOW);

    expect(result.ok).toBe(true);
    const row = loadRow(id);
    expect(row.status).toBe('done');
    expect(row.resolved_by).toBe('user');
    expect(row.resolved_at).toBe(NOW);
    expect(row.resolution_note).toBe('Shipped the PR');
  });

  it('markCommitmentDone reports an error for an unknown id', () => {
    const result = markCommitmentDone(999_999, undefined, NOW);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('snoozeCommitment accepts a unix timestamp', () => {
    const id = insertCommitment({ source: 'slack_promise', confidence: 0.8, detected_at: NOW });
    const target = NOW + 3 * 86_400;
    const result = snoozeCommitment(id, target, NOW);

    expect(result.ok).toBe(true);
    const row = loadRow(id);
    expect(row.status).toBe('snoozed');
    expect(row.snoozed_until).toBe(target);
  });

  it('snoozeCommitment accepts a relative phrase via the same due-hint parser', () => {
    const monday = Math.floor(Date.UTC(2026, 8, 21, 15, 0, 0) / 1000);
    const id = insertCommitment({ source: 'slack_promise', confidence: 0.8, detected_at: monday });
    const result = snoozeCommitment(id, 'next Monday', monday);

    expect(result.ok).toBe(true);
    expect(loadRow(id).snoozed_until).toBe(1791201600);
  });

  it('snoozeCommitment rejects an unparseable target or a past timestamp', () => {
    const id = insertCommitment({ source: 'slack_promise', confidence: 0.8, detected_at: NOW });

    const badPhrase = snoozeCommitment(id, 'eventually, maybe', NOW);
    expect(badPhrase.ok).toBe(false);

    const past = snoozeCommitment(id, NOW - 1000, NOW);
    expect(past.ok).toBe(false);

    // Neither rejected attempt actually mutated the row.
    expect(loadRow(id).status).toBe('open');
  });

  it('markCommitmentNotAThing dismisses with a tagged, tunable resolution_note', () => {
    const id = insertCommitment({ source: 'slack_unanswered', confidence: 0.7, detected_at: NOW });
    const result = markCommitmentNotAThing(id, 'was a bot message, not a real ask', NOW);

    expect(result.ok).toBe(true);
    const row = loadRow(id);
    expect(row.status).toBe('dismissed');
    expect(row.resolved_by).toBe('user');
    expect(row.resolution_note).toBe(`${NOT_A_THING_TAG}: was a bot message, not a real ask`);
    expect(isNotAThing(row)).toBe(true);
  });

  it('markCommitmentNotAThing works without a note, and isNotAThing ignores unrelated dismissals', () => {
    const id = insertCommitment({ source: 'idea', confidence: 0.3, detected_at: NOW });
    markCommitmentNotAThing(id, undefined, NOW);
    expect(loadRow(id).resolution_note).toBe(NOT_A_THING_TAG);
    expect(isNotAThing(loadRow(id))).toBe(true);

    const otherId = insertCommitment({
      source: 'idea', confidence: 0.3, detected_at: NOW, status: 'dismissed',
      resolution_note: "Auto-expired: no supporting activity for 30 days (last activity 2026-01-01)",
    });
    expect(isNotAThing(loadRow(otherId))).toBe(false);
  });

  it('markCommitmentDismissed is a plain dismiss, distinct from markCommitmentNotAThing', () => {
    const id = insertCommitment({ source: 'github_stale', confidence: 0.5, detected_at: NOW });
    const result = markCommitmentDismissed(id, 'Closing this out, not worth chasing', NOW);

    expect(result.ok).toBe(true);
    const row = loadRow(id);
    expect(row.status).toBe('dismissed');
    expect(row.resolved_by).toBe('user');
    expect(row.resolution_note).toBe('Closing this out, not worth chasing');
    // No NOT_A_THING_TAG prefix — todo_resolve's generic "dismissed" must not read as "not a thing".
    expect(isNotAThing(row)).toBe(false);
  });

  it('markCommitmentDismissed requires a non-empty note', () => {
    const id = insertCommitment({ source: 'github_stale', confidence: 0.5, detected_at: NOW });
    const result = markCommitmentDismissed(id, '   ', NOW);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/note is required/);
    expect(loadRow(id).status).toBe('open');
  });

  it('markCommitmentDismissed reports an error for an unknown id', () => {
    const result = markCommitmentDismissed(999_999, 'whatever', NOW);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});

describe('resolveCommitmentSource', () => {
  it('strips the #round= suffix for github_review_requested', () => {
    const c = { source: 'github_review_requested' as const, source_ref: 'https://github.com/org/repo/pull/5#round=2' };
    expect(resolveCommitmentSource(c)).toBe('https://github.com/org/repo/pull/5');
  });

  it('passes the PR url through unchanged for the other github sources', () => {
    for (const source of ['github_unaddressed', 'github_stale', 'github_ci_failing'] as const) {
      const c = { source, source_ref: 'https://github.com/org/repo/pull/9' };
      expect(resolveCommitmentSource(c)).toBe('https://github.com/org/repo/pull/9');
    }
  });

  it('looks up the permalink by dedupe_hash for slack sources', () => {
    db.prepare(`
      INSERT INTO slack_messages (captured_at, sender, text, permalink, dedupe_hash)
      VALUES (?, 'Someone', 'will do', 'https://acme.slack.com/archives/C1/p123', 'hash-abc')
    `).run(NOW);

    for (const source of ['slack_ask', 'slack_promise', 'slack_unanswered'] as const) {
      const c = { source, source_ref: 'hash-abc' };
      expect(resolveCommitmentSource(c)).toBe('https://acme.slack.com/archives/C1/p123');
    }
    expect(resolveCommitmentSource({ source: 'slack_ask' as const, source_ref: 'no-such-hash' })).toBeNull();
  });

  it('looks up the meeting url by id, and returns null if the meeting has none', () => {
    db.prepare(`
      INSERT INTO meetings (id, started_at, title, url) VALUES (42, ?, 'Standup', 'https://zoom.us/j/123')
    `).run(NOW);
    db.prepare(`
      INSERT INTO meetings (id, started_at, title, url) VALUES (43, ?, 'No link', NULL)
    `).run(NOW);

    expect(resolveCommitmentSource({ source: 'meeting' as const, source_ref: 'meeting:42:abcdef1234567890' })).toBe('https://zoom.us/j/123');
    expect(resolveCommitmentSource({ source: 'meeting' as const, source_ref: 'meeting:43:abcdef1234567890' })).toBeNull();
  });

  it('resolves standups and ideas to an internal apotheosis:// deep link', () => {
    db.prepare(`INSERT INTO standups (id, date, generated_at) VALUES (7, '2026-09-20', ?)`).run(NOW);

    expect(resolveCommitmentSource({ source: 'standup' as const, source_ref: 'standup:7#today#0' })).toBe('apotheosis://standup/2026-09-20');
    expect(resolveCommitmentSource({ source: 'idea' as const, source_ref: 'idea:99' })).toBe('apotheosis://idea/99');
  });

  it('resolves git_local to a file:// url for the repo root', () => {
    const c = { source: 'git_local' as const, source_ref: 'local:/Users/me/repo#feature-branch' };
    expect(resolveCommitmentSource(c)).toBe('file:///Users/me/repo');
  });

  it('falls back to source_ref only if it already looks like a url, else null, for manual/mention', () => {
    expect(resolveCommitmentSource({ source: 'manual' as const, source_ref: 'https://example.com/x' })).toBe('https://example.com/x');
    expect(resolveCommitmentSource({ source: 'manual' as const, source_ref: 'not-a-url' })).toBeNull();
    expect(resolveCommitmentSource({ source: 'mention' as const, source_ref: 'not-a-url-either' })).toBeNull();
  });
});
