import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { createProject } from '../../src/queries/createProject.js';

beforeEach(() => { setupTestDb(); });
afterEach(() => { teardownTestDb(); });

describe('create_project', () => {
  it('creates a new project with all fields', () => {
    const data = createProject({
      slug: 'test-project',
      name: 'Test Project',
      description: 'A test project',
    }) as any;
    expect(data.slug).toBe('test-project');
    expect(data.name).toBe('Test Project');
    expect(data.description).toBe('A test project');
    expect(data.status).toBe('active');
    expect(data).toHaveProperty('created_at');
  });

  it('returns error for duplicate slug', () => {
    // 'wid-4582' already exists in fixture data
    const data = createProject({
      slug: 'wid-4582',
      name: 'Duplicate',
    }) as any;
    expect(data.error).toContain('wid-4582');
  });

  it('creates project without description', () => {
    const data = createProject({
      slug: 'no-desc',
      name: 'No Description',
    }) as any;
    expect(data.slug).toBe('no-desc');
    expect(data.description).toBeNull();
  });
});
