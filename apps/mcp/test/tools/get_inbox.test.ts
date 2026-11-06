/**
 * Thin smoke test — see packages/core/test/queries/getInbox.test.ts for the
 * query-logic assertions (with gh CLI mocked).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { DAY_START_ISO } from '../fixtures/seed-test-db.js';

vi.mock('../../../../packages/core/src/integrations/github.js', () => ({
  getPendingReviews: () => [
    { number: 2350, title: 'WID-4582: code connect unit test', url: 'https://github.com/acme/widgets/pull/2350', updatedAt: '2026-05-18T20:00:00Z' },
  ],
}));

import { name, description, handler } from '../../src/tools/get_inbox.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('get_inbox (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('get_inbox');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns an MCP content envelope with all three sections', async () => {
    const result = await handler({ mentions_since: DAY_START_ISO });
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('mentions');
    expect(data).toHaveProperty('pending_reviews');
    expect(data).toHaveProperty('open_commitments');
    expect(data).toHaveProperty('summary');
  });
});
