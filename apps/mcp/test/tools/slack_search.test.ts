/**
 * Thin smoke test — see packages/core/test/queries/slackSearch.test.ts for
 * the query-logic assertions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/slack_search.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('slack_search (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('slack_search');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns messages matching a query', async () => {
    const result = await handler({ q: 'tokenname' });
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(1);
  });
});
