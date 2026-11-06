/**
 * Thin smoke test — see packages/core/test/queries/logIdea.test.ts for the
 * query-logic assertions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/log_idea.js';

beforeEach(() => { setupTestDb(); });
afterEach(() => { teardownTestDb(); });

describe('log_idea (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('log_idea');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns an MCP content envelope with the saved idea', async () => {
    const result = await handler({ body: 'Smoke test idea', source: 'vitest' });
    const data = JSON.parse(result.content[0].text);
    expect(data.idea.body).toBe('Smoke test idea');
  });
});
