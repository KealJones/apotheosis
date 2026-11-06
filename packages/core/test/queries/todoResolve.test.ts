import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { resolveTodo } from '../../src/queries/todoResolve.js';
import { isNotAThing } from '../../src/queries/rankedCommitments.js';
import type { Commitment } from '../../src/commitments/types.js';

let db: ReturnType<typeof setupTestDb>;

beforeAll(() => { db = setupTestDb(); });
afterAll(() => { teardownTestDb(); });

beforeEach(() => {
  db.exec('DELETE FROM commitments');
});

const NOW = 1_700_000_000;
let refCounter = 0;

function insertCommitment(): number {
  const source_ref = `ref-${++refCounter}`;
  const result = db.prepare(`
    INSERT INTO commitments (detected_at, source, source_ref, title, confidence, status, last_activity_at)
    VALUES (?, 'slack_promise', ?, 'Follow up', 0.8, 'open', ?)
  `).run(NOW, source_ref, NOW);
  return Number(result.lastInsertRowid);
}

function loadRow(id: number): Commitment {
  return db.prepare('SELECT * FROM commitments WHERE id = ?').get(id) as Commitment;
}

describe('resolveTodo', () => {
  it('requires a note regardless of resolution', () => {
    const id = insertCommitment();
    const result = resolveTodo({ id, resolution: 'done', note: '' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/note is required/);
    expect(loadRow(id).status).toBe('open');
  });

  it('dispatches "done" to markCommitmentDone', () => {
    const id = insertCommitment();
    const result = resolveTodo({ id, resolution: 'done', note: 'Shipped it' });
    expect(result.ok).toBe(true);
    expect(loadRow(id).status).toBe('done');
    expect(loadRow(id).resolution_note).toBe('Shipped it');
  });

  it('dispatches "dismissed" to a plain dismiss (not tagged not_a_thing)', () => {
    const id = insertCommitment();
    const result = resolveTodo({ id, resolution: 'dismissed', note: 'Deprioritized' });
    expect(result.ok).toBe(true);
    const row = loadRow(id);
    expect(row.status).toBe('dismissed');
    expect(row.resolution_note).toBe('Deprioritized');
    expect(isNotAThing(row)).toBe(false);
  });

  it('dispatches "not_a_thing" to the tunable tagged dismiss', () => {
    const id = insertCommitment();
    const result = resolveTodo({ id, resolution: 'not_a_thing', note: 'Bot message, not a real ask' });
    expect(result.ok).toBe(true);
    const row = loadRow(id);
    expect(row.status).toBe('dismissed');
    expect(isNotAThing(row)).toBe(true);
  });
});
