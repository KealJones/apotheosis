import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { getTriageSamples } from '../../src/queries/triageSamples.js';
import { TEST_DAY } from '../fixtures/seed-test-db.js';

let db: ReturnType<typeof setupTestDb>;

beforeAll(() => { db = setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('triage_samples', () => {
  it('returns clusters with expected fields', () => {
    const data = getTriageSamples({ date: TEST_DAY });
    expect(data.clusters.length).toBeGreaterThan(0);
    const cluster = data.clusters[0];
    expect(cluster).toHaveProperty('signal');
    expect(cluster).toHaveProperty('app_name');
    expect(cluster).toHaveProperty('window_title');
    expect(cluster).toHaveProperty('sample_ids');
    expect(cluster).toHaveProperty('duration_min');
  });

  it('excludes evidence-tagged samples', () => {
    const data = getTriageSamples({ date: TEST_DAY });
    const allIds = data.clusters.flatMap((c) => c.sample_ids);
    // Evidence samples should not appear
    const evidenceRows = db.prepare(
      'SELECT id FROM samples WHERE is_evidence = 1'
    ).all() as { id: number }[];
    for (const row of evidenceRows) {
      expect(allIds).not.toContain(row.id);
    }
  });

  it('scores work sessions higher than low-signal blips', () => {
    const data = getTriageSamples({ date: TEST_DAY });
    const vsCodeClusters = data.clusters.filter((c) => c.app_name === 'Code');
    const finderClusters = data.clusters.filter((c) => c.app_name === 'Finder');
    // VS Code work should be high/medium, Finder blips should be low
    if (vsCodeClusters.length > 0 && finderClusters.length > 0) {
      const signalOrder = { high: 3, medium: 2, low: 1 };
      const bestWork = Math.max(...vsCodeClusters.map((c) => signalOrder[c.signal]));
      const bestFinder = Math.max(...finderClusters.map((c) => signalOrder[c.signal]));
      expect(bestWork).toBeGreaterThanOrEqual(bestFinder);
    }
  });

  it('response size baseline', () => {
    const data = getTriageSamples({ date: TEST_DAY });
    const size = JSON.stringify(data, null, 2).length;
    expect(size).toBeGreaterThan(0);
    console.log(`triage_samples: ${size} chars`);
  });

  // ── Compact mode tests ──────────────────────────────────────────────────
  it('compact mode omits ocr_excerpt from clusters', () => {
    const data = getTriageSamples({ date: TEST_DAY, compact: true });
    expect(data.clusters.length).toBeGreaterThan(0);
    for (const cluster of data.clusters) {
      expect(cluster).not.toHaveProperty('ocr_excerpt');
      expect(cluster).toHaveProperty('signal');
      expect(cluster).toHaveProperty('sample_ids');
    }
  });

  it('compact mode is smaller than default', () => {
    const full = getTriageSamples({ date: TEST_DAY });
    const compact = getTriageSamples({ date: TEST_DAY, compact: true });
    const fullSize = JSON.stringify(full, null, 2).length;
    const compactSize = JSON.stringify(compact, null, 2).length;
    console.log(`triage_samples: full=${fullSize}, compact=${compactSize}`);
    expect(compactSize).toBeLessThan(fullSize);
  });
});
