import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers/setup.js';
import { logUsage, summarizeArgs } from '../src/usage.js';
import { getUsageStats } from '../src/queries/usageStats.js';

let db: ReturnType<typeof setupTestDb>;

beforeAll(() => { db = setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('usage tracking', () => {
  it('logUsage records a skill invocation', () => {
    logUsage('skill', 'standup', 'monday');

    const row = db.prepare('SELECT * FROM tool_usage WHERE kind = ? AND name = ?').get('skill', 'standup') as any;
    expect(row).toBeDefined();
    expect(row.args_summary).toBe('monday');
  });

  it('logUsage() records tool calls directly', () => {
    logUsage('tool', 'summarize_window', 'since:"2026-05-18T00:00:00Z"', 150);
    logUsage('tool', 'summarize_window', 'since:"2026-05-19T00:00:00Z"', 200);
    logUsage('tool', 'standup_draft', 'compact:true', 80);

    const rows = db.prepare('SELECT * FROM tool_usage WHERE kind = ?').all('tool') as any[];
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it('usage_stats returns totals and per-name breakdown', () => {
    const data = getUsageStats({});
    expect(data.totals).toBeDefined();
    expect(data.by_name).toBeDefined();
    expect(data.by_name.length).toBeGreaterThan(0);

    const swEntry = data.by_name.find((e) => e.name === 'summarize_window');
    expect(swEntry).toBeDefined();
    expect(swEntry!.total_calls).toBeGreaterThanOrEqual(2);
    expect(swEntry!.avg_duration_ms).toBeDefined();
  });

  it('usage_stats filters by kind', () => {
    const skillOnly = getUsageStats({ kind: 'skill' });
    expect(skillOnly.by_name.every((e) => e.kind === 'skill')).toBe(true);
  });

  it('summarizeArgs handles various arg types', () => {
    expect(summarizeArgs({ since: '2026-05-18', compact: true })).toContain('since');
    expect(summarizeArgs({ since: '2026-05-18', compact: true })).toContain('compact');
    expect(summarizeArgs({ ids: [1, 2, 3] })).toContain('[3 items]');
    expect(summarizeArgs({ long: 'x'.repeat(200) })).toContain('200 chars');
  });
});
