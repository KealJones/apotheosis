import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { getSlackDigests, parseDigest, runSlackDigest, type DigestChat } from '../../src/slack/digest.js';
import { getSlackActivity } from '../../src/queries/slackActivity.js';
import { localModelBlockedReason } from '../../src/llm/localGuard.js';
import { unloadModel } from '../../src/llm/ollama.js';

// Far from the fixture's own Slack rows.
const T = 2_000_000_000;
const NOW = T + 3600;
const link = (channel: string, ts: number, threadTs?: number) =>
  `https://acme.slack.com/archives/${channel}/p${ts}000100${threadTs ? `?thread_ts=${threadTs}.000100` : ''}`;

let db: DatabaseSync;
let n = 0;
function insert(at: number, channel: string, sender: string, text: string, permalink: string) {
  db.prepare(`INSERT INTO slack_messages (captured_at, channel, sender, text, permalink, dedupe_hash) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(at, channel, sender, text, permalink, `digest-${n++}`);
}
function config(extra: object) {
  const file = path.join(process.env.DATA_DIR!, 'user-config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...extra }));
}

function fakeChat() {
  const calls: string[] = [];
  const chat: DigestChat = async (messages) => {
    calls.push(messages[1].content);
    return JSON.stringify({ summary: `summary ${calls.length}`, urgency: 'high', my_todos: ['Send the fix'], open_items: [] });
  };
  return { calls, chat };
}

beforeEach(() => {
  db = setupTestDb();
  // A thread I answered in, a DM to me, and a channel thread I only read.
  insert(T, 'team-help', 'Chris Park (He/Him)', 'Users see a license mismatch', link('C01SUP', T));
  insert(T + 60, 'team-help', 'Test User (He/Him)', "I'll send a fix today", link('C01SUP', T + 60, T));
  insert(T + 100, 'Pat Lee (DM)', 'Pat Lee', 'Can you look at my PR?', link('D01PAT', T + 100));
  insert(T + 200, 'frontend', 'Riley Diaz', 'Evals are live', link('C02DST', T + 200));
});
afterEach(() => {
  teardownTestDb();
  vi.unstubAllGlobals();
});

describe('runSlackDigest', () => {
  it('digests threads I posted in and DMs, not threads I only read', async () => {
    const { calls, chat } = fakeChat();
    const report = await runSlackDigest({ now: NOW, chat, model: 'm' });
    expect(report).toEqual({ conversations: 2, digested: 2, unchanged: 0, errors: [] });
    expect(calls.some((c) => c.includes('Evals are live'))).toBe(false);
    expect(calls.some((c) => c.includes("Test User (me): I'll send a fix today"))).toBe(true);
  });

  it('makes no model calls when nothing changed, and re-digests only a changed conversation', async () => {
    const first = fakeChat();
    await runSlackDigest({ now: NOW, chat: first.chat, model: 'm' });

    const second = fakeChat();
    expect(await runSlackDigest({ now: NOW, chat: second.chat, model: 'm' })).toMatchObject({ digested: 0, unchanged: 2 });
    expect(second.calls).toHaveLength(0);

    insert(T + 300, 'team-help', 'Chris Park', 'Thanks!', link('C01SUP', T + 300, T));
    const third = fakeChat();
    expect(await runSlackDigest({ now: NOW, chat: third.chat, model: 'm' })).toMatchObject({ digested: 1, unchanged: 1 });
  });

  it('records a failure without caching it, so the next run retries', async () => {
    const failing: DigestChat = async () => 'not json';
    const report = await runSlackDigest({ now: NOW, chat: failing, model: 'm' });
    expect(report.digested).toBe(0);
    expect(report.errors).toHaveLength(2);
    expect((await runSlackDigest({ now: NOW, chat: fakeChat().chat, model: 'm' })).digested).toBe(2);
  });

  it('skips messages matching slack.ignore_patterns', async () => {
    config({ slack: { ignore_patterns: ['^Can you look'] } });
    expect((await runSlackDigest({ now: NOW, chat: fakeChat().chat, model: 'm' })).conversations).toBe(1);
  });
});

describe('standup Slack threads', () => {
  const thread = () => getSlackActivity({ since: T, until: T + 1000 }, db).my_threads[0];

  it('uses raw text when the feature is off, even if digests exist', async () => {
    await runSlackDigest({ now: NOW, chat: fakeChat().chat, model: 'm' });
    expect(thread().digest).toBeUndefined();
    expect(thread().mine?.[0].text).toBe("I'll send a fix today");
  });

  it('swaps in the digest when it is on and up to date, and falls back to raw when stale', async () => {
    config({ slack: { local_digest: true } });
    expect(thread().root).toBeDefined(); // model hasn't run yet

    await runSlackDigest({ now: NOW, chat: fakeChat().chat, model: 'm' });
    expect(thread().digest?.my_todos).toEqual(['Send the fix']);
    expect(thread().root).toBeUndefined();
    expect(thread().mine).toBeUndefined();

    insert(T + 400, 'team-help', 'Test User', 'Fix is up', link('C01SUP', T + 400, T));
    expect(thread().digest).toBeUndefined();
    expect(thread().mine?.map((m) => m.text)).toEqual(["I'll send a fix today", 'Fix is up']);
  });
});

describe('getSlackDigests', () => {
  it('says so when the feature is off', () => {
    expect(getSlackDigests({ since: T, until: NOW }, db)).toMatchObject({ enabled: false, digests: [] });
  });

  it('returns up-to-date digests and counts the rest as undigested', async () => {
    config({ slack: { local_digest: true } });
    expect(getSlackDigests({ since: T, until: NOW }, db)).toMatchObject({ enabled: true, digests: [], undigested: 2 });
    await runSlackDigest({ now: NOW, chat: fakeChat().chat, model: 'm' });
    const result = getSlackDigests({ since: T, until: NOW }, db);
    expect(result.undigested).toBe(0);
    expect(result.digests.map((d) => d.channel).sort()).toEqual(['Pat Lee (DM)', 'team-help']);
    expect(result.digests[0]).toMatchObject({ urgency: 'high', my_todos: ['Send the fix'] });
  });
});

describe('parseDigest', () => {
  it('fills defaults for a sloppy answer and rejects one with no summary', () => {
    expect(parseDigest('{"summary":" ok ","urgency":"urgent","my_todos":["a",3,""]}'))
      .toEqual({ summary: 'ok', urgency: 'normal', my_todos: ['a'], open_items: [] });
    expect(() => parseDigest('{"urgency":"high"}')).toThrow();
  });
});

describe('localModelBlockedReason', () => {
  it('blocks on battery and on memory pressure', () => {
    expect(localModelBlockedReason({ onBattery: () => false, memoryPressureLevel: () => 1 })).toBeNull();
    expect(localModelBlockedReason({ onBattery: () => true, memoryPressureLevel: () => 1 })).toBe('on battery');
    expect(localModelBlockedReason({ onBattery: () => false, memoryPressureLevel: () => 4 })).toBe('memory pressure (level 4)');
  });
});

describe('unloadModel', () => {
  it('only unloads a model that is loaded', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      new Response(url.endsWith('/api/ps') ? JSON.stringify({ models: [{ name: 'other:1b' }] }) : '{}'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await unloadModel('gemma4:e2b', { baseUrl: 'http://x' })).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async (url: string) =>
      new Response(url.endsWith('/api/ps') ? JSON.stringify({ models: [{ name: 'gemma4:e2b' }] }) : '{}'));
    expect(await unloadModel('gemma4:e2b', { baseUrl: 'http://x' })).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ model: 'gemma4:e2b', keep_alive: 0 });
  });
});
