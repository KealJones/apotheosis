/**
 * Local-model digests of active Slack conversations, so Claude can be handed "what's going on
 * in Slack" (summary, urgency, your to-dos, open items) instead of raw message text.
 *
 * Opt-in via `slack.local_digest` in user-config.json. Written by the scheduled detector pass
 * (`runSlackDigest`), read by `standup_draft` (through getSlackActivity) and `slack_digests`.
 * A conversation is only re-digested when its messages changed, so a run with no new Slack
 * activity makes zero model calls and never loads the model.
 *
 * Storage is the runner's `detector_cache` under `slack_digest:<version>:<group key>`: one
 * entry per conversation, overwritten when it changes, pruned with the rest of the cache.
 */
import { createHash } from 'crypto';
import { getDb } from '../db.js';
import { openDetectorCache } from '../commitments/runner.js';
import type { DetectorCache, ReadonlyDb } from '../commitments/types.js';
import {
  groupKey,
  loadIdentity,
  type ConversationKind,
  type SlackIdentity,
  type SlackMessage,
  loadMessages,
} from '../commitments/detectors/slackMessages.js';
import * as ollama from '../llm/ollama.js';
import { readUserConfig } from '../userConfig.js';

export const DIGEST_VERSION = 'v1';
/** Conversations with activity this recent get digested. Covers a Monday standup's Friday. */
export const DIGEST_LOOKBACK_SECONDS = 4 * 86_400;
/** Only the most recent messages of a long conversation go into the prompt. */
const MAX_PROMPT_MESSAGES = 30;
const MESSAGE_CHARS = 400;

export type Urgency = 'low' | 'normal' | 'high';

export interface ThreadDigest {
  summary: string;
  urgency: Urgency;
  /** Things you said you'd do, or were asked to do and haven't visibly done. */
  my_todos: string[];
  /** Unresolved questions or decisions left hanging. */
  open_items: string[];
}

export interface StoredDigest {
  /** Fingerprint of the messages it was written from, plus prompt version and model. */
  hash: string;
  model: string;
  digested_at: number;
  /** sentAt of the newest message it covers. Older than a reader's newest = stale. */
  through: number;
  digest: ThreadDigest;
}

export function digestEnabled(): boolean {
  return readUserConfig().slack?.local_digest === true;
}

export function digestKey(group: string): string {
  return `slack_digest:${DIGEST_VERSION}:${group}`;
}

/** Conversations worth a digest: ones you posted in, plus DMs (someone may be waiting on you). */
function eligible(group: SlackMessage[]): boolean {
  return group.some((m) => m.fromMe) || group[0].kind !== 'channel';
}

export function groupMessages(messages: SlackMessage[]): Map<string, SlackMessage[]> {
  const groups = new Map<string, SlackMessage[]>();
  for (const m of messages) {
    const key = groupKey(m);
    const g = groups.get(key);
    if (g) g.push(m);
    else groups.set(key, [m]);
  }
  return groups;
}

function fingerprint(group: SlackMessage[], model: string): string {
  const h = createHash('sha256');
  h.update(`${DIGEST_VERSION}\n${model}\n`);
  for (const m of group) h.update(`${m.dedupe_hash}\n`);
  return h.digest('hex');
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function digestPrompt(group: SlackMessage[], id: SlackIdentity): ollama.OllamaChatMessage[] {
  const first = group[0];
  const where = first.kind === 'channel' ? `channel ${first.channel ?? 'unknown'}` : `direct message (${first.channel ?? 'unknown'})`;
  const lines = group
    .slice(-MAX_PROMPT_MESSAGES)
    .map((m) => `[${new Date(m.sentAt * 1000).toISOString().slice(0, 16)}] ${m.fromMe ? `${m.who} (me)` : m.who}: ${clip(m.text.replace(/\s+/g, ' '), MESSAGE_CHARS)}`);
  return [
    {
      role: 'system',
      content:
        `You summarize a Slack conversation for ${id.name ?? 'the user'} ("me"), so they can remember what they were doing. ` +
        'Reply with JSON only: {"summary": string, "urgency": "low"|"normal"|"high", "my_todos": string[], "open_items": string[]}. ' +
        'summary: one or two plain sentences on what was discussed and where it landed. ' +
        'urgency: high only if someone is blocked on me or there is a deadline today; low for chatter or finished topics. ' +
        'my_todos: short imperative items I said I would do, or was directly asked to do, that the conversation does not show as done. Empty if none. ' +
        'open_items: unresolved questions or decisions still hanging. Empty if none. ' +
        'Use only what the messages say. Do not invent names, tickets, or dates.',
    },
    { role: 'user', content: `Conversation in ${where}:\n${lines.join('\n')}` },
  ];
}

const URGENCIES: readonly Urgency[] = ['low', 'normal', 'high'];
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()).slice(0, 8) : [];

/** Lenient parse of the model's JSON. Throws only when there's no usable summary. */
export function parseDigest(raw: string): ThreadDigest {
  const obj = JSON.parse(raw) as Record<string, unknown>;
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (!summary) throw new Error('digest had no summary');
  return {
    summary,
    urgency: URGENCIES.includes(obj.urgency as Urgency) ? (obj.urgency as Urgency) : 'normal',
    my_todos: strings(obj.my_todos),
    open_items: strings(obj.open_items),
  };
}

export type DigestChat = (messages: ollama.OllamaChatMessage[]) => Promise<string>;

const defaultChat: DigestChat = (messages) =>
  ollama.chat(messages, { format: 'json', think: false, options: { temperature: 0, num_predict: 500 } });

export interface DigestRunOptions {
  now?: number;
  lookbackSeconds?: number;
  chat?: DigestChat;
  model?: string;
  db?: ReadonlyDb;
  cache?: DetectorCache;
}

export interface DigestRunReport {
  /** Eligible conversations in the window. */
  conversations: number;
  /** Re-digested this run (new or changed messages). */
  digested: number;
  /** Already up to date. */
  unchanged: number;
  errors: string[];
}

/**
 * Digest every eligible conversation whose messages changed since its last digest. Failures
 * are per conversation and never cached, so they retry next run. If there was work and all
 * of it failed (Ollama down), that shows up as errors with digested = 0.
 */
export async function runSlackDigest(opts: DigestRunOptions = {}): Promise<DigestRunReport> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const db = getDb();
  const ro = opts.db ?? db;
  const cache = opts.cache ?? openDetectorCache(db, now);
  const model = opts.model ?? ollama.getOllamaModel();
  const chat = opts.chat ?? defaultChat;
  const id = loadIdentity();

  const messages = loadMessages(ro, now - (opts.lookbackSeconds ?? DIGEST_LOOKBACK_SECONDS), id);
  const report: DigestRunReport = { conversations: 0, digested: 0, unchanged: 0, errors: [] };

  for (const [key, group] of groupMessages(messages)) {
    if (!eligible(group)) continue;
    report.conversations++;
    const hash = fingerprint(group, model);
    const cacheKey = digestKey(key);
    const prev = cache.get(cacheKey);
    if (prev && (JSON.parse(prev) as StoredDigest).hash === hash) {
      report.unchanged++;
      continue;
    }
    try {
      const digest = parseDigest(await chat(digestPrompt(group, id)));
      const stored: StoredDigest = { hash, model, digested_at: now, through: group[group.length - 1].sentAt, digest };
      cache.set(cacheKey, JSON.stringify(stored));
      report.digested++;
    } catch (e) {
      report.errors.push(`${group[0].channel ?? key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}

/** The stored digest for a conversation if it covers everything up to `newest`, else null. */
export function readFreshDigest(db: ReadonlyDb, group: string, newest: number): StoredDigest | null {
  const row = db.prepare('SELECT value FROM detector_cache WHERE key = ?').get(digestKey(group)) as { value: string } | undefined;
  if (!row) return null;
  try {
    const stored = JSON.parse(row.value) as StoredDigest;
    return stored.through >= newest ? stored : null;
  } catch {
    return null;
  }
}

export interface SlackDigestEntry {
  channel: string | null;
  kind: ConversationKind;
  permalink: string | null;
  participants: string[];
  last_message_at: string;
  message_count: number;
  summary: string;
  urgency: Urgency;
  my_todos: string[];
  open_items: string[];
}

export interface SlackDigestsResult {
  enabled: boolean;
  digests: SlackDigestEntry[];
  /** Active conversations with no up-to-date digest yet (model hasn't run since they changed). */
  undigested: number;
  note?: string;
}

/** Up-to-date digests for conversations active in [since, until], most urgent and recent first. */
export function getSlackDigests(args: { since: number; until: number }, db: ReadonlyDb = getDb()): SlackDigestsResult {
  if (!digestEnabled()) {
    return { enabled: false, digests: [], undigested: 0, note: 'slack.local_digest is off in user-config.json. Use slack_search for raw messages.' };
  }
  const id = loadIdentity();
  const messages = loadMessages(db, args.since - DIGEST_LOOKBACK_SECONDS, id).filter((m) => m.sentAt <= args.until);
  const digests: SlackDigestEntry[] = [];
  let undigested = 0;
  for (const [key, group] of groupMessages(messages)) {
    const last = group[group.length - 1];
    if (last.sentAt < args.since || !eligible(group)) continue;
    const stored = readFreshDigest(db, key, last.sentAt);
    if (!stored) {
      undigested++;
      continue;
    }
    digests.push({
      channel: group[0].channel,
      kind: group[0].kind,
      permalink: group[0].permalink,
      participants: [...new Set(group.map((m) => m.who))],
      last_message_at: new Date(last.sentAt * 1000).toISOString(),
      message_count: group.length,
      ...stored.digest,
    });
  }
  const rank: Record<Urgency, number> = { high: 0, normal: 1, low: 2 };
  digests.sort((a, b) => rank[a.urgency] - rank[b.urgency] || b.last_message_at.localeCompare(a.last_message_at));
  return { enabled: true, digests, undigested };
}
