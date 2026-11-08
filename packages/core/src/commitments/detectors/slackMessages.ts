/**
 * Shared plumbing for the Slack detectors (slack_ask, slack_promise, slack_unanswered):
 * who "me" is, what a permalink says about threads, loading the scan window, and the regex
 * prefilters that decide which messages are worth a model call.
 *
 * Capture is AX/OCR-derived and lossy. Nothing here can see a message that was never
 * captured, so every conclusion is "in captured messages", never "in Slack".
 */
import { readUserConfig } from '../../userConfig.js';
import type { ReadonlyDb } from '../types.js';

// ── Identity ────────────────────────────────────────────────────────────────

export interface SlackIdentity {
  /** `display_name` from user-config.json. Slack renders senders as "Jane Doe (She/Her)". */
  name: string | null;
  /** `mention_patterns` from user-config.json, lowercased. Same list the `mentions` tool uses. */
  patterns: string[];
  /**
   * `slack.ignore_patterns` from user-config.json, compiled case-insensitive. Messages whose
   * text matches any of them (bot posts sent under your name, integration noise) are dropped
   * by loadMessages before any detector or digest sees them. Invalid regexes are skipped.
   */
  ignore?: RegExp[];
}

function compileIgnore(patterns: unknown): RegExp[] {
  if (!Array.isArray(patterns)) return [];
  const out: RegExp[] = [];
  for (const p of patterns) {
    if (typeof p !== 'string' || !p.trim()) continue;
    try {
      out.push(new RegExp(p, 'i'));
    } catch {
      // Bad user regex: skip it rather than break every Slack feature.
    }
  }
  return out;
}

export function loadIdentity(): SlackIdentity {
  const cfg = readUserConfig();
  const name = typeof cfg.display_name === 'string' && cfg.display_name.trim() ? cfg.display_name.trim() : null;
  const patterns = Array.isArray(cfg.mention_patterns)
    ? cfg.mention_patterns.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.toLowerCase())
    : [];
  return { name, patterns, ignore: compileIgnore(cfg.slack?.ignore_patterns) };
}

/** "Jane Doe (She/Her)" → "Jane Doe". */
export function stripPronouns(sender: string): string {
  return sender.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

export function isFromMe(sender: string, id: SlackIdentity): boolean {
  return id.name !== null && stripPronouns(sender).toLowerCase() === id.name.toLowerCase();
}

export function mentionsMe(text: string, id: SlackIdentity): boolean {
  const lower = text.toLowerCase();
  return id.patterns.some((p) => lower.includes(p));
}

/** Rows whose "sender" is capture debris or an integration, not a person asking you something. */
const NON_PERSON_SENDER = /^(show more|github|jira|slackbot|google calendar|google drive|workflow builder|polly|giphy)$|bot$/i;
/** The Activity view renders the sender as "Sam Patel mentioned you in #general". */
const ACTIVITY_SENDER = /^(.+?) (?:mentioned you|replied to you|replied in a thread)\b/i;

// ── Permalinks and threads ──────────────────────────────────────────────────

export interface PermalinkParts {
  channelId: string;
  /** Message ts as Slack writes it ("1781112632.462169"). */
  ts: string;
  /** Parent ts when this message is a thread reply. */
  threadTs: string | null;
}

/**
 * `https://x.slack.com/archives/C0123ABCDEF/p1781112632462169?thread_ts=1781112630.069589&cid=…`
 * The p-number is the ts with the dot removed (10 digits of seconds, 6 of micros). There is no
 * thread column in slack_messages; the permalink is the only thread identity we have.
 */
export function parsePermalink(url: string | null): PermalinkParts | null {
  if (!url) return null;
  const m = url.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (!m) return null;
  const thread = url.match(/[?&]thread_ts=(\d+\.\d+)/);
  return { channelId: m[1], ts: `${m[2]}.${m[3]}`, threadTs: thread ? thread[1] : null };
}

export type ConversationKind = 'dm' | 'group_dm' | 'channel';

export interface SlackMessage {
  id: number;
  dedupe_hash: string;
  channel: string | null;
  sender: string;
  text: string;
  permalink: string | null;
  captured_at: number;
  /** Unix seconds the message was *sent* (from the permalink), else captured_at. */
  sentAt: number;
  /** Conversation identity: the Slack channel id when known, else the captured channel label. */
  convo: string;
  /** Thread identity: `${convo}:${root ts}` for replies and for top-level messages (their own ts). */
  thread: string;
  isReply: boolean;
  kind: ConversationKind;
  fromMe: boolean;
  /** Real person's name, pronouns stripped (Activity-view "X mentioned you" rows unwrapped). */
  who: string;
}

interface Row {
  id: number;
  dedupe_hash: string;
  channel: string | null;
  sender: string;
  text: string;
  permalink: string | null;
  captured_at: number;
}

function conversationKind(channel: string | null, parts: PermalinkParts | null): ConversationKind {
  // D… ids are 1:1 DMs. Group DMs carry C… ids nowadays, but capture labels them "A, B (DM)".
  if (parts?.channelId.startsWith('D')) return 'dm';
  if (channel && /\(DM\)\s*$/.test(channel)) return channel.includes(',') ? 'group_dm' : 'dm';
  return 'channel';
}

export function toMessage(r: Row, id: SlackIdentity): SlackMessage {
  const parts = parsePermalink(r.permalink);
  const convo = parts?.channelId ?? `label:${r.channel ?? ''}`;
  const ts = parts?.ts ?? String(r.captured_at);
  const activity = r.sender.match(ACTIVITY_SENDER);
  return {
    ...r,
    sentAt: parts ? Math.floor(Number(parts.ts)) : r.captured_at,
    convo,
    thread: `${convo}:${parts?.threadTs ?? ts}`,
    isReply: Boolean(parts?.threadTs && parts.threadTs !== parts.ts),
    kind: conversationKind(r.channel, parts),
    fromMe: isFromMe(r.sender, id),
    who: stripPronouns(activity ? activity[1] : r.sender),
  };
}

/**
 * Every captured message *sent* at or after `since`, oldest first. A message can't be
 * captured before it's sent, so `captured_at >= since` is a safe index-friendly superset.
 */
export function loadMessages(db: ReadonlyDb, since: number, id: SlackIdentity): SlackMessage[] {
  const rows = db.prepare(`
    SELECT id, dedupe_hash, channel, sender, text, permalink, captured_at
    FROM slack_messages
    WHERE captured_at >= ?
  `).all(since) as Row[];
  const ignore = id.ignore ?? [];
  return rows
    .filter((r) => !ignore.some((re) => re.test(r.text)))
    .map((r) => toMessage(r, id))
    .filter((m) => m.sentAt >= since)
    .sort((a, b) => a.sentAt - b.sentAt || a.id - b.id);
}

/** How messages group into a conversation unit: channels by thread, DMs by conversation. */
export function groupKey(m: SlackMessage): string {
  return m.kind === 'channel' ? m.thread : m.convo;
}

export function loadMessageByHash(db: ReadonlyDb, hash: string, id: SlackIdentity): SlackMessage | null {
  const row = db.prepare(`
    SELECT id, dedupe_hash, channel, sender, text, permalink, captured_at
    FROM slack_messages WHERE dedupe_hash = ?
  `).get(hash) as Row | undefined;
  return row ? toMessage(row, id) : null;
}

/** The (up to) `n` messages right before `m` in its thread (replies) or conversation. */
export function priorContext(m: SlackMessage, all: SlackMessage[], n = 4): SlackMessage[] {
  const scope = (o: SlackMessage) => (m.isReply ? o.thread === m.thread : o.convo === m.convo);
  return all.filter((o) => o !== m && scope(o) && o.sentAt <= m.sentAt && o.id !== m.id).slice(-n);
}

/**
 * Did I post after `q` in the place a reply would go? Thread replies: same thread only. DMs:
 * anywhere in the DM. Top-level channel messages: in q's thread, or top-level in the same
 * channel (people answer inline). Deliberately generous: a false "answered" costs a missed
 * nudge, a false "unanswered" costs trust.
 */
export function laterReplyFromMe(q: SlackMessage, mine: SlackMessage[]): SlackMessage | null {
  for (const r of mine) {
    if (r.sentAt < q.sentAt || r.id === q.id || r.convo !== q.convo) continue;
    if (r.sentAt === q.sentAt && r.id < q.id) continue;
    if (q.kind !== 'channel') return r;
    if (r.thread === q.thread) return r;
    if (!q.isReply && !r.isReply) return r;
  }
  return null;
}

// ── Prefilters ──────────────────────────────────────────────────────────────

/** Curly quotes → straight, so one regex set covers both. */
export function normalize(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
}

/**
 * Verbs that can follow a bare "ill" (typed without the apostrophe, very common in casual
 * Slack). Without a verb gate "ill" would match "I was ill".
 */
const ILL_VERBS =
  'take|do|look|get|send|write|check|follow|ping|try|make|put|add|fix|update|review|have|be|see|' +
  'figure|work|push|open|file|post|share|circle|reach|loop|dig|throw|set|grab|handle|test|merge|' +
  'message|dm|talk|ask|investigate|start|finish|pick|bring|draft|run|go|jump|hop|poke|toss|whip|' +
  'knock|clean|move|leave|let|tag|create|build|help|find|read|reply|respond|email|schedule|book|' +
  'mention|raise|note|keep|wait|spin|pair|sync|write';

/** First-person future commitment forms. Each is a real shape seen in captured Slack. */
export const PROMISE_PATTERNS: RegExp[] = [
  /\bi'll\b/i,
  /\bi ll\b/i,
  new RegExp(`\\bill\\s+(?:${ILL_VERBS})\\b`, 'i'),
  /\bi\s+will\b/i,
  /\bi(?:'m| am|m)\s+(?:going to|gonna)\b/i,
  /\bi\s+(?:can|could)\s+(?:take|grab|do|handle|pick|look|check|review|write|send|put|throw|help|get|make|update|fix|add|own|dig|investigate|set|whip|have|jump|hop|pair|ping|reach|test|run|draft|share|qa|answer|walk|cover|sync|merge|approve|land|see if|figure)\b/i,
  // Subjectless "will qa after that", "..., will do"; "will be" is almost never a promise.
  /(?:^|[.!?,;]\s*|\b(?:and|but|then|so)\s+)will\s+(?!be\b)\w+/i,
  /\b(?:ima|imma|i'mma|finna)\b/i,
  /\b(?:yes|yeah|yep|yup|sure|ok|okay),?\s+i\s+can\b/i,
  /\b(?:let me|lemme)\s+(?!know\b)\w+/i,
  /\bon my (?:list|radar|plate|todo|to-do|to do|queue)\b/i,
  /(?:^|[.!?]\s*)(?:(?:ok|okay|sure|yep|yup|yes|yeah|ya|k|kk|np|no problem)[\s,!.]+)?(?:will do|on it|can do)\b/i,
  /\bi'?m on it\b/i,
  /\bleave it (?:with|to) me\b/i,
  /\bi(?:'ve)? got (?:this|you)\b/i,
  /\bi\s+(?:need|have|plan|intend|promise|gotta|got)\s+to\b/i,
  /\bi\s+gotta\b/i,
  /\bi\s+should\b/i,
  /\bremind me\b/i,
  /\b(?:happy|glad|willing) to\b/i,
  /\bi'?m\s+(?:working on|looking into|taking care|picking up|handling)\b/i,
];

/** Request shapes aimed at the reader. */
export const ASK_PATTERNS: RegExp[] = [
  /\b(?:can|could|would|will)\s+(?:you|u|ya)\b/i,
  /\b(?:do|would) you mind\b/i,
  /\b(?:are you able|able to|any chance)\b/i,
  /\b(?:please|pls|plz)\b/i,
  /\b(?:take|have|get) a (?:look|peek|glance)\b/i,
  /\blook(?:ing)? (?:at|into|over)\b/i,
  /\b(?:review|rfr|ptal|approve|approval|sign[- ]off|stamp)\b/i,
  /\bneed (?:you|your|a|an|some|help|eyes)\b/i,
  /\b(?:ping|dm|message|email|call|tell|send|show) me\b/i,
  /\b(?:lmk|let me know|let us know)\b/i,
  /\bwhen you (?:get|have) a (?:chance|sec|second|minute|moment)\b/i,
  /\b(?:thoughts|opinions?|ideas|feedback)\b/i,
  /\bdo you (?:know|have|think|want)\b/i,
  /\bhave you\b/i,
  /\bare you (?:free|around|available|going|planning|still)\b/i,
  /\b(?:wanna|want to)\b/i,
];

/** Question shapes: a "?" anywhere (OCR glues messages together) or an interrogative opener. */
export const QUESTION_PATTERNS: RegExp[] = [
  /\?/,
  /^\s*(?:who|what|when|where|why|how|is|are|do|does|did|can|could|would|will|should|have|has)\b/i,
];

const matchesAny = (text: string, res: RegExp[]) => {
  const t = normalize(text);
  return res.some((re) => re.test(t));
};

/** Stage 1 for slack_promise: my own message in a first-person future-commitment shape. */
export function promisePrefilter(m: SlackMessage): boolean {
  return m.fromMe && matchesAny(m.text, PROMISE_PATTERNS);
}

/** How a message reaches me, strongest first. null = not aimed at me. */
export type Directedness = 'dm' | 'mention' | 'group_dm' | 'my_thread';

/**
 * `myThreads` = threads I started or posted in. Broadcasts (@here/@channel) in channels are
 * never "directed" on their own: a question to 300 people isn't your to-do.
 */
export function directedness(m: SlackMessage, id: SlackIdentity, myThreads: Set<string>): Directedness | null {
  if (m.fromMe || NON_PERSON_SENDER.test(stripPronouns(m.sender))) return null;
  if (m.kind === 'dm') return 'dm';
  if (mentionsMe(m.text, id) || ACTIVITY_SENDER.test(m.sender)) return 'mention';
  if (m.kind === 'group_dm') return 'group_dm';
  if (m.isReply && myThreads.has(m.thread)) return 'my_thread';
  return null;
}

/** Stage 1 for slack_ask and slack_unanswered: aimed at me, and shaped like a request or question. */
export function inboundPrefilter(m: SlackMessage, id: SlackIdentity, myThreads: Set<string>): Directedness | null {
  const d = directedness(m, id, myThreads);
  if (!d) return null;
  return matchesAny(m.text, ASK_PATTERNS) || matchesAny(m.text, QUESTION_PATTERNS) ? d : null;
}

/** "@alex.rivera" style handles in the text that aren't one of mine. */
export function otherHandles(text: string, id: SlackIdentity): string[] {
  return (text.match(/@[a-z0-9][\w.-]*/gi) ?? []).filter((h) => !id.patterns.some((p) => h.toLowerCase().startsWith(p)));
}

/** Threads (see SlackMessage.thread) that contain a message of mine. */
export function threadsWithMe(messages: SlackMessage[]): Set<string> {
  return new Set(messages.filter((m) => m.fromMe).map((m) => m.thread));
}
