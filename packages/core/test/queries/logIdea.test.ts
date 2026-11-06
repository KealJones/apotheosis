import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { logIdea } from '../../src/queries/logIdea.js';
import type { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;

beforeEach(() => { db = setupTestDb(); });
afterEach(() => { teardownTestDb(); });

describe('log_idea', () => {
  it('inserts a new idea and returns it', () => {
    const data = logIdea({
      body: 'Test idea for unit testing',
      source: 'vitest',
    });
    expect(data.idea.body).toBe('Test idea for unit testing');
    expect(data.idea.source).toBe('vitest');
    expect(data.idea).toHaveProperty('id');
    expect(data.idea).toHaveProperty('created_at');
  });

  it('detects similar existing ideas', () => {
    // The fixture has an idea starting with "Add compact mode..."
    const data = logIdea({
      body: 'Add compact mode to reduce token usage in MCP responses',
    });
    expect(data.similar_ideas.length).toBeGreaterThanOrEqual(1);
    expect(data.note).toContain('similar');
  });

  it('returns no similar ideas for unique content', () => {
    const data = logIdea({
      body: 'Completely unique idea xyz123 nothing like anything else',
    });
    expect(data.similar_ideas).toEqual([]);
    expect(data.note).toContain('No similar');
  });

  it('persists idea to database', () => {
    logIdea({ body: 'Persisted idea' });
    const row = db.prepare(
      'SELECT body FROM ideas WHERE body = ?'
    ).get('Persisted idea');
    expect(row).toBeDefined();
  });
});
