/**
 * Thin smoke test — see packages/core/test/queries/mentions.test.ts for the
 * query-logic assertions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/mentions.js';
import { DAY_START_ISO } from '../fixtures/seed-test-db.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('mentions (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('mentions');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns an MCP content envelope with mention groups', async () => {
    const result = await handler({ since: DAY_START_ISO });
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
  });
});
