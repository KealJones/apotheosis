import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { linkEvidence } from '../../src/queries/linkEvidence.js';
import type { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;

beforeEach(() => { db = setupTestDb(); });
afterEach(() => { teardownTestDb(); });

describe('link_evidence', () => {
  it('links samples to an existing project', () => {
    const sample = db.prepare(
      'SELECT id FROM samples WHERE is_evidence = 0 LIMIT 1'
    ).get() as { id: number };

    const data = linkEvidence({
      project_slug: 'wid-4582',
      sample_ids: [sample.id],
    }) as { project_slug: string; linked: number };
    expect(data.project_slug).toBe('wid-4582');
    expect(data.linked).toBe(1);

    // Verify is_evidence flag was set
    const row = db.prepare(
      'SELECT is_evidence FROM samples WHERE id = ?'
    ).get(sample.id) as { is_evidence: number };
    expect(row.is_evidence).toBe(1);
  });

  it('creates project_links entry', () => {
    const sample = db.prepare(
      'SELECT id FROM samples WHERE is_evidence = 0 LIMIT 1'
    ).get() as { id: number };

    linkEvidence({ project_slug: 'wid-4582', sample_ids: [sample.id] });

    const project = db.prepare(
      'SELECT id FROM projects WHERE slug = ?'
    ).get('wid-4582') as { id: number };
    const link = db.prepare(
      'SELECT * FROM project_links WHERE project_id = ? AND external_id = ?'
    ).get(project.id, sample.id.toString());
    expect(link).toBeDefined();
  });

  it('returns error for non-existent project', () => {
    const data = linkEvidence({
      project_slug: 'does-not-exist',
      sample_ids: [1],
    }) as { error: string };
    expect(data.error).toContain('does-not-exist');
  });

  it('deduplicates project_links on repeated calls', () => {
    const sample = db.prepare(
      'SELECT id FROM samples WHERE is_evidence = 0 LIMIT 1'
    ).get() as { id: number };

    linkEvidence({ project_slug: 'wid-4582', sample_ids: [sample.id] });
    const data = linkEvidence({
      project_slug: 'wid-4582',
      sample_ids: [sample.id],
    }) as { linked: number };
    // Second call should show 0 newly linked (INSERT OR IGNORE)
    expect(data.linked).toBe(0);
  });
});
