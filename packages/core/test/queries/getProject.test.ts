import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { getProject } from '../../src/queries/getProject.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('get_project', () => {
  it('returns existing project with all fields', () => {
    const data = getProject({ slug: 'wid-4582' }) as any;
    expect(data.slug).toBe('wid-4582');
    expect(data.name).toContain('WID-4582');
    expect(data.status).toBe('active');
    expect(data).toHaveProperty('created_at');
    expect(data).toHaveProperty('links');
  });

  it('returns error for non-existent project', () => {
    const data = getProject({ slug: 'nope' }) as any;
    expect(data.error).toContain('nope');
  });

  it('links array is initially empty for fixture project', () => {
    const data = getProject({ slug: 'wid-4582' }) as any;
    expect(data.links).toEqual([]);
  });
});
