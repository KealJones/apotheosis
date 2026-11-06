import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { getRecentActivity } from '../../src/queries/recentActivity.js';
import { DAY_START_ISO, DAY_END_ISO } from '../fixtures/seed-test-db.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('recent_activity', () => {
  it('returns samples with expected fields', () => {
    const data = getRecentActivity({ since: DAY_START_ISO, until: DAY_END_ISO });
    expect(data.samples.length).toBeGreaterThan(0);
    const sample = data.samples[0];
    expect(sample).toHaveProperty('id');
    expect(sample).toHaveProperty('time');
    expect(sample).toHaveProperty('app_name');
    expect(sample).toHaveProperty('window_title');
    expect(sample).toHaveProperty('ocr_excerpt');
  });

  it('filters by app name', () => {
    const data = getRecentActivity({ since: DAY_START_ISO, until: DAY_END_ISO, app: 'Slack' });
    expect(data.samples.length).toBeGreaterThan(0);
    expect(data.samples.every((s) => s.app_name === 'Slack')).toBe(true);
  });

  it('respects 200 row LIMIT', () => {
    const data = getRecentActivity({ since: DAY_START_ISO, until: DAY_END_ISO });
    // Our fixture has 193 samples, all should be returned
    expect(data.samples.length).toBeLessThanOrEqual(200);
    expect(data.samples.length).toBe(193);
  });

  it('returns empty for out-of-range query', () => {
    const data = getRecentActivity({ since: '2020-01-01T00:00:00Z', until: '2020-01-01T01:00:00Z' });
    expect(data.samples).toEqual([]);
  });

  it('response size baseline', () => {
    const data = getRecentActivity({ since: DAY_START_ISO, until: DAY_END_ISO });
    const size = JSON.stringify(data, null, 2).length;
    expect(size).toBeGreaterThan(1000);
    console.log(`recent_activity: ${size} chars`);
  });
});
