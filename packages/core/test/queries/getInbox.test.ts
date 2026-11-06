import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { DAY_START_ISO } from '../fixtures/seed-test-db.js';

// Mock gh CLI
vi.mock('../../src/integrations/github.js', () => ({
  getPendingReviews: () => [
    { number: 2350, title: 'WID-4582: code connect unit test', url: 'https://github.com/acme/widgets/pull/2350', updatedAt: '2026-05-18T20:00:00Z' },
  ],
}));

import { getInbox } from '../../src/queries/getInbox.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('get_inbox', () => {
  it('returns all three sections', () => {
    const data = getInbox({ mentions_since: DAY_START_ISO });
    expect(data).toHaveProperty('mentions');
    expect(data).toHaveProperty('pending_reviews');
    expect(data).toHaveProperty('open_commitments');
    expect(data).toHaveProperty('summary');
  });

  it('includes compact mention groups', () => {
    const data = getInbox({ mentions_since: DAY_START_ISO });
    expect(data.mentions.length).toBeGreaterThanOrEqual(1);
    const group = data.mentions[0];
    expect(group).toHaveProperty('mention_count');
    expect(group).toHaveProperty('first_seen');
    expect(group).toHaveProperty('last_seen');
    // Should NOT have full mentions array
    expect(group).not.toHaveProperty('mentions');
  });

  it('includes pending reviews from mocked gh', () => {
    const data = getInbox({ mentions_since: DAY_START_ISO });
    expect(data.pending_reviews.length).toBe(1);
    expect(data.pending_reviews[0].number).toBe(2350);
  });

  it('includes open follow-ups', () => {
    const data = getInbox({ mentions_since: DAY_START_ISO });
    expect(data.open_commitments.length).toBeGreaterThanOrEqual(1);
    expect(data.open_commitments[0]).toHaveProperty('source');
    expect(data.open_commitments[0]).toHaveProperty('detected_at');
  });

  it('summary has correct totals', () => {
    const data = getInbox({ mentions_since: DAY_START_ISO });
    expect(data.summary.total_mentions).toBeGreaterThanOrEqual(1);
    expect(data.summary.total_prs).toBe(1);
    expect(data.summary.total_commitments).toBeGreaterThanOrEqual(1);
  });

  it('response fits in LLM context (small size)', () => {
    const data = getInbox({ mentions_since: DAY_START_ISO });
    const size = JSON.stringify(data, null, 2).length;
    console.log(`get_inbox: ${size} chars`);
    // Should be well under 10K
    expect(size).toBeLessThan(10000);
  });
});
