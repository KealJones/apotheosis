/**
 * Thin smoke test — see packages/core/test/queries/deleteSamples.test.ts for
 * the query-logic assertions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '@apotheosis/core';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/delete_samples.js';

beforeEach(() => { setupTestDb(); });
afterEach(() => { teardownTestDb(); });

describe('delete_samples (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('delete_samples');
    expect(description.length).toBeGreaterThan(0);
  });

  it('deletes a non-evidence sample and reports it', async () => {
    const db = getDb();
    const sample = db.prepare('SELECT id FROM samples WHERE is_evidence = 0 LIMIT 1').get() as { id: number };

    const result = await handler({ ids: [sample.id] });
    const data = JSON.parse(result.content[0].text);
    expect(data.deleted).toContain(sample.id);
  });
});
