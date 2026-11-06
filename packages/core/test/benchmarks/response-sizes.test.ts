/**
 * Response size baselines for the 4 heaviest MCP tools (measured at the core
 * query layer — the MCP tool wrapper only adds `JSON.stringify(data, null, 2)`
 * on top of this, so sizes here are directly comparable to the wire size).
 * Run with: npm run test:baseline
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import {
  DAY_START_ISO, DAY_END_ISO, TEST_DAY, TEST_STANDUP_DATE,
} from '../fixtures/seed-test-db.js';

// Mock gh CLI for standup_draft
vi.mock('../../src/integrations/github.js', () => ({
  getPendingReviews: () => [
    { number: 2350, title: 'WID-4582: code connect unit test', url: 'https://github.com/acme/widgets/pull/2350', updatedAt: '2026-05-18T20:00:00Z' },
  ],
}));

import { getSummarizeWindow } from '../../src/queries/summarizeWindow.js';
import { getStandupDraft } from '../../src/queries/standupDraft.js';
import { getTriageSamples } from '../../src/queries/triageSamples.js';
import { getMentions } from '../../src/queries/mentions.js';
import { getRecentActivity } from '../../src/queries/recentActivity.js';
import { getContextTimeline } from '../../src/queries/contextTimeline.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

function getSize(data: unknown): number {
  return JSON.stringify(data, null, 2).length;
}

describe('response size baselines', () => {
  it('summarize_window — full day', () => {
    const size = getSize(getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO }));
    console.log(`  summarize_window: ${size} chars (${(size / 1024).toFixed(1)} KB)`);
    expect(size).toBeGreaterThan(0);
  });

  it('standup_draft — full standup', () => {
    const size = getSize(getStandupDraft({ date: TEST_STANDUP_DATE }));
    console.log(`  standup_draft: ${size} chars (${(size / 1024).toFixed(1)} KB)`);
    expect(size).toBeGreaterThan(0);
  });

  it('triage_samples — full day', () => {
    const size = getSize(getTriageSamples({ date: TEST_DAY }));
    console.log(`  triage_samples: ${size} chars (${(size / 1024).toFixed(1)} KB)`);
    expect(size).toBeGreaterThan(0);
  });

  it('mentions — full day', () => {
    const size = getSize(getMentions({ since: DAY_START_ISO }));
    console.log(`  mentions: ${size} chars (${(size / 1024).toFixed(1)} KB)`);
    expect(size).toBeGreaterThan(0);
  });

  it('recent_activity — full day', () => {
    const size = getSize(getRecentActivity({ since: DAY_START_ISO, until: DAY_END_ISO }));
    console.log(`  recent_activity: ${size} chars (${(size / 1024).toFixed(1)} KB)`);
    expect(size).toBeGreaterThan(0);
  });

  it('context_timeline — full day', () => {
    const size = getSize(getContextTimeline({ since: DAY_START_ISO, until: DAY_END_ISO }));
    console.log(`  context_timeline: ${size} chars (${(size / 1024).toFixed(1)} KB)`);
    expect(size).toBeGreaterThan(0);
  });
});
