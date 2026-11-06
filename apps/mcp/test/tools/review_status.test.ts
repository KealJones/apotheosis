import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, handler } from '../../src/tools/review_status.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('review_status (MCP tool)', () => {
  it('exposes its name', () => {
    expect(name).toBe('review_status');
  });

  it('scores an empty range as rule-decided gaps against the requested target level', async () => {
    const result = await handler({ target_level: 'p5', current_level: 'p4', since: '2020-01-01', until: '2020-12-31' });
    const data = JSON.parse(result.content[0].text);
    expect(data.target_level.id).toBe('p5');
    expect(data.current_level.id).toBe('p4');
    expect(data.criteria.length).toBe(7);
    for (const c of data.criteria) {
      expect(c.status).toBe('gap');
      expect(c.citations).toEqual([]);
    }
  });

  it('returns an error for an unknown level instead of defaulting', async () => {
    const result = await handler({ target_level: 'staff' });
    expect(JSON.parse(result.content[0].text).error).toMatch(/Unknown level "staff"/);
  });
});
