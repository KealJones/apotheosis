/**
 * Thin smoke test — see packages/core/test/queries/todoList.test.ts for the query-logic assertions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '@apotheosis/core';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/todo_list.js';

beforeEach(() => { setupTestDb(); });
afterEach(() => { teardownTestDb(); });

describe('todo_list (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('todo_list');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns the seeded mention commitment shaped as JSON', async () => {
    const db = getDb();
    const row = db.prepare(`SELECT id FROM commitments WHERE source = 'mention'`).get() as { id: number } | undefined;
    expect(row).toBeDefined();

    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed.todos)).toBe(true);
    expect(parsed.todos.some((t: { id: number }) => t.id === row!.id)).toBe(true);
  });
});
