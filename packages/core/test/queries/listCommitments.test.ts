import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { listCommitments } from '../../src/queries/listCommitments.js';
import { markCommitmentDismissed, markCommitmentNotAThing } from '../../src/queries/rankedCommitments.js';
import type { CommitmentSource, CommitmentStatus } from '../../src/commitments/types.js';

let db: ReturnType<typeof setupTestDb>;

beforeAll(() => { db = setupTestDb(); });
afterAll(() => { teardownTestDb(); });

beforeEach(() => {
  db.exec('DELETE FROM commitments');
});

const NOW = 1_700_000_000;
let refCounter = 0;

function insertCommitment(o: {
  source: CommitmentSource;
  status?: CommitmentStatus;
  detected_at?: number;
  source_ref?: string;
}): number {
  const source_ref = o.source_ref ?? `ref-${++refCounter}`;
  const detected_at = o.detected_at ?? NOW;
  const result = db.prepare(`
    INSERT INTO commitments (detected_at, source, source_ref, title, confidence, status, last_activity_at)
    VALUES (?, ?, ?, ?, 0.8, ?, ?)
  `).run(detected_at, o.source, source_ref, `Title ${source_ref}`, o.status ?? 'open', detected_at);
  return Number(result.lastInsertRowid);
}

describe('listCommitments', () => {
  it('lists every status by default, newest first', () => {
    const older = insertCommitment({ source: 'slack_ask', detected_at: NOW - 86_400 });
    const newer = insertCommitment({ source: 'github_stale', detected_at: NOW });

    const result = listCommitments();
    expect(result.commitments.map((c) => c.id)).toEqual([newer, older]);
    expect(result.total).toBe(2);
  });

  it('filters by source', () => {
    insertCommitment({ source: 'slack_ask' });
    const wantedId = insertCommitment({ source: 'github_stale' });

    const result = listCommitments({ source: 'github_stale' });
    expect(result.commitments.map((c) => c.id)).toEqual([wantedId]);
    expect(result.total).toBe(1);
  });

  it('filters by status', () => {
    insertCommitment({ source: 'slack_ask', status: 'open' });
    const doneId = insertCommitment({ source: 'slack_ask', status: 'done' });

    const result = listCommitments({ status: 'done' });
    expect(result.commitments.map((c) => c.id)).toEqual([doneId]);
    expect(result.total).toBe(1);
  });

  it('combines source and status filters', () => {
    insertCommitment({ source: 'slack_ask', status: 'done' });
    const wantedId = insertCommitment({ source: 'github_stale', status: 'done' });
    insertCommitment({ source: 'github_stale', status: 'open' });

    const result = listCommitments({ source: 'github_stale', status: 'done' });
    expect(result.commitments.map((c) => c.id)).toEqual([wantedId]);
  });

  it('distinguishes a tagged "not a thing" dismissal from a plain dismiss', () => {
    const plainId = insertCommitment({ source: 'slack_ask' });
    markCommitmentDismissed(plainId, 'Deprioritized', NOW);
    const notAThingId = insertCommitment({ source: 'slack_ask' });
    markCommitmentNotAThing(notAThingId, 'Bot message', NOW);

    const result = listCommitments({ status: 'dismissed' });
    const byId = new Map(result.commitments.map((c) => [c.id, c]));
    expect(byId.get(plainId)?.is_not_a_thing).toBe(false);
    expect(byId.get(notAThingId)?.is_not_a_thing).toBe(true);
  });

  it('never flags is_not_a_thing on a non-dismissed row', () => {
    const openId = insertCommitment({ source: 'slack_ask', status: 'open' });
    const result = listCommitments({ status: 'open' });
    expect(result.commitments.find((c) => c.id === openId)?.is_not_a_thing).toBe(false);
  });

  it('resolves source_url the same way getTodoList does', () => {
    db.prepare(`
      INSERT INTO slack_messages (captured_at, sender, text, permalink, dedupe_hash)
      VALUES (?, 'Someone', 'can you take a look', 'https://acme.slack.com/archives/C1/p1', 'hash-1')
    `).run(NOW);
    insertCommitment({ source: 'slack_ask', source_ref: 'hash-1' });

    const result = listCommitments({ source: 'slack_ask' });
    expect(result.commitments[0].source_url).toBe('https://acme.slack.com/archives/C1/p1');
  });

  it('paginates with limit/offset while total stays the full filtered count', () => {
    for (let i = 0; i < 5; i++) {
      insertCommitment({ source: 'slack_ask', detected_at: NOW - i * 86_400 });
    }
    const page = listCommitments({ source: 'slack_ask', limit: 2, offset: 2 });
    expect(page.commitments).toHaveLength(2);
    expect(page.total).toBe(5);
  });
});
