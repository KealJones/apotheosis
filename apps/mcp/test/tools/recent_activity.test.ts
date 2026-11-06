/**
 * Thin smoke test: verifies the MCP tool wrapper wires up correctly and
 * produces the expected content envelope. Detailed query-logic assertions
 * live in packages/core/test/queries/recentActivity.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/recent_activity.js';
import { DAY_START_ISO, DAY_END_ISO } from '../fixtures/seed-test-db.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('recent_activity (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('recent_activity');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns an MCP content envelope with parseable JSON', async () => {
    const result = await handler({ since: DAY_START_ISO, until: DAY_END_ISO });
    expect(result.content[0].type).toBe('text');
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.samples)).toBe(true);
    expect(data.samples.length).toBeGreaterThan(0);
  });
});
