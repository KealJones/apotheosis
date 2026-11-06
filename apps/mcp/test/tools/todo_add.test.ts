/**
 * Thin smoke test — see packages/core/test/queries/addManualCommitment.test.ts for the
 * query-logic assertions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '@apotheosis/core';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/todo_add.js';

beforeEach(() => { setupTestDb(); });
afterEach(() => { teardownTestDb(); });

describe('todo_add (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('todo_add');
    expect(description.length).toBeGreaterThan(0);
  });

  it('creates a full-confidence manual commitment', async () => {
    const result = await handler({ title: 'Call the dentist' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.source).toBe('manual');
    expect(parsed.title).toBe('Call the dentist');
    expect(parsed.confidence).toBe(1);

    const db = getDb();
    const row = db.prepare('SELECT * FROM commitments WHERE id = ?').get(parsed.id) as any;
    expect(row.status).toBe('open');
  });
});
