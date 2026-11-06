/**
 * Thin smoke test for evidence_report (no dedicated core query test existed
 * pre-refactor; this preserves the same coverage level as before).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/evidence_report.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('evidence_report (MCP tool)', () => {
  it('exposes name and description', () => {
    expect(name).toBe('evidence_report');
    expect(description.length).toBeGreaterThan(0);
  });

  it('returns an MCP content envelope with the expected shape', async () => {
    const result = await handler({});
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('period');
    expect(Array.isArray(data.projects)).toBe(true);
    expect(Array.isArray(data.standups)).toBe(true);
    expect(data).toHaveProperty('ai_usage');
  });
});
