/**
 * Thin smoke test — see packages/core/test/queries/getProject.test.ts for the
 * query-logic assertions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/get_project.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('get_project (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('get_project');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns the fixture project', async () => {
    const result = await handler({ slug: 'wid-4582' });
    const data = JSON.parse(result.content[0].text);
    expect(data.slug).toBe('wid-4582');
  });
});
