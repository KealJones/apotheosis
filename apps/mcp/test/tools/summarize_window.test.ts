/**
 * Thin smoke test — see packages/core/test/queries/summarizeWindow.test.ts
 * for the query-logic assertions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/summarize_window.js';
import { DAY_START_ISO, DAY_END_ISO } from '../fixtures/seed-test-db.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('summarize_window (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('summarize_window');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns an MCP content envelope with parseable JSON', async () => {
    const result = await handler({ since: DAY_START_ISO, until: DAY_END_ISO });
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.blocks)).toBe(true);
    expect(data.blocks.length).toBeGreaterThan(0);
  });
});
