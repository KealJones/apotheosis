import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { getSlackActivity } from '../../src/queries/slackActivity.js';

// Far from the fixture's own Slack rows so the range below only sees these.
const T = 2_000_000_000;
const link = (channel: string, ts: number, threadTs?: number) =>
  `https://acme.slack.com/archives/${channel}/p${ts}000100${threadTs ? `?thread_ts=${threadTs}.000100` : ''}`;

let db: DatabaseSync;

beforeAll(() => {
  db = setupTestDb();
  const insert = db.prepare(`
    INSERT INTO slack_messages (captured_at, channel, sender, text, permalink, dedupe_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const rows: [number, string, string, string, string][] = [
    // A support thread I answered in
    [T, 'team-help', 'Chris Park (He/Him)', 'Users see a MUI X license mismatch', link('C01SUP', T)],
    [T + 60, 'team-help', 'Test User (He/Him)', 'Found the cause: one global key', link('C01SUP', T + 60, T)],
    [T + 120, 'team-help', 'Pat Lee', 'Thanks!', link('C01SUP', T + 120, T)],
    // A thread I only read
    [T + 200, 'frontend', 'Riley Diaz', 'MCP evals are live', link('C02DST', T + 200)],
    [T + 260, 'frontend', 'Drew Cole', 'Nice', link('C02DST', T + 260, T + 200)],
    // Outside the range
    [T + 10_000, 'team-help', 'Test User', 'Later message', link('C01SUP', T + 10_000)],
  ];
  rows.forEach((r, i) => insert.run(...r, `activity-${i}`));
});
afterAll(() => { teardownTestDb(); });

describe('getSlackActivity', () => {
  const result = () => getSlackActivity({ since: T, until: T + 1000 }, db);

  it('groups a thread I posted in with its root, my messages and the other people', () => {
    const { my_threads } = result();
    expect(my_threads).toHaveLength(1);
    const [thread] = my_threads;
    expect(thread.channel).toBe('team-help');
    expect(thread.root.who).toBe('Chris Park');
    expect(thread.mine.map((m) => m.text)).toEqual(['Found the cause: one global key']);
    expect(thread.others).toEqual(['Chris Park', 'Pat Lee']);
    expect(thread.message_count).toBe(3);
  });

  it('counts conversations I only read', () => {
    expect(result().read).toEqual([{ channel: 'frontend', kind: 'channel', message_count: 2 }]);
  });

  it('leaves out messages sent after the range', () => {
    const texts = result().my_threads.flatMap((t) => t.mine.map((m) => m.text));
    expect(texts).not.toContain('Later message');
  });
});
