/**
 * Thin smoke test — snoozeCommitment/parseDueHint logic is exercised in
 * packages/core/test/queries/rankedCommitments.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '@apotheosis/core';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/todo_snooze.js';

beforeEach(() => { setupTestDb(); });
afterEach(() => { teardownTestDb(); });

describe('todo_snooze (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('todo_snooze');
    expect(description.length).toBeGreaterThan(0);
  });

  it('snoozes the seeded mention commitment to an explicit date', async () => {
    const db = getDb();
    const row = db.prepare(`SELECT id FROM commitments WHERE source = 'mention'`).get() as { id: number };

    const result = await handler({ id: row.id, until: '2099-01-01' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);

    const updated = db.prepare('SELECT status, snoozed_until FROM commitments WHERE id = ?').get(row.id) as any;
    expect(updated.status).toBe('snoozed');
    expect(updated.snoozed_until).toBeGreaterThan(0);
  });

  it('rejects an unparseable snooze target', async () => {
    const db = getDb();
    const row = db.prepare(`SELECT id FROM commitments WHERE source = 'mention'`).get() as { id: number };
    const result = await handler({ id: row.id, until: 'eventually, maybe' });
    expect(JSON.parse(result.content[0].text).ok).toBe(false);
  });
});
