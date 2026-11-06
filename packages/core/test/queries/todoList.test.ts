import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { getTodoList } from '../../src/queries/todoList.js';
import { TOP_CAP } from '../../src/queries/rankedCommitments.js';
import type { CommitmentSource } from '../../src/commitments/types.js';

let db: ReturnType<typeof setupTestDb>;

beforeAll(() => { db = setupTestDb(); });
afterAll(() => { teardownTestDb(); });

// This suite owns its own fixtures — see rankedCommitments.test.ts for why the clean slate.
beforeEach(() => {
  db.exec('DELETE FROM commitments');
});

let refCounter = 0;

function insertCommitment(o: {
  source: CommitmentSource;
  confidence: number;
  detected_at: number;
  status?: string;
  source_ref?: string;
}): number {
  const source_ref = o.source_ref ?? `ref-${++refCounter}`;
  const result = db.prepare(`
    INSERT INTO commitments (detected_at, source, source_ref, title, confidence, status, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(o.detected_at, o.source, source_ref, `Title ${source_ref}`, o.confidence, o.status ?? 'open', o.detected_at);
  return Number(result.lastInsertRowid);
}

const NOW = 1_700_000_000;

describe('getTodoList', () => {
  it('shapes ranked items with age_days, score, and a resolvable source_url', () => {
    db.prepare(`
      INSERT INTO slack_messages (captured_at, sender, text, permalink, dedupe_hash)
      VALUES (?, 'Someone', 'can you take a look', 'https://acme.slack.com/archives/C1/p1', 'hash-1')
    `).run(NOW);
    const id = insertCommitment({ source: 'slack_ask', confidence: 0.9, detected_at: NOW - 3 * 86_400, source_ref: 'hash-1' });

    const result = getTodoList({ now: NOW });
    expect(result.todos).toHaveLength(1);
    const item = result.todos[0];
    expect(item.id).toBe(id);
    expect(item.age_days).toBe(3);
    expect(item.source_url).toBe('https://acme.slack.com/archives/C1/p1');
    expect(item.score).toBeGreaterThan(0);
    expect(result.maybe).toEqual([]);
  });

  it('defaults to TOP_CAP and respects an explicit limit', () => {
    for (let i = 0; i < 10; i++) {
      insertCommitment({ source: 'github_review_requested', confidence: 0.9, detected_at: NOW - i * 86_400 });
    }
    expect(getTodoList({ now: NOW }).todos).toHaveLength(TOP_CAP);
    expect(getTodoList({ now: NOW, limit: 3 }).todos).toHaveLength(3);
    expect(getTodoList({ now: NOW, limit: 100 }).todos).toHaveLength(10);
  });

  it('omits the maybe tray by default and includes it when include_maybe is set', () => {
    insertCommitment({ source: 'github_review_requested', confidence: 0.9, detected_at: NOW });
    insertCommitment({ source: 'idea', confidence: 0.2, detected_at: NOW }); // below MAYBE_CONFIDENCE_THRESHOLD

    expect(getTodoList({ now: NOW }).maybe).toEqual([]);
    const withMaybe = getTodoList({ now: NOW, include_maybe: true });
    expect(withMaybe.maybe).toHaveLength(1);
    expect(withMaybe.maybe[0].source).toBe('idea');
  });

  it('filters by source without losing items that would otherwise be pushed out by the cap', () => {
    // 8 review-requested items (one over TOP_CAP) plus a single lower-ranked slack_promise.
    for (let i = 0; i < 8; i++) {
      insertCommitment({ source: 'github_review_requested', confidence: 0.9, detected_at: NOW - i * 86_400 });
    }
    const promiseId = insertCommitment({ source: 'slack_promise', confidence: 0.8, detected_at: NOW - 100 * 86_400 });

    const filtered = getTodoList({ now: NOW, source: 'slack_promise' });
    expect(filtered.todos.map((t) => t.id)).toEqual([promiseId]);
    // total_open is unfiltered — the whole ledger's open/snoozed count.
    expect(filtered.total_open).toBe(9);
  });

  it('excludes done/dismissed commitments', () => {
    insertCommitment({ source: 'slack_ask', confidence: 0.9, detected_at: NOW, status: 'done' });
    insertCommitment({ source: 'slack_ask', confidence: 0.9, detected_at: NOW, status: 'dismissed' });
    const result = getTodoList({ now: NOW });
    expect(result.todos).toEqual([]);
    expect(result.total_open).toBe(0);
  });
});
