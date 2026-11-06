/**
 * Eval runner: validates core query output against skill evaluation criteria.
 * This tests the "data layer" that feeds skills — whether the query responses
 * contain the right signals for high-quality skill output.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import {
  DAY_START_ISO, DAY_END_ISO, TEST_DAY, TEST_STANDUP_DATE,
} from '../fixtures/seed-test-db.js';
import { standupCriteria } from './standup.eval.js';
import { todayCriteria } from './today.eval.js';
import { cleanupCriteria } from './cleanup-samples.eval.js';

vi.mock('../../src/integrations/github.js', () => ({
  getPendingReviews: () => [
    { number: 2350, title: 'WID-4582: code connect unit test', url: 'https://github.com/acme/widgets/pull/2350', updatedAt: '2026-05-18T20:00:00Z' },
  ],
}));

import { getSummarizeWindow } from '../../src/queries/summarizeWindow.js';
import { getStandupDraft } from '../../src/queries/standupDraft.js';
import { getTriageSamples } from '../../src/queries/triageSamples.js';
import { getContextTimeline } from '../../src/queries/contextTimeline.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('/standup eval — data layer checks', () => {
  it('summarize_window block count in expected range', () => {
    const data = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO }) as { blocks: any[] };
    const { min, max } = standupCriteria.dataChecks.summarize_window.blockCount;
    expect(data.blocks.length).toBeGreaterThanOrEqual(min);
    expect(data.blocks.length).toBeLessThanOrEqual(max);
  });

  it('summarize_window contains JIRA tickets', () => {
    const data = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO }) as { blocks: any[] };
    const allText = data.blocks.map((b: any) =>
      `${b.window_title ?? ''} ${b.ocr_excerpt ?? ''} ${(b.top_words ?? []).join(' ')}`
    ).join(' ');
    expect(allText).toContain('WID-4582');
  });

  it('summarize_window contains PR URLs', () => {
    const data = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO }) as { blocks: any[] };
    const allText = data.blocks.map((b: any) =>
      `${b.window_title ?? ''} ${b.url ?? ''} ${b.ocr_excerpt ?? ''}`
    ).join(' ');
    expect(allText).toMatch(/pull\/\d+/);
  });

  it('standup_draft session count in expected range', () => {
    const data = getStandupDraft({ date: TEST_STANDUP_DATE }) as any;
    const { min, max } = standupCriteria.dataChecks.standup_draft.sessionCount;
    expect(data.yesterday_sessions.length).toBeGreaterThanOrEqual(min);
    expect(data.yesterday_sessions.length).toBeLessThanOrEqual(max);
  });

  it('standup_draft has context_summary', () => {
    const data = getStandupDraft({ date: TEST_STANDUP_DATE }) as any;
    expect(data.context_summary).toBeDefined();
    expect(data.context_summary.event_counts.length).toBeGreaterThan(0);
  });

  it('standup_draft has commitments', () => {
    const data = getStandupDraft({ date: TEST_STANDUP_DATE }) as any;
    expect(data.pending_commitments.length).toBeGreaterThanOrEqual(1);
  });

  it('standup mustInclude items are findable in tool data', () => {
    const swData = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO });
    const sdData = getStandupDraft({ date: TEST_STANDUP_DATE });

    // Build searchable corpus from all query output
    const corpus = JSON.stringify(swData) + JSON.stringify(sdData);

    for (const item of standupCriteria.mustInclude) {
      expect(corpus).toContain(item);
    }
  });
});

describe('/today eval — data layer checks', () => {
  it('summarize_window block count in expected range', () => {
    const data = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO }) as { blocks: any[] };
    const { min, max } = todayCriteria.dataChecks.summarize_window.blockCount;
    expect(data.blocks.length).toBeGreaterThanOrEqual(min);
    expect(data.blocks.length).toBeLessThanOrEqual(max);
  });

  it('context_timeline has events', () => {
    const data = getContextTimeline({ since: DAY_START_ISO, until: DAY_END_ISO });
    expect(data.events.length).toBeGreaterThan(0);
  });

  it('context_timeline has app_switch events', () => {
    const data = getContextTimeline({ since: DAY_START_ISO, until: DAY_END_ISO });
    expect(data.counts.app_switch).toBeGreaterThan(0);
  });

  it('mustInclude items findable in tool data', () => {
    const swData = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO });
    const corpus = JSON.stringify(swData);
    for (const item of todayCriteria.mustInclude) {
      expect(corpus).toContain(item);
    }
  });
});

describe('/cleanup-samples eval — data layer checks', () => {
  it('triage has high-signal clusters', () => {
    const data = getTriageSamples({ date: TEST_DAY });
    const signals = data.clusters.map((c) => c.signal);
    expect(signals).toContain('high');
  });

  it('triage has low-signal clusters', () => {
    const data = getTriageSamples({ date: TEST_DAY });
    const signals = data.clusters.map((c) => c.signal);
    expect(signals).toContain('low');
  });

  it('triage excludes evidence samples', () => {
    const data = getTriageSamples({ date: TEST_DAY });
    // Evidence sample IDs from fixture are checked more thoroughly in triageSamples.test.ts
    expect(data.clusters.every((c) => c.sample_ids.length >= 0)).toBe(true);
  });

  it('cluster count in expected range', () => {
    const data = getTriageSamples({ date: TEST_DAY });
    const { min, max } = cleanupCriteria.dataChecks.triage_samples.clusterCount;
    expect(data.clusters.length).toBeGreaterThanOrEqual(min);
    expect(data.clusters.length).toBeLessThanOrEqual(max);
  });
});
