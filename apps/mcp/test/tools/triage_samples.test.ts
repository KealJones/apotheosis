/**
 * Thin smoke test — see packages/core/test/queries/triageSamples.test.ts for
 * the query-logic assertions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/triage_samples.js';
import { TEST_DAY } from '../fixtures/seed-test-db.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('triage_samples (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('triage_samples');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns an MCP content envelope with clusters', async () => {
    const result = await handler({ date: TEST_DAY });
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.clusters)).toBe(true);
    expect(data.clusters.length).toBeGreaterThan(0);
  });
});
