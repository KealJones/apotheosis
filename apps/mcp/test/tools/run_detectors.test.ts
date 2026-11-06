/**
 * Thin smoke test against the real production detector registry — same approach as
 * packages/core/test/commitments/runner.test.ts, and for the same reason: `gh` is mocked
 * (no real subprocess/network calls from a unit test), but nothing else needs to be, since
 * the fixture DB's data is dated 2026-05 and every event-style detector's lookback window is
 * a handful of days from the real wall clock — old fixture rows never enter their scan
 * window, so no Ollama classification calls happen either.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../packages/core/src/integrations/github.js', () => ({
  getPendingReviews: () => [],
  getPrState: () => null,
  getMyPrsForRepo: () => [],
  getViewerLogin: () => 'test-user',
  parsePrUrl: () => null,
}));

import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { name, description, handler } from '../../src/tools/run_detectors.js';

describe('run_detectors (MCP tool)', () => {
  it('exposes name and description, and documents there is no artificial timeout', () => {
    expect(name).toBe('run_detectors');
    expect(description.length).toBeGreaterThan(0);
    expect(description).toMatch(/no artificial timeout/);
  });

  it('awaits the full run and returns a RunReport shape', async () => {
    setupTestDb();
    try {
      const result = await handler({});
      const report = JSON.parse(result.content[0].text);
      expect(typeof report.now).toBe('number');
      expect(typeof report.woken).toBe('number');
      expect(Array.isArray(report.detectors)).toBe(true);
      expect(typeof report.expired).toBe('number');
      // Every registered detector ran and reported, whether or not it found anything.
      expect(report.detectors.length).toBeGreaterThan(0);
    } finally {
      teardownTestDb();
    }
  }, 30_000);
});
