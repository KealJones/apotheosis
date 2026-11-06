/**
 * Thin smoke test — see packages/core/test/usage.test.ts for the
 * query-logic assertions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { logUsage } from '@apotheosis/core';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/usage_stats.js';

beforeAll(() => {
  setupTestDb();
  logUsage('tool', 'summarize_window', undefined, 100);
});
afterAll(() => { teardownTestDb(); });

describe('usage_stats (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('usage_stats');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns totals and per-name breakdown', async () => {
    const result = await handler({});
    const data = JSON.parse(result.content[0].text);
    expect(data.totals).toBeDefined();
    expect(Array.isArray(data.by_name)).toBe(true);
  });
});
