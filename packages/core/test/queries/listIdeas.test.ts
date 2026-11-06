import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { listIdeas } from '../../src/queries/listIdeas.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('list_ideas', () => {
  it('returns all ideas when no filters given', () => {
    const data = listIdeas({});
    expect(data.length).toBeGreaterThanOrEqual(1);
    const idea = data[0];
    expect(idea).toHaveProperty('id');
    expect(idea).toHaveProperty('body');
    expect(idea).toHaveProperty('created_at');
  });

  it('filters by search term', () => {
    const data = listIdeas({ search: 'compact' });
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0].body.toLowerCase()).toContain('compact');
  });

  it('filters by since date', () => {
    // Fixture idea is 12h before DAY_START — use a date after that
    const data = listIdeas({ since: '2030-01-01T00:00:00Z' });
    expect(data).toEqual([]);
  });

  it('returns empty for non-matching search', () => {
    const data = listIdeas({ search: 'zzzznonexistent' });
    expect(data).toEqual([]);
  });
});
