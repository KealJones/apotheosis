/**
 * One scan of the window, shared by the three Slack detectors: load, prefilter, classify
 * survivors (cached). slack_ask and slack_unanswered read the same inbound classifications,
 * so whichever runs second is all cache hits.
 */
import type { DetectorCache, DetectorContext } from '../types.js';
import {
  classify,
  inboundPrompt,
  outboundPrompt,
  type ChatFn,
  type Classification,
} from './slackClassify.js';
import {
  inboundPrefilter,
  loadIdentity,
  loadMessages,
  priorContext,
  promisePrefilter,
  threadsWithMe,
  type Directedness,
  type SlackIdentity,
  type SlackMessage,
} from './slackMessages.js';

export interface Scan {
  id: SlackIdentity;
  all: SlackMessage[];
  mine: SlackMessage[];
}

export function loadScan(ctx: DetectorContext): Scan {
  const id = loadIdentity();
  if (!id.name) {
    // Without it every "is this me" check is wrong in the same way; fail loudly, not quietly.
    throw new Error('Slack detectors need display_name in user-config.json to tell your messages apart');
  }
  const all = loadMessages(ctx.db, ctx.since, id);
  return { id, all, mine: all.filter((m) => m.fromMe) };
}

export interface Classified {
  m: SlackMessage;
  c: Classification;
  how?: Directedness;
}

export interface ClassifyOpts {
  cache: DetectorCache;
  chat?: ChatFn;
  model?: string;
}

/**
 * Classify each item, skipping individual failures (they aren't cached, so they retry next
 * run). If there was work and all of it failed, throw: that's "Ollama is down", and the
 * runner must know detect() failed so it doesn't expire these sources.
 */
async function classifyEach<T extends { m: SlackMessage }>(
  items: T[],
  run: (t: T) => Promise<Classification>,
): Promise<Array<T & { c: Classification }>> {
  const out: Array<T & { c: Classification }> = [];
  let firstError: unknown = null;
  for (const t of items) {
    try {
      out.push({ ...t, c: await run(t) });
    } catch (e) {
      firstError ??= e;
    }
  }
  if (items.length > 0 && out.length === 0 && firstError) throw firstError;
  return out;
}

/** My messages that pass the promise prefilter, classified by the outbound prompt. */
export function classifyOutbound(scan: Scan, messages: SlackMessage[], opts: ClassifyOpts): Promise<Classified[]> {
  const items = messages.filter(promisePrefilter).map((m) => ({ m }));
  return classifyEach(items, ({ m }) =>
    classify('outbound', m, () => outboundPrompt(m, priorContext(m, scan.all), scan.id), opts),
  );
}

/** Messages aimed at me that pass the request/question prefilter, classified by the inbound prompt. */
export function classifyInbound(scan: Scan, messages: SlackMessage[], opts: ClassifyOpts): Promise<Classified[]> {
  const mySpots = threadsWithMe(scan.all);
  const items: Array<{ m: SlackMessage; how: Directedness }> = [];
  for (const m of messages) {
    const how = inboundPrefilter(m, scan.id, mySpots);
    if (how) items.push({ m, how });
  }
  return classifyEach(items, ({ m, how }) =>
    classify('inbound', m, () => inboundPrompt(m, priorContext(m, scan.all), how, scan.id), opts),
  );
}

/** "Jane Doe asked: …" style counterparty: prefer the model's, fall back to the sender. */
export function counterpartyOf(x: Classified): string | undefined {
  return x.c.counterparty ?? (x.m.fromMe ? undefined : x.m.who);
}

export function clipTitle(title: string, max = 120): string {
  const t = title.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
