import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { slackSearch } from '../../src/queries/slackSearch.js';
import { getDb } from '../../src/db.js';
import { DAY_START_ISO } from '../fixtures/seed-test-db.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('slack_search', () => {
  it('returns all messages when no filters given, newest first', () => {
    const data = slackSearch({});
    expect(data.count).toBe(4);
    const times = data.messages.map((m) => m.captured_at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('filters by text query, case-insensitive', () => {
    const data = slackSearch({ q: 'tokenname' });
    expect(data.count).toBe(1);
    expect(data.messages[0].sender).toBe('Test User');
  });

  it('filters by channel substring', () => {
    const data = slackSearch({ channel: 'design-system-help' });
    expect(data.count).toBe(2);
  });

  it('filters by sender substring', () => {
    const data = slackSearch({ sender: 'Morgan' });
    expect(data.count).toBe(1);
    expect(data.messages[0].text).toContain('design-docs PR');
  });

  it('returns the message permalink when captured', () => {
    const data = slackSearch({ sender: 'Morgan' });
    expect(data.messages[0].permalink).toBe('https://acme.slack.com/archives/D04TEST2/p1000000003');
  });

  it('filters by since (excludes prior-day message)', () => {
    const data = slackSearch({ since: DAY_START_ISO });
    expect(data.count).toBe(3);
    const senders = data.messages.map((m) => m.sender);
    expect(senders).not.toContain('Jordan Kim');
  });

  it('combines filters', () => {
    const data = slackSearch({ channel: 'design', sender: 'Sam' });
    expect(data.count).toBe(1);
    expect(data.messages[0].text).toContain('@supportsquad');
  });

  it('respects limit', () => {
    const data = slackSearch({ limit: 2 });
    expect(data.count).toBe(2);
  });

  it('returns empty for non-matching query', () => {
    const data = slackSearch({ q: 'zzzznonexistent' });
    expect(data.count).toBe(0);
    expect(data.messages).toEqual([]);
  });
});

describe('slack_search thread context', () => {
  const link = (ts: string, thread?: string) =>
    `https://acme.slack.com/archives/C0THREAD/p${ts.replace('.', '')}${thread ? `?thread_ts=${thread}&cid=C0THREAD` : ''}`;
  const ROOT = '1700000000.000100';

  beforeAll(() => {
    const insert = getDb().prepare(`
      INSERT INTO slack_messages (captured_at, channel, sender, text, permalink, reactions, reply_count, dedupe_hash)
      VALUES (?, 'eng-thread-test', ?, ?, ?, ?, ?, ?)
    `);
    insert.run(1700000100, 'Robin Gray', 'Should menus cap their height?', link(ROOT), ':eyes: 2', 2, 'thread-root');
    insert.run(1700000200, 'Sam Patel', 'Only via guidance, I think.', link('1700000050.000200', ROOT), null, null, 'thread-r1');
    insert.run(1700000300, 'Test User', 'Agreed, I will write it up.', link('1700000090.000300', ROOT), null, null, 'thread-r2');
  });

  it('labels thread replies and channel kind', () => {
    const [latest] = slackSearch({ channel: 'eng-thread-test', limit: 1 }).messages;
    expect(latest).toMatchObject({ kind: 'channel', thread_reply: true, sent_at: '2023-11-14T22:14:50.000Z' });
    expect(latest.context).toBeUndefined();
  });

  it('returns the thread parent and earlier replies with context', () => {
    const [latest] = slackSearch({ channel: 'eng-thread-test', limit: 1, context: 5 }).messages;
    expect(latest.context?.parent).toMatchObject({ sender: 'Robin Gray', text: 'Should menus cap their height?' });
    expect(latest.context?.before.map((m) => m.sender)).toEqual(['Sam Patel']);
  });

  it('marks DMs', () => {
    const [dm] = slackSearch({ sender: 'Morgan' }).messages;
    expect(dm.kind).toBe('dm');
  });
});
