import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { getSummarizeWindow } from '../../src/queries/summarizeWindow.js';
import { DAY_START_ISO, DAY_END_ISO } from '../fixtures/seed-test-db.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('summarize_window', () => {
  it('returns blocks with expected fields', () => {
    const data = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO }) as { blocks: any[] };
    expect(data.blocks).toBeDefined();
    expect(data.blocks.length).toBeGreaterThan(0);

    const block = data.blocks[0];
    expect(block).toHaveProperty('start');
    expect(block).toHaveProperty('end');
    expect(block).toHaveProperty('duration_min');
    expect(block).toHaveProperty('app_name');
    expect(block).toHaveProperty('app_bundle');
    expect(block).toHaveProperty('window_title');
    expect(block).toHaveProperty('top_words');
    expect(block).toHaveProperty('ocr_excerpt');
    expect(block).toHaveProperty('sample_ids');
    expect(block).toHaveProperty('sample_count');
  });

  it('groups samples into reasonable block count', () => {
    const data = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO }) as { blocks: any[] };
    // 193 samples across 12 sessions should produce roughly 12-20 blocks
    expect(data.blocks.length).toBeGreaterThanOrEqual(8);
    expect(data.blocks.length).toBeLessThanOrEqual(25);
  });

  it('extracts JIRA tickets from OCR text into top_words or block context', () => {
    const data = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO }) as { blocks: any[] };
    const allText = data.blocks.map((b: any) =>
      `${b.window_title} ${b.ocr_excerpt} ${b.top_words.join(' ')}`
    ).join(' ');
    expect(allText).toContain('WID-4582');
  });

  it('includes PR URL in block data', () => {
    const data = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO }) as { blocks: any[] };
    const prBlock = data.blocks.find((b: any) =>
      b.window_title?.includes('Pull Request #2350') || b.url?.includes('pull/2350')
    );
    expect(prBlock).toBeDefined();
  });

  it('returns empty blocks for a window with no samples', () => {
    const data = getSummarizeWindow({
      since: '2020-01-01T00:00:00Z',
      until: '2020-01-01T01:00:00Z',
    }) as { blocks: any[] };
    expect(data.blocks).toEqual([]);
  });

  it('response size baseline for full day', () => {
    const data = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO });
    const size = JSON.stringify(data, null, 2).length;
    expect(size).toBeGreaterThan(1000);
    console.log(`summarize_window full day: ${size} chars`);
  });

  // ── Compact mode tests ──────────────────────────────────────────────────
  it('compact mode omits ocr_excerpt and selected_texts', () => {
    const data = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO, compact: true }) as { blocks: any[] };
    expect(data.blocks.length).toBeGreaterThan(0);
    for (const block of data.blocks) {
      expect(block.ocr_excerpt).toBe('');
      expect(block.selected_texts).toEqual([]);
      expect(block.focused_elements).toEqual([]);
    }
  });

  it('compact mode preserves top_words and metadata', () => {
    const data = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO, compact: true }) as { blocks: any[] };
    const block = data.blocks[0];
    expect(block.top_words).toBeDefined();
    expect(Array.isArray(block.top_words)).toBe(true);
    expect(block.sample_ids).toBeDefined();
    expect(block.metadata).toBeDefined();
    expect(block.metadata).toHaveProperty('jira_tickets');
    expect(block.metadata).toHaveProperty('pr_urls');
  });

  it('compact response is significantly smaller than default', () => {
    const full = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO });
    const compact = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO, compact: true });
    const fullSize = JSON.stringify(full, null, 2).length;
    const compactSize = JSON.stringify(compact, null, 2).length;
    console.log(`summarize_window: full=${fullSize}, compact=${compactSize}, ratio=${(compactSize / fullSize * 100).toFixed(1)}%`);
    expect(compactSize).toBeLessThan(fullSize * 0.75); // At least 25% smaller (session cleaning benefits both modes)
  });

  it('min_duration_min filters short blocks', () => {
    const all = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO }) as { blocks: any[] };
    const filtered = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO, min_duration_min: 3 }) as { blocks: any[] };
    expect(filtered.blocks.length).toBeLessThan(all.blocks.length);
    for (const block of filtered.blocks) {
      expect(block.duration_min).toBeGreaterThanOrEqual(3);
    }
  });

  it('merge_gap_min returns sessions instead of blocks', () => {
    const data = getSummarizeWindow({ since: DAY_START_ISO, until: DAY_END_ISO, merge_gap_min: 5 }) as { sessions: any[]; blocks?: any[] };
    expect(data.sessions).toBeDefined();
    expect(data.blocks).toBeUndefined();
    expect(data.sessions.length).toBeGreaterThan(0);
    const session = data.sessions[0];
    expect(session).toHaveProperty('window_titles');
    expect(session).toHaveProperty('block_count');
    expect(session).toHaveProperty('metadata');
  });
});
