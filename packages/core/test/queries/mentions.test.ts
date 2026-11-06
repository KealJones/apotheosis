import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { getMentions, GroupedMention, CompactGroupedMention } from '../../src/queries/mentions.js';
import { DAY_START_ISO } from '../fixtures/seed-test-db.js';

let db: ReturnType<typeof setupTestDb>;

beforeAll(() => { db = setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('mentions', () => {
  it('finds @testuser mention in Slack OCR', () => {
    const data = getMentions({ since: DAY_START_ISO }) as GroupedMention[];
    // mentions returns an array of groups directly
    expect(data.length).toBeGreaterThanOrEqual(1);
    const slackGroup = data.find((g) => g.app_name === 'Slack');
    expect(slackGroup).toBeDefined();
  });

  it('returns mention groups with expected fields', () => {
    const data = getMentions({ since: DAY_START_ISO }) as GroupedMention[];
    const group = data[0];
    expect(group).toHaveProperty('app_name');
    expect(group).toHaveProperty('window_title');
    expect(group).toHaveProperty('mention_count');
    expect(group).toHaveProperty('mentions');
    expect(group.mentions.length).toBeGreaterThan(0);
  });

  it('mention entries have context excerpts', () => {
    const data = getMentions({ since: DAY_START_ISO }) as GroupedMention[];
    const mention = data[0].mentions[0];
    expect(mention).toHaveProperty('context_excerpt');
    expect(mention).toHaveProperty('when');
    expect(mention).toHaveProperty('match');
  });

  it('returns empty array when since is after all data', () => {
    // mentions has no upper bound — use a since far in the future
    const data = getMentions({ since: '2030-01-01T00:00:00Z' });
    expect(data).toEqual([]);
  });

  it('response size baseline', () => {
    const data = getMentions({ since: DAY_START_ISO });
    const size = JSON.stringify(data, null, 2).length;
    expect(size).toBeGreaterThan(0);
    console.log(`mentions: ${size} chars`);
  });

  // ── Compact mode tests ──────────────────────────────────────────────────
  it('compact mode returns group summaries without individual mentions', () => {
    const data = getMentions({ since: DAY_START_ISO, compact: true }) as CompactGroupedMention[];
    expect(data.length).toBeGreaterThanOrEqual(1);
    const group = data[0];
    expect(group).toHaveProperty('mention_count');
    expect(group).toHaveProperty('first_seen');
    expect(group).toHaveProperty('last_seen');
    expect(group).not.toHaveProperty('mentions');
  });

  it('compact mode is smaller than default', () => {
    const full = getMentions({ since: DAY_START_ISO });
    const compact = getMentions({ since: DAY_START_ISO, compact: true });
    const fullSize = JSON.stringify(full, null, 2).length;
    const compactSize = JSON.stringify(compact, null, 2).length;
    console.log(`mentions: full=${fullSize}, compact=${compactSize}`);
    expect(compactSize).toBeLessThan(fullSize);
  });
});
