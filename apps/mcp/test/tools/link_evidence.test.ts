/**
 * Thin smoke test — see packages/core/test/queries/linkEvidence.test.ts for
 * the query-logic assertions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '@apotheosis/core';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/link_evidence.js';

beforeEach(() => { setupTestDb(); });
afterEach(() => { teardownTestDb(); });

describe('link_evidence (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('link_evidence');
    expect(description.length).toBeGreaterThan(0);
  });

  it('links a sample to the fixture project', async () => {
    const db = getDb();
    const sample = db.prepare('SELECT id FROM samples WHERE is_evidence = 0 LIMIT 1').get() as { id: number };

    const result = await handler({ project_slug: 'wid-4582', sample_ids: [sample.id] });
    const data = JSON.parse(result.content[0].text);
    expect(data.linked).toBe(1);
  });
});
