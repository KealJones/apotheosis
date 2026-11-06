/**
 * Thin smoke test — see packages/core/test/queries/todoResolve.test.ts for the query-logic assertions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '@apotheosis/core';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/todo_resolve.js';

beforeEach(() => { setupTestDb(); });
afterEach(() => { teardownTestDb(); });

describe('todo_resolve (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('todo_resolve');
    expect(description.length).toBeGreaterThan(0);
  });

  it('resolves the seeded mention commitment as done', async () => {
    const db = getDb();
    const row = db.prepare(`SELECT id FROM commitments WHERE source = 'mention'`).get() as { id: number };

    const result = await handler({ id: row.id, resolution: 'done', note: 'Reviewed the PR' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);

    const updated = db.prepare('SELECT status, resolution_note FROM commitments WHERE id = ?').get(row.id) as any;
    expect(updated.status).toBe('done');
    expect(updated.resolution_note).toBe('Reviewed the PR');
  });

  it('rejects a missing note', async () => {
    const db = getDb();
    const row = db.prepare(`SELECT id FROM commitments WHERE source = 'mention'`).get() as { id: number };
    const result = await handler({ id: row.id, resolution: 'done', note: '' });
    expect(JSON.parse(result.content[0].text).ok).toBe(false);
  });
});
