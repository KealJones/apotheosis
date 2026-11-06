import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock('../../../src/llm/ollama.js', () => ({
  chat: mocks.chat,
  getOllamaModel: () => 'test-model',
  isAvailable: async () => true,
}));

import { getDb, _resetDb, type Db } from '../../../src/db.js';
import { runDetectors, type Commitment } from '../../../src/commitments/index.js';
import { slackAsk } from '../../../src/commitments/detectors/slackAsk.js';
import { slackPromise } from '../../../src/commitments/detectors/slackPromise.js';
import { slackUnanswered, waitsOnMe } from '../../../src/commitments/detectors/slackUnanswered.js';
import {
  inboundPrefilter,
  laterReplyFromMe,
  parsePermalink,
  promisePrefilter,
  toMessage,
  type SlackIdentity,
} from '../../../src/commitments/detectors/slackMessages.js';
import { classify, groundQuote, parseClassification } from '../../../src/commitments/detectors/slackClassify.js';
import type { DetectorCache } from '../../../src/commitments/types.js';

const ID: SlackIdentity = { name: 'Test User', patterns: ['@testuser', 'test user'] };
const NOW = 1_790_000_000;
let seq = 0;

/** A message row as capture writes it. ts = seconds; thread = parent ts seconds. */
function row(o: { sender: string; text: string; channel?: string; chan?: string; ts?: number; thread?: number }) {
  const ts = o.ts ?? NOW - 86_400;
  const chan = o.chan ?? 'D0DM1';
  ++seq;
  const p = `${ts}000000`;
  const permalink = `https://x.slack.com/archives/${chan}/p${p}${o.thread ? `?thread_ts=${o.thread}.000000&cid=${chan}` : ''}`;
  return {
    id: seq,
    dedupe_hash: `hash-${seq}`,
    channel: o.channel ?? 'Robin Gray (He/Him) (DM)',
    sender: o.sender,
    text: o.text,
    permalink,
    captured_at: ts + 60,
  };
}
const msg = (o: Parameters<typeof row>[0]) => toMessage(row(o), ID);
const ME = 'Test User (He/Him)';

describe('promise prefilter', () => {
  const yes = [
    "I'll take a look after lunch",
    'ill write that up tomorrow',
    'I will send the doc',
    'im gonna fix the flaky test',
    'lemme bump that version',
    'let me dig into it',
    'on my list for this week',
    'yep, will do',
    'i can take the migration ticket',
    'did a code review, will qa after',
    'ima approve and merge',
    'happy to review tonight',
    'I’ll follow up', // curly apostrophe
  ];
  const no = [
    'let me know if that works',
    'I was ill last week',
    'thanks!',
    'that PR looks good to me',
    'can you review this?',
    'lol',
  ];
  it.each(yes)('passes %j', (text) => expect(promisePrefilter(msg({ sender: ME, text }))).toBe(true));
  it.each(no)('rejects %j', (text) => expect(promisePrefilter(msg({ sender: ME, text }))).toBe(false));
  it("ignores other people's promises", () => {
    expect(promisePrefilter(msg({ sender: 'Robin Gray (He/Him)', text: "I'll take a look" }))).toBe(false);
  });
});

describe('inbound prefilter', () => {
  const none = new Set<string>();
  it('1:1 DM request passes as dm', () => {
    expect(inboundPrefilter(msg({ sender: 'Alex', text: 'can you review my PR?' }), ID, none)).toBe('dm');
  });
  it('channel mention passes as mention', () => {
    const m = msg({ sender: 'Alex', chan: 'C0CHAN', channel: 'eng', text: '@testuser mind taking a look?' });
    expect(inboundPrefilter(m, ID, none)).toBe('mention');
  });
  it('group DM passes as group_dm', () => {
    const m = msg({ sender: 'Alex', chan: 'C0GRP', channel: 'Alex, Jordan (DM)', text: 'thoughts?' });
    expect(inboundPrefilter(m, ID, none)).toBe('group_dm');
  });
  it('reply in a thread I posted in passes as my_thread', () => {
    const root = msg({ sender: ME, chan: 'C0CHAN', channel: 'eng', text: 'here is the plan', ts: NOW - 5000 });
    const reply = msg({ sender: 'Alex', chan: 'C0CHAN', channel: 'eng', text: 'why not X?', ts: NOW - 4000, thread: NOW - 5000 });
    expect(inboundPrefilter(reply, ID, new Set([root.thread]))).toBe('my_thread');
  });
  it('rejects undirected channel chatter, FYIs in DMs, my own messages, and bots', () => {
    expect(inboundPrefilter(msg({ sender: 'Alex', chan: 'C0CHAN', channel: 'eng', text: 'anyone know why CI is red?' }), ID, none)).toBeNull();
    expect(inboundPrefilter(msg({ sender: 'Alex', text: 'merged it' }), ID, none)).toBeNull();
    expect(inboundPrefilter(msg({ sender: ME, text: 'can you review?' }), ID, none)).toBeNull();
    expect(inboundPrefilter(msg({ sender: 'GitHub', text: 'review requested?' }), ID, none)).toBeNull();
  });
});

describe('threads and replies', () => {
  it('parses channel, ts and thread_ts from a permalink', () => {
    expect(parsePermalink('https://w.slack.com/archives/C0123ABCDEF/p1781112632462169?thread_ts=1781112630.069589&cid=C0123ABCDEF')).toEqual({
      channelId: 'C0123ABCDEF',
      ts: '1781112632.462169',
      threadTs: '1781112630.069589',
    });
    expect(parsePermalink(null)).toBeNull();
  });

  it('a later DM message from me counts as a reply; an earlier one does not', () => {
    const q = msg({ sender: 'Alex', text: 'when is the release?', ts: NOW - 5000 });
    const before = msg({ sender: ME, text: 'hey', ts: NOW - 6000 });
    const after = msg({ sender: ME, text: 'friday', ts: NOW - 4000 });
    expect(laterReplyFromMe(q, [before])).toBeNull();
    expect(laterReplyFromMe(q, [before, after])).toBe(after);
  });

  it('thread replies only count in the same thread', () => {
    const q = msg({ sender: 'Alex', chan: 'C1', channel: 'eng', text: 'ok?', ts: NOW - 5000, thread: NOW - 9000 });
    const elsewhere = msg({ sender: ME, chan: 'C1', channel: 'eng', text: 'unrelated', ts: NOW - 4000 });
    const inThread = msg({ sender: ME, chan: 'C1', channel: 'eng', text: 'yes', ts: NOW - 3000, thread: NOW - 9000 });
    expect(laterReplyFromMe(q, [elsewhere])).toBeNull();
    expect(laterReplyFromMe(q, [elsewhere, inThread])).toBe(inThread);
  });
});

describe('waitsOnMe (slack_unanswered scope)', () => {
  const c = { is_commitment: false, expects_reply: true, title: 't', confidence: 0.9, quote: 'q' };
  const inChannel = (text: string) => msg({ sender: 'Alex', chan: 'C1', channel: 'eng', text });
  it('DMs and group DMs always qualify', () => {
    expect(waitsOnMe({ m: msg({ sender: 'Alex', text: 'when?' }), c, how: 'dm' }, ID)).toBe(true);
    expect(waitsOnMe({ m: msg({ sender: 'Alex', text: 'when?' }), c, how: 'group_dm' }, ID)).toBe(true);
  });
  it('channel mentions qualify only when nobody else is @-addressed', () => {
    expect(waitsOnMe({ m: inChannel('@testuser when does it ship?'), c, how: 'mention' }, ID)).toBe(true);
    expect(waitsOnMe({ m: inChannel('thanks @testuser! @brandon.craig want to change the copy?'), c, how: 'mention' }, ID)).toBe(false);
  });
  it('threads I merely posted in never qualify', () => {
    expect(waitsOnMe({ m: inChannel('correct?'), c, how: 'my_thread' }, ID)).toBe(false);
  });
});

describe('classifier', () => {
  it('grounds quotes verbatim, tolerating re-added apostrophes/case, rejecting inventions', () => {
    const text = 'yeah ill take a look tonight';
    expect(groundQuote('ill take a look', text)).toBe('ill take a look');
    expect(groundQuote("I'll take a look", text)).toBe('ill take a look');
    expect(groundQuote('I will review it tomorrow', text)).toBeNull();
  });

  it('turns a positive with a hallucinated quote into a negative', () => {
    const c = parseClassification(
      JSON.stringify({ is_commitment: true, title: 'Review', confidence: 0.9, quote: 'I promise to review' }),
      'sounds good',
    );
    expect(c).toMatchObject({ is_commitment: false, confidence: 0 });
  });

  it('throws on non-JSON so the failure is not cached', () => {
    expect(() => parseClassification('sure thing!', 'x')).toThrow(/non-JSON/);
  });

  it('memoizes by message and prompt version', async () => {
    const store = new Map<string, string>();
    const cache: DetectorCache = { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) };
    const chat = vi.fn(async () => JSON.stringify({ is_commitment: true, title: 'Fix it', confidence: 0.9, quote: 'ill fix it' }));
    const m = msg({ sender: ME, text: 'ill fix it' });
    const a = await classify('outbound', m, () => [], { cache, chat, model: 'm' });
    const b = await classify('outbound', m, () => [], { cache, chat, model: 'm' });
    expect(a).toEqual(b);
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

// ── End to end through runDetectors ─────────────────────────────────────────

/** Canned model answers keyed by a substring of the TARGET text. */
const ANSWERS: Array<[string, object]> = [
  ["I'll write up the migration plan by Friday", { is_commitment: true, title: 'Write up the migration plan', counterparty: 'Alex', due_hint: 'by Friday', confidence: 0.9, quote: "I'll write up the migration plan by Friday" }],
  ["I'll be out tomorrow", { is_commitment: false, title: '', confidence: 0.95, quote: "I'll be out tomorrow" }],
  ['can you review my PR', { is_commitment: true, expects_reply: false, title: "Review Alex's PR", counterparty: 'Alex', confidence: 0.9, quote: 'can you review my PR' }],
  ['when does the release go out?', { is_commitment: false, expects_reply: true, title: 'Answer Alex about the release date', counterparty: 'Alex', confidence: 0.85, quote: 'when does the release go out?' }],
  // Answered in the same breath by my promise below, so the ask is real but already handled.
  ['can we get a plan for the db migration?', { is_commitment: true, expects_reply: false, title: 'Plan the db migration', counterparty: 'Alex', confidence: 0.55, quote: 'can we get a plan for the db migration?' }],
  ['how was your weekend?', { is_commitment: false, expects_reply: false, title: '', confidence: 0.9, quote: 'how was your weekend?' }],
];

function fakeChat(messages: Array<{ role: string; content: string }>): Promise<string> {
  const target = messages[messages.length - 1].content.split('TARGET').pop()!;
  const hit = ANSWERS.find(([k]) => target.includes(k));
  if (!hit) throw new Error(`no canned answer for: ${target}`);
  return Promise.resolve(JSON.stringify(hit[1]));
}

let tempDir: string;
let originalDataDir: string | undefined;
let db: Db;

function insert(o: Parameters<typeof row>[0]) {
  const r = row(o);
  db.prepare(`INSERT INTO slack_messages (captured_at, channel, sender, text, permalink, dedupe_hash) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(r.captured_at, r.channel, r.sender, r.text, r.permalink, r.dedupe_hash);
  return r;
}
const rows = (source: string) =>
  db.prepare('SELECT * FROM commitments WHERE source = ? ORDER BY id').all(source) as unknown as Commitment[];

beforeEach(() => {
  originalDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-slack-'));
  fs.writeFileSync(path.join(tempDir, 'user-config.json'), JSON.stringify({ display_name: 'Test User', mention_patterns: ['@testuser'] }));
  process.env.DATA_DIR = tempDir;
  _resetDb();
  db = getDb();
  mocks.chat.mockReset().mockImplementation(fakeChat);
});

afterEach(() => {
  _resetDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
  else delete process.env.DATA_DIR;
});

describe('slack detectors via runDetectors', () => {
  const DETECTORS = [slackPromise, slackAsk, slackUnanswered];

  function seed() {
    insert({ sender: 'Robin Gray (He/Him)', text: 'can we get a plan for the db migration?', ts: NOW - 30_000 });
    const promise = insert({ sender: ME, text: "sure, I'll write up the migration plan by Friday", ts: NOW - 29_000 });
    insert({ sender: ME, text: "I'll be out tomorrow btw", ts: NOW - 28_900 });
    const ask = insert({ sender: 'Robin Gray (He/Him)', text: 'also can you review my PR when you get a sec', ts: NOW - 28_000 });
    const question = insert({ sender: 'Robin Gray (He/Him)', text: 'and when does the release go out?', ts: NOW - 27_000 });
    insert({ sender: 'Robin Gray (He/Him)', text: 'how was your weekend?', ts: NOW - 26_900 });
    insert({ sender: 'Robin Gray (He/Him)', chan: 'C0CHAN', channel: 'general', text: 'anyone want lunch?', ts: NOW - 26_000 });
    insert({ sender: ME, text: 'ok', ts: NOW - 27_500 }); // before the question: not a reply to it
    return { promise, ask, question };
  }

  it('emits one row per detector with the grounded quote in detail', async () => {
    const { promise, ask, question } = seed();
    const report = await runDetectors({ detectors: DETECTORS, now: NOW });
    expect(report.detectors.flatMap((d) => d.errors)).toEqual([]);
    expect(rows('slack_promise')).toMatchObject([{
      source_ref: promise.dedupe_hash,
      title: 'Write up the migration plan',
      detail: "I'll write up the migration plan by Friday",
      counterparty: 'Alex',
      due_hint: 'by Friday',
      committed_at: NOW - 29_000,
    }]);
    expect(rows('slack_ask')).toMatchObject([{ source_ref: ask.dedupe_hash, detail: 'can you review my PR' }]);
    expect(rows('slack_unanswered')).toMatchObject([{
      source_ref: question.dedupe_hash,
      title: 'Reply to Alex: Answer Alex about the release date',
      detail: 'when does the release go out?',
    }]);
  });

  it('never classifies the same message twice across runs (runner-owned cache)', async () => {
    seed();
    await runDetectors({ detectors: DETECTORS, now: NOW });
    // 2 outbound (promise + "be out"), 4 inbound (plan, ask, question, weekend). "ok" and "lunch" never
    // reach the model; slack_unanswered reuses slack_ask's inbound answers.
    expect(mocks.chat).toHaveBeenCalledTimes(6);
    await runDetectors({ detectors: DETECTORS, now: NOW + 600 });
    expect(mocks.chat).toHaveBeenCalledTimes(6);
    const cached = db.prepare('SELECT COUNT(*) AS n FROM detector_cache').get() as { n: number };
    expect(cached.n).toBe(6);
  });

  it('closes slack_unanswered once I reply', async () => {
    seed();
    await runDetectors({ detectors: DETECTORS, now: NOW });
    insert({ sender: ME, text: 'next tuesday', ts: NOW + 100 });
    await runDetectors({ detectors: DETECTORS, now: NOW + 600 });
    expect(rows('slack_unanswered')).toMatchObject([{ status: 'done', resolved_by: 'auto', resolution_note: 'You replied in Slack' }]);
  });

  it('fails detect (so nothing expires) when the model is unreachable, and caches nothing', async () => {
    seed();
    mocks.chat.mockRejectedValue(new Error('Failed to reach Ollama'));
    const report = await runDetectors({ detectors: DETECTORS, now: NOW });
    expect(report.detectors.every((d) => d.errors.some((e) => /Failed to reach Ollama/.test(e)))).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM detector_cache').get() as { n: number }).n).toBe(0);
  });

  it('refuses to guess who "me" is without display_name', async () => {
    fs.writeFileSync(path.join(tempDir, 'user-config.json'), '{}');
    seed();
    const report = await runDetectors({ detectors: [slackPromise], now: NOW });
    expect(report.detectors[0].errors[0]).toMatch(/display_name/);
    expect(mocks.chat).not.toHaveBeenCalled();
  });
});
