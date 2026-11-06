import { getDb } from '../db.js';
import {
  loadIdentity,
  parsePermalink,
  priorContext,
  toMessage,
  type ConversationKind,
  type SlackMessage,
} from '../commitments/detectors/slackMessages.js';

export interface SlackSearchArgs {
  q?: string;
  channel?: string;
  sender?: string;
  since?: string;
  until?: string;
  limit?: number;
  /** Also return the thread parent and up to this many earlier messages from the same thread/conversation. */
  context?: number;
}

interface SlackMessageRow {
  id: number;
  dedupe_hash: string;
  captured_at: number;
  channel: string | null;
  sender: string;
  text: string;
  permalink: string | null;
  reactions: string | null;
  reply_count: number | null;
}

interface ContextMessage {
  sender: string;
  text: string;
  sent_at: string;
}

export interface SlackSearchResult {
  count: number;
  messages: {
    id: number;
    sent_at: string;
    captured_at: string;
    channel: string | null;
    kind: ConversationKind;
    thread_reply: boolean;
    sender: string;
    text: string;
    reactions: string | null;
    reply_count: number | null;
    permalink: string | null;
    /** Only with `context`. Parent is the thread root, when this message is a reply and the root was captured. */
    context?: { parent: ContextMessage | null; before: ContextMessage[] };
  }[];
}

const COLUMNS = 'id, dedupe_hash, captured_at, channel, sender, text, permalink, reactions, reply_count';

const iso = (unix: number) => new Date(unix * 1000).toISOString();
const brief = (m: SlackMessage): ContextMessage => ({ sender: m.sender, text: m.text, sent_at: iso(m.sentAt) });

export function slackSearch(args: SlackSearchArgs): SlackSearchResult {
  const db = getDb();

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (args.q) {
    conditions.push('text LIKE ?');
    params.push(`%${args.q}%`);
  }
  if (args.channel) {
    conditions.push('channel LIKE ?');
    params.push(`%${args.channel}%`);
  }
  if (args.sender) {
    conditions.push('sender LIKE ?');
    params.push(`%${args.sender}%`);
  }
  if (args.since) {
    conditions.push('captured_at >= ?');
    params.push(Math.floor(new Date(args.since).getTime() / 1000));
  }
  if (args.until) {
    conditions.push('captured_at < ?');
    params.push(Math.floor(new Date(args.until).getTime() / 1000));
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);

  const rows = db.prepare(`
    SELECT ${COLUMNS}
    FROM slack_messages
    ${where}
    ORDER BY captured_at DESC
    LIMIT ?
  `).all(...params, limit) as SlackMessageRow[];

  const id = loadIdentity();
  const contextSize = Math.min(Math.max(args.context ?? 0, 0), 20);
  const conversations = new Map<string, SlackMessage[]>();

  /** Every captured message in one Slack conversation, oldest first. Cached per call. */
  const conversation = (channelId: string): SlackMessage[] => {
    let all = conversations.get(channelId);
    if (!all) {
      const convoRows = db.prepare(`SELECT ${COLUMNS} FROM slack_messages WHERE permalink LIKE ?`)
        .all(`%/archives/${channelId}/%`) as SlackMessageRow[];
      all = convoRows.map((r) => toMessage(r, id)).sort((a, b) => a.sentAt - b.sentAt || a.id - b.id);
      conversations.set(channelId, all);
    }
    return all;
  };

  const withContext = (m: SlackMessage) => {
    const parts = parsePermalink(m.permalink);
    if (!parts) return { parent: null, before: [] };
    const all = conversation(parts.channelId);
    const parent = m.isReply ? all.find((o) => parsePermalink(o.permalink)?.ts === parts.threadTs) ?? null : null;
    const before = priorContext(m, all, contextSize).filter((o) => o !== parent);
    return { parent: parent && brief(parent), before: before.map(brief) };
  };

  const messages = rows.map((r) => {
    const m = toMessage(r, id);
    return {
      id: r.id,
      sent_at: iso(m.sentAt),
      captured_at: iso(r.captured_at),
      channel: r.channel,
      kind: m.kind,
      thread_reply: m.isReply,
      sender: r.sender,
      text: r.text,
      reactions: r.reactions,
      reply_count: r.reply_count,
      permalink: r.permalink,
      ...(contextSize > 0 ? { context: withContext(m) } : {}),
    };
  });

  return { count: messages.length, messages };
}
