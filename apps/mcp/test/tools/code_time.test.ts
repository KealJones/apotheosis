/**
 * Thin smoke test — see packages/core/test/queries/codeTime.test.ts for the
 * query-logic assertions.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { DAY_START_ISO } from '../fixtures/seed-test-db.js';

vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes('git log')) return 'abc123 test commit\n';
    if (cmd.includes('git config')) return 'testuser\n';
    return '';
  }),
}));

import { name, description, handler } from '../../src/tools/code_time.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('code_time (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('code_time');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns an MCP content envelope with expected fields', async () => {
    const result = await handler({ repo_path: '/Users/testuser/projects/widgets', since: DAY_START_ISO });
    const data = JSON.parse(result.content[0].text);
    expect(data.repo_name).toBe('widgets');
    expect(data.commit_count).toBe(1);
  });
});
