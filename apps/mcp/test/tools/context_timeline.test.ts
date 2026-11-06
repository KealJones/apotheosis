/**
 * Thin smoke test — see packages/core/test/queries/contextTimeline.test.ts
 * for the query-logic assertions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/context_timeline.js';
import { DAY_START_ISO, DAY_END_ISO } from '../fixtures/seed-test-db.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('context_timeline (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('context_timeline');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns events and counts', async () => {
    const result = await handler({ since: DAY_START_ISO, until: DAY_END_ISO });
    const data = JSON.parse(result.content[0].text);
    expect(data.events.length).toBeGreaterThan(0);
    expect(data.counts).toBeDefined();
  });
});
