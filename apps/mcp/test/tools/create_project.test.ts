/**
 * Thin smoke test — see packages/core/test/queries/createProject.test.ts for
 * the query-logic assertions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/create_project.js';

beforeEach(() => { setupTestDb(); });
afterEach(() => { teardownTestDb(); });

describe('create_project (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('create_project');
    expect(description.length).toBeGreaterThan(0);
  });

  it('creates a new project', async () => {
    const result = await handler({ slug: 'smoke-test', name: 'Smoke Test' });
    const data = JSON.parse(result.content[0].text);
    expect(data.slug).toBe('smoke-test');
  });
});
