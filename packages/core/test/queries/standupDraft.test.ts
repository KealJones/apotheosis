import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { TEST_STANDUP_DATE } from '../fixtures/seed-test-db.js';

// Mock gh CLI — standup_draft calls getPendingReviews() which shells out
vi.mock('../../src/integrations/github.js', () => ({
  getPendingReviews: () => [
    { number: 2350, title: 'WID-4582: code connect unit test', url: 'https://github.com/acme/widgets/pull/2350', updatedAt: '2026-05-18T20:00:00Z' },
  ],
}));

import { getStandupDraft } from '../../src/queries/standupDraft.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('standup_draft', () => {
  it('returns expected top-level fields', () => {
    const data = getStandupDraft({ date: TEST_STANDUP_DATE }) as any;
    expect(data).toHaveProperty('date', TEST_STANDUP_DATE);
    expect(data).toHaveProperty('yesterday');
    expect(data).toHaveProperty('yesterday_blocks');
    expect(data).toHaveProperty('yesterday_sessions');
    expect(data).toHaveProperty('pending_commitments');
    expect(data).toHaveProperty('open_prs');
    expect(data).toHaveProperty('recent_ideas');
    expect(data).toHaveProperty('context_summary');
  });

  it('yesterday_sessions merges blocks into reasonable count', () => {
    const data = getStandupDraft({ date: TEST_STANDUP_DATE }) as any;
    expect(data.yesterday_sessions.length).toBeGreaterThanOrEqual(3);
    expect(data.yesterday_sessions.length).toBeLessThanOrEqual(20);
  });

  it('sessions contain metadata with JIRA tickets', () => {
    const data = getStandupDraft({ date: TEST_STANDUP_DATE }) as any;
    const allTickets = data.yesterday_sessions.flatMap(
      (s: any) => s.metadata?.jira_tickets ?? []
    );
    expect(allTickets).toContain('WID-4582');
  });

  it('sessions contain PR URLs in metadata', () => {
    const data = getStandupDraft({ date: TEST_STANDUP_DATE }) as any;
    const allPrs = data.yesterday_sessions.flatMap(
      (s: any) => s.metadata?.pr_urls ?? []
    );
    expect(allPrs.some((url: string) => url.includes('pull/2350'))).toBe(true);
  });

  it('includes pending follow-ups', () => {
    const data = getStandupDraft({ date: TEST_STANDUP_DATE }) as any;
    expect(data.pending_commitments.length).toBeGreaterThanOrEqual(1);
    expect(data.pending_commitments[0]).toHaveProperty('source', 'mention');
  });

  it('includes open PRs from mocked gh CLI', () => {
    const data = getStandupDraft({ date: TEST_STANDUP_DATE }) as any;
    expect(data.open_prs.length).toBe(1);
    expect(data.open_prs[0].number).toBe(2350);
  });

  it('context_summary includes event counts and modified files', () => {
    const data = getStandupDraft({ date: TEST_STANDUP_DATE }) as any;
    expect(data.context_summary.event_counts.length).toBeGreaterThan(0);
    expect(data.context_summary.files_modified.length).toBeGreaterThan(0);
  });

  it('sessions do not contain sample_ids', () => {
    const data = getStandupDraft({ date: TEST_STANDUP_DATE }) as any;
    for (const s of data.yesterday_sessions) {
      expect(s).not.toHaveProperty('sample_ids');
      expect(s).toHaveProperty('sample_count');
    }
  });

  it('blocks do not contain sample_ids', () => {
    const data = getStandupDraft({ date: TEST_STANDUP_DATE }) as any;
    for (const b of data.yesterday_blocks) {
      expect(b).not.toHaveProperty('sample_ids');
      expect(b).toHaveProperty('sample_count');
    }
  });

  it('response size baseline', () => {
    const data = getStandupDraft({ date: TEST_STANDUP_DATE });
    const size = JSON.stringify(data, null, 2).length;
    expect(size).toBeGreaterThan(1000);
    console.log(`standup_draft: ${size} chars`);
  });

  // ── Compact mode tests ──────────────────────────────────────────────────
  it('compact mode omits yesterday_blocks', () => {
    const data = getStandupDraft({ date: TEST_STANDUP_DATE, compact: true }) as any;
    expect(data.yesterday_blocks).toBeUndefined();
    expect(data.yesterday_sessions).toBeDefined();
    expect(data.yesterday_sessions.length).toBeGreaterThan(0);
  });

  it('compact mode is significantly smaller', () => {
    const full = getStandupDraft({ date: TEST_STANDUP_DATE });
    const compact = getStandupDraft({ date: TEST_STANDUP_DATE, compact: true });
    const fullSize = JSON.stringify(full, null, 2).length;
    const compactSize = JSON.stringify(compact, null, 2).length;
    console.log(`standup_draft: full=${fullSize}, compact=${compactSize}, ratio=${(compactSize / fullSize * 100).toFixed(1)}%`);
    expect(compactSize).toBeLessThan(fullSize);
  });

  it('compact mode preserves metadata in sessions', () => {
    const data = getStandupDraft({ date: TEST_STANDUP_DATE, compact: true }) as any;
    const allTickets = data.yesterday_sessions.flatMap(
      (s: any) => s.metadata?.jira_tickets ?? []
    );
    expect(allTickets).toContain('WID-4582');
  });
});
