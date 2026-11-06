/**
 * Thin smoke test — see packages/core/test/queries/standupDraft.test.ts for
 * the query-logic assertions (with gh CLI mocked).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { TEST_STANDUP_DATE } from '../fixtures/seed-test-db.js';

vi.mock('../../../../packages/core/src/integrations/github.js', () => ({
  getPendingReviews: () => [
    { number: 2350, title: 'WID-4582: code connect unit test', url: 'https://github.com/acme/widgets/pull/2350', updatedAt: '2026-05-18T20:00:00Z' },
  ],
}));

import { name, description, handler } from '../../src/tools/standup_draft.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('standup_draft (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('standup_draft');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns an MCP content envelope with expected top-level fields', async () => {
    const result = await handler({ date: TEST_STANDUP_DATE });
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('date', TEST_STANDUP_DATE);
    expect(data).toHaveProperty('yesterday_sessions');
    expect(data.open_prs.length).toBe(1);
  });
});
