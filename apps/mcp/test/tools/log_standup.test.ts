/**
 * Thin smoke test — see packages/core/test/queries/logStandup.test.ts for the
 * query-logic assertions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '@apotheosis/core';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/log_standup.js';

beforeEach(() => { setupTestDb(); });
afterEach(() => { teardownTestDb(); });

describe('log_standup (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('log_standup');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns confirmation text and persists the row', async () => {
    const result = await handler({ date: '2026-06-01', yesterday: '- Smoke tested' });
    expect(result.content[0].text).toContain('2026-06-01');

    const db = getDb();
    const row = db.prepare('SELECT * FROM standups WHERE date = ?').get('2026-06-01') as any;
    expect(row.yesterday).toBe('- Smoke tested');
  });

  it('passes today_commitment_ids through to standup_items.commitment_id (C7)', async () => {
    const db = getDb();
    // commitment_id is FK-enforced, so point at the fixture's real seeded commitment row.
    const seeded = db.prepare(`SELECT id FROM commitments WHERE source = 'mention'`).get() as { id: number };

    await handler({
      date: '2026-06-02',
      yesterday: '- Smoke tested',
      today: '- Follow up on the thing',
      today_commitment_ids: [seeded.id],
    });

    const standup = db.prepare('SELECT id FROM standups WHERE date = ?').get('2026-06-02') as { id: number };
    const item = db.prepare(
      "SELECT commitment_id FROM standup_items WHERE standup_id = ? AND section = 'today'"
    ).get(standup.id) as { commitment_id: number };
    expect(item.commitment_id).toBe(seeded.id);
  });
});
