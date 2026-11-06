import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { deleteSamples } from '../../src/queries/deleteSamples.js';
import type { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;

// Fresh DB for each test since delete is destructive
beforeEach(() => { db = setupTestDb(); });
afterEach(() => { teardownTestDb(); });

describe('delete_samples', () => {
  it('deletes non-evidence samples', () => {
    const sample = db.prepare(
      'SELECT id FROM samples WHERE is_evidence = 0 LIMIT 1'
    ).get() as { id: number };

    const data = deleteSamples({ ids: [sample.id] });
    expect(data.deleted).toContain(sample.id);
    expect(data.refused).toEqual([]);

    // Verify it's gone
    const row = db.prepare('SELECT id FROM samples WHERE id = ?').get(sample.id);
    expect(row).toBeUndefined();
  });

  it('refuses to delete evidence-tagged samples', () => {
    const evidenceSample = db.prepare(
      'SELECT id FROM samples WHERE is_evidence = 1 LIMIT 1'
    ).get() as { id: number };

    const data = deleteSamples({ ids: [evidenceSample.id] });
    expect(data.refused).toContain(evidenceSample.id);
    expect(data.deleted).toEqual([]);

    // Verify it's still there
    const row = db.prepare('SELECT id FROM samples WHERE id = ?').get(evidenceSample.id);
    expect(row).toBeDefined();
  });

  it('handles mixed evidence and non-evidence IDs', () => {
    const normal = db.prepare(
      'SELECT id FROM samples WHERE is_evidence = 0 LIMIT 1'
    ).get() as { id: number };
    const evidence = db.prepare(
      'SELECT id FROM samples WHERE is_evidence = 1 LIMIT 1'
    ).get() as { id: number };

    const data = deleteSamples({ ids: [normal.id, evidence.id] });
    expect(data.deleted).toContain(normal.id);
    expect(data.refused).toContain(evidence.id);
  });

  it('reports error for non-existent sample ID', () => {
    const data = deleteSamples({ ids: [999999] });
    expect(data.errors.length).toBe(1);
    expect(data.errors[0]).toContain('999999');
  });
});
