/**
 * Thin smoke test — see packages/core/test/queries/listIdeas.test.ts for the
 * query-logic assertions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/list_ideas.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('list_ideas (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('list_ideas');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns an MCP content envelope with an array', async () => {
    const result = await handler({});
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
  });
});
