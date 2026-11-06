import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';

// Mock execSync since we can't run git in tests against fixture data
vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes('git log')) {
      return 'abc123 WID-4582: add figma test utils\ndef456 WID-4582: fix Button.figma.ts\n';
    }
    if (cmd.includes('git config')) {
      return 'testuser\n';
    }
    return '';
  }),
}));

import { getCodeTime } from '../../src/queries/codeTime.js';
import { DAY_START_ISO } from '../fixtures/seed-test-db.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('code_time', () => {
  it('returns expected fields', () => {
    const data = getCodeTime({
      repo_path: '/Users/testuser/projects/widgets',
      since: DAY_START_ISO,
    });
    expect(data).toHaveProperty('repo');
    expect(data).toHaveProperty('repo_name', 'widgets');
    expect(data).toHaveProperty('git_author');
    expect(data).toHaveProperty('commits');
    expect(data).toHaveProperty('commit_count');
    expect(data).toHaveProperty('sample_count');
    expect(data).toHaveProperty('estimated_active_seconds');
    expect(data).toHaveProperty('estimated_active_hours');
  });

  it('returns commits from mocked git log', () => {
    const data = getCodeTime({
      repo_path: '/Users/testuser/projects/widgets',
      since: DAY_START_ISO,
    });
    expect(data.commit_count).toBe(2);
    expect(data.commits[0]).toContain('WID-4582');
  });

  it('estimates active time from sample count', () => {
    const data = getCodeTime({
      repo_path: '/Users/testuser/projects/widgets',
      since: DAY_START_ISO,
    });
    // Fixture has samples with "widgets" in window_title
    expect(data.sample_count).toBeGreaterThan(0);
    expect(data.estimated_active_seconds).toBe(data.sample_count * 15);
    expect(data.estimated_active_hours).toBeGreaterThan(0);
  });

  it('uses dynamic git author', () => {
    const data = getCodeTime({
      repo_path: '/Users/testuser/projects/widgets',
      since: DAY_START_ISO,
    });
    expect(data.git_author).toBe('testuser');
  });
});
