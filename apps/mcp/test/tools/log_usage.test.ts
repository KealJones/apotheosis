/**
 * Thin smoke test — logUsage()'s own behavior is covered in
 * packages/core/test/usage.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb } from '@apotheosis/core';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/log_usage.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('log_usage (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('log_usage');
    expect(description.length).toBeGreaterThan(0);
  });

  it('logs a skill invocation to the DB', async () => {
    const result = await handler({ skill: 'smoke-test', args: 'x' });
    const data = JSON.parse(result.content[0].text);
    expect(data.logged).toBe(true);

    const db = getDb();
    const row = db.prepare('SELECT * FROM tool_usage WHERE kind = ? AND name = ?').get('skill', 'smoke-test');
    expect(row).toBeDefined();
  });
});
