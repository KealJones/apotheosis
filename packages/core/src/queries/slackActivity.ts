import { getDb } from '../db.js';
import type { ReadonlyDb } from '../commitments/types.js';
import {
  groupKey,
  loadIdentity,
  loadMessages,
  type ConversationKind,
  type SlackMessage,
} from '../commitments/detectors/slackMessages.js';
import { digestEnabled, readFreshDigest, type ThreadDigest } from '../slack/digest.js';

export interface SlackActivityArgs {
  /** Unix seconds, inclusive. */
  since: number;
  /** Unix seconds, inclusive. */
  until: number;
}

export interface SlackThread {
  channel: string | null;
  kind: ConversationKind;
  permalink: string | null;
  /**
   * First captured message of the thread (the root when it was captured). Omitted, along with
   * `mine`, when an up-to-date local digest stands in for the raw text.
   */
  root?: { who: string; text: string; sent_at: string };
  mine?: { text: string; sent_at: string }[];
  /** Local-model digest (`slack.local_digest`), only when it covers every message in range. */
  digest?: ThreadDigest;
  others: string[];
  message_count: number;
}

export interface SlackActivityResult {
  /** Threads (or DMs) where I posted in the range. */
  my_threads: SlackThread[];
  /** Conversations I only read, by message count. */
  read: { channel: string | null; kind: ConversationKind; message_count: number }[];
}

const ROOT_CHARS = 280;
const MINE_CHARS = 500;

const iso = (unix: number) => new Date(unix * 1000).toISOString();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Slack messages sent in [since, until], grouped for a standup: threads I posted in carry the
 * root and my own messages; everything else collapses to per-conversation counts. DMs group by
 * conversation, channels by thread.
 */
export function getSlackActivity(args: SlackActivityArgs, db: ReadonlyDb = getDb()): SlackActivityResult {
  const id = loadIdentity();
  const messages = loadMessages(db, args.since, id).filter((m) => m.sentAt <= args.until);

  const groups = new Map<string, SlackMessage[]>();
  for (const m of messages) {
    const key = groupKey(m);
    const group = groups.get(key);
    if (group) group.push(m);
    else groups.set(key, [m]);
  }

  const useDigests = digestEnabled();
  const myThreads: SlackThread[] = [];
  const read = new Map<string, { channel: string | null; kind: ConversationKind; message_count: number }>();

  for (const group of groups.values()) {
    const mine = group.filter((m) => m.fromMe);
    if (mine.length === 0) {
      const first = group[0];
      const entry = read.get(first.convo) ?? { channel: first.channel, kind: first.kind, message_count: 0 };
      entry.message_count += group.length;
      read.set(first.convo, entry);
      continue;
    }
    const root = group[0];
    const base = {
      channel: root.channel,
      kind: root.kind,
      permalink: root.permalink,
      others: [...new Set(group.filter((m) => !m.fromMe).map((m) => m.who))],
      message_count: group.length,
    };
    // Per thread: the digest only replaces raw text when it covers the newest message here.
    // Feature off, model never ran, or new messages since its last run all fall back to raw.
    const stored = useDigests ? readFreshDigest(db, groupKey(root), group[group.length - 1].sentAt) : null;
    if (stored) {
      myThreads.push({ ...base, digest: stored.digest });
      continue;
    }
    myThreads.push({
      ...base,
      root: { who: root.who, text: clip(root.text, ROOT_CHARS), sent_at: iso(root.sentAt) },
      mine: mine.map((m) => ({ text: clip(m.text, MINE_CHARS), sent_at: iso(m.sentAt) })),
    });
  }

  return {
    my_threads: myThreads,
    read: [...read.values()].sort((a, b) => b.message_count - a.message_count),
  };
}
