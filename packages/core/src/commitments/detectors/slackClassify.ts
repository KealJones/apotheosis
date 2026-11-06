/**
 * Stage 2 of the Slack detectors: a local-model call per prefiltered message, memoized in
 * the runner-owned detector cache so a message is classified once, not once per run.
 *
 * Two prompts, because the question differs by direction:
 *   - outbound (my messages): did I commit to doing something?  → slack_promise
 *   - inbound (aimed at me):  am I being asked to do something / expected to answer?
 *                             → slack_ask and slack_unanswered share one call
 */
import * as ollama from '../../llm/ollama.js';
import type { DetectorCache } from '../types.js';
import { normalize, type Directedness, type SlackIdentity, type SlackMessage } from './slackMessages.js';

export interface Classification {
  /** Outbound: I committed to an action. Inbound: I'm being asked to do something. */
  is_commitment: boolean;
  /** Inbound only: a question the user is expected to answer. */
  expects_reply?: boolean;
  title: string;
  counterparty?: string;
  due_hint?: string;
  confidence: number;
  /** Verbatim span of the target message the decision rests on. Verified, see groundQuote. */
  quote: string;
}

export type ChatFn = (messages: ollama.OllamaChatMessage[]) => Promise<string>;

/** Bump when a prompt changes: it's part of the cache key, so old answers stop being read. */
export const PROMPT_VERSION = 'v3';
/**
 * Below this the model is guessing. Not really a tuning knob with qwen3.5:9b: in the eval
 * nearly every answer came back at 0.85-1.0, right or wrong, so precision comes from the
 * prompt and the quote check, not this threshold.
 */
export const MIN_CONFIDENCE = 0.6;

const MAX_TEXT = 1500;
const MAX_CONTEXT_TEXT = 300;

const GROUNDING_RULE =
  'GROUNDING RULE: "quote" must be copied character-for-character from the TARGET message ' +
  '(never from the context messages). Do not paraphrase, fix spelling, add apostrophes, or ' +
  'change capitalization. If no span of the target supports a "true" answer, the answer is false.';

const JSON_SHAPE_OUT =
  '{"is_commitment": boolean, "title": string, "counterparty": string|null, "due_hint": string|null, "confidence": number, "quote": string}';
const JSON_SHAPE_IN =
  '{"is_commitment": boolean, "expects_reply": boolean, "title": string, "counterparty": string|null, "due_hint": string|null, "confidence": number, "quote": string}';

function outboundSystem(name: string): string {
  return [
    `You read Slack messages written by ${name} (called "the user") and decide whether the TARGET message contains a commitment the user made: an explicit agreement or offer, by the user, to do a specific action later that someone could reasonably hold them to.`,
    '',
    'The user writes casually: lowercase, no apostrophes ("ill", "im", "lemme", "ima"/"imma" = "I\'m going to"), typos. Judge the meaning, not the polish.',
    '',
    'Commitments (true):',
    '- Agreeing to or volunteering for concrete work: "I\'ll take a look at the PR after lunch", "ill write that up tomorrow", "yep on it", "sure ill do that"',
    '- Short acknowledgements of a request or problem report in the CONTEXT: "lemme check", "ill take a look", "will look into this" all commit the user to looking',
    '- Stated plans for the user\'s own next steps: "ima remove the flag then", "gonna try a different approach for the parser", "ill have two PRs up today", "I need to update the docs for this"',
    '- Concrete offers of work: "I can take the migration ticket", "i can qa it once the backend lands", "happy to review tonight"',
    '- Commitments that depend on circumstances are still commitments: "if Sam is in today I\'ll talk with her about it", "when I\'m back at my desk I\'ll fix it"',
    '',
    'NOT commitments (false):',
    '- Availability or schedule: "I\'ll be out Friday", "I\'ll be in a meeting", "I\'ll probably come in after lunch", "running a few minutes late"',
    '- Offers that depend on the OTHER person wanting it, not yet accepted in the CONTEXT: "if you\'d like we can hop on a call", "if you want I can ask Sam", "I can take a look if we think that\'s the cause", "DM me and I\'ll see what I can do"',
    '- Predictions, opinions, hypotheticals, bets: "I\'ll probably hate it", "if I had time I would", "i bet i could build that in a weekend"',
    '- Already done in the same message: "I fixed it", "let me check... yep it\'s there", "ill send you my notes: <the notes follow>"',
    '- Throwaway conversational moves: "let me think", "let me guess", "let me be honest", "I\'ll allow it", "ill see myself out"',
    '- Asking someone else to act: "can you...", "let me know if...", "lmk", "can we ensure..."',
    '- Jokes, sarcasm, venting, social plans ("I\'ll have the burger", "I\'m gonna get fired lol")',
    '- Vague wishes or pledges with no concrete task: "I should really learn Rust someday", "it will not happen again", "ill keep that in mind"',
    '- Bot or automated output that happens to be attributed to the user: "Merging master into branch-x, I\'ll get back to you... Commit made!"',
    '- Describing how something works, or what the user did in the past',
    '',
    'The CONTEXT messages (if any) are earlier messages in the same conversation. Use them only to understand what the user agreed to (e.g. "sure, will do" answering "can you review my PR?" is a commitment to review the PR). The decision is about the TARGET message only.',
    '',
    'Fields:',
    '- title: short imperative to-do for the user, e.g. "Review Casey\'s agent-tools PR". Empty string if false.',
    '- counterparty: first name of the person the commitment is owed to, if clear, else null.',
    '- due_hint: the deadline words used ("tomorrow", "by Friday", "after lunch"), else null.',
    '- confidence: 0 to 1, how sure you are that this is a real commitment someone could follow up on. Use below 0.5 for borderline cases.',
    '- quote: the exact span of the TARGET message that makes it a commitment.',
    '',
    GROUNDING_RULE,
    '',
    `Respond with JSON only: ${JSON_SHAPE_OUT}`,
  ].join('\n');
}

function inboundSystem(name: string, handles: string[]): string {
  return [
    `You read Slack messages sent TO ${name} (called "the user"${handles.length ? `; handles: ${handles.join(', ')}` : ''}) by coworkers, and decide what the TARGET message asks of the user.`,
    '',
    'Two separate flags. Most messages are neither; a message is rarely both.',
    '',
    'is_commitment = the TARGET asks the user to DO a task outside the chat: review or re-review a PR, look into a bug, fix, send a link or file, write, deploy, test, approve, join a meeting, RSVP. Implicit versions count in a direct message: "feedback addressed <PR link>" or "ok how about this one? <PR link>" sent to the reviewer means "please review again".',
    'A question that the user can answer by just replying ("did you QA that?", "should this default to expanded?", "is PR 12 ready?") is NOT is_commitment; it is expects_reply.',
    '',
    'expects_reply = the TARGET asks the user a work or planning question and is waiting on the user\'s answer in Slack. A request to do a task is NOT expects_reply (it is is_commitment).',
    '',
    'Both false for:',
    '- FYIs, announcements, status updates, thanks, jokes, reactions, venting, heads-ups',
    '- The sender offering or planning to do something themselves: "I\'ll add you as a viewer", "I can look at the big one", "i can have claude draft a PR"',
    '- Requests or questions for someone else: if the TARGET names another person (@name) as the one to answer or act, both are false even if it also thanks or mentions the user',
    '- Broadcasts to a group/channel (@here, @channel, "anyone know...", "if anyone is available") unless the user is directly named as the one to act',
    '- In a thread the user posted in, messages usually address the whole thread; only true if the TARGET clearly responds to or addresses the user',
    '- Rhetorical questions and questions the sender answers themselves',
    '- Small talk and personal chat: "how was your weekend?", "how do you feel about that?", "did you see the game?", lunch, memes',
    '- Bot notifications and automated messages',
    '- Questions the TARGET says are already resolved ("nvm figured it out")',
    '',
    'You are told how the message reached the user: "direct message" (1:1, so the user is the recipient), "mentions the user", "group DM" (a few people, user is one), or "thread the user posted in". CONTEXT messages are earlier messages in the same conversation; use them to understand the TARGET, but judge the TARGET only.',
    '',
    'Fields:',
    '- title: short imperative to-do for the user, e.g. "Review Casey\'s persisted-agents PR" or "Answer Alex about the release date". Empty string if both false.',
    '- counterparty: first name of the sender (who the user owes), else null.',
    '- due_hint: any deadline words ("today", "before standup", "by Friday"), else null.',
    '- confidence: 0 to 1, how sure you are the user genuinely owes an action or answer. Below 0.5 for borderline.',
    '- quote: the exact span of the TARGET message that makes it a request or question.',
    '',
    GROUNDING_RULE,
    '',
    `Respond with JSON only: ${JSON_SHAPE_IN}`,
  ].join('\n');
}

const HOW: Record<Directedness, string> = {
  dm: 'direct message (1:1 with the user)',
  mention: 'mentions the user',
  group_dm: 'group DM (the user is one of a few people)',
  my_thread: 'thread the user posted in',
};

function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function userPrompt(m: SlackMessage, context: SlackMessage[], how: string | null, meName: string): string {
  const lines: string[] = [];
  if (context.length) {
    lines.push('CONTEXT (earlier messages, oldest first):');
    for (const c of context) lines.push(`- ${c.fromMe ? `${meName} (the user)` : c.who}: ${clip(c.text, MAX_CONTEXT_TEXT)}`);
    lines.push('');
  }
  lines.push(`TARGET (from ${m.fromMe ? `${meName} (the user)` : m.who}${how ? `, ${how}` : ''}${m.channel ? `, in "${m.channel}"` : ''}):`);
  lines.push(clip(m.text, MAX_TEXT));
  return lines.join('\n');
}

export function outboundPrompt(m: SlackMessage, context: SlackMessage[], id: SlackIdentity): ollama.OllamaChatMessage[] {
  const name = id.name ?? 'the user';
  return [
    { role: 'system', content: outboundSystem(name) },
    { role: 'user', content: userPrompt(m, context, null, name) },
  ];
}

export function inboundPrompt(
  m: SlackMessage,
  context: SlackMessage[],
  how: Directedness,
  id: SlackIdentity,
): ollama.OllamaChatMessage[] {
  const name = id.name ?? 'the user';
  return [
    { role: 'system', content: inboundSystem(name, id.patterns) },
    { role: 'user', content: userPrompt(m, context, HOW[how], name) },
  ];
}

/** Comparison form: lowercase, alphanumerics only. "I'll" and "ill" compare equal. */
const squash = (s: string) => normalize(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The quote is the audit trail ("because you said: …"), so it must really be in the message.
 * Tolerates the model re-adding apostrophes or case; anything else is a hallucinated quote,
 * which we treat as a failed classification. Returns the verbatim span from the message
 * where recoverable, so what we store is the user's text, not the model's rendition.
 */
export function groundQuote(quote: string, text: string): string | null {
  const q = quote.trim();
  if (squash(q).length < 3) return null;
  if (text.includes(q)) return q;
  const target = squash(q);
  if (!squash(text).includes(target)) return null;
  // Recover the verbatim span: walk the original text keeping a map from squashed index back.
  const idx: number[] = [];
  let sq = '';
  for (let i = 0; i < text.length; i++) {
    const c = squash(text[i]);
    if (c) {
      sq += c;
      idx.push(i);
    }
  }
  const at = sq.indexOf(target);
  return text.slice(idx[at], idx[at + target.length - 1] + 1);
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Parse and validate the model's JSON. Throws on anything unusable (not cached → retried next run). */
export function parseClassification(raw: string, text: string): Classification {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(`classifier returned non-JSON: ${raw.slice(0, 80)}`);
  }
  if (typeof obj.is_commitment !== 'boolean') throw new Error('classifier JSON missing is_commitment');
  const conf = Number(obj.confidence);
  const out: Classification = {
    is_commitment: obj.is_commitment,
    ...(typeof obj.expects_reply === 'boolean' ? { expects_reply: obj.expects_reply } : {}),
    title: str(obj.title) ?? '',
    counterparty: str(obj.counterparty),
    due_hint: str(obj.due_hint),
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0,
    quote: '',
  };
  const positive = out.is_commitment || out.expects_reply === true;
  const grounded = typeof obj.quote === 'string' ? groundQuote(obj.quote, text) : null;
  if (grounded) out.quote = grounded;
  else if (positive) {
    // A "yes" we can't point at is a yes we don't trust.
    out.is_commitment = false;
    if (out.expects_reply) out.expects_reply = false;
    out.confidence = 0;
  }
  return out;
}

export interface ClassifierDeps {
  cache: DetectorCache;
  /** Defaults to the real Ollama client, JSON mode, thinking off. */
  chat?: ChatFn;
  /** Part of the cache key. Defaults to getOllamaModel(). */
  model?: string;
}

/** chat()'s default 120s timeout: a ~1.2k-token prompt measured 4s idle but 30s+ when other
 *  Ollama clients were busy, and a timed-out call is wasted work (never cached). */
export const defaultChat: ChatFn = (messages) =>
  ollama.chat(messages, { format: 'json', think: false, options: { temperature: 0, num_predict: 400 } });

export type Direction = 'outbound' | 'inbound';

export function cacheKey(direction: Direction, m: SlackMessage, model: string): string {
  return `slack:${direction}:${PROMPT_VERSION}:${model}:${m.dedupe_hash}`;
}

/**
 * Classify with memoization. Only successful parses are cached; failures throw so the
 * caller can decide (skip this message, retry next run).
 */
export async function classify(
  direction: Direction,
  m: SlackMessage,
  prompt: () => ollama.OllamaChatMessage[],
  deps: ClassifierDeps,
): Promise<Classification> {
  const key = cacheKey(direction, m, deps.model ?? ollama.getOllamaModel());
  const hit = deps.cache.get(key);
  if (hit) return JSON.parse(hit) as Classification;
  const result = parseClassification(await (deps.chat ?? defaultChat)(prompt()), m.text);
  deps.cache.set(key, JSON.stringify(result));
  return result;
}

/** Positive and confident enough to show the user. */
export function accepted(c: Classification, flag: 'is_commitment' | 'expects_reply'): boolean {
  return c[flag] === true && c.confidence >= MIN_CONFIDENCE && c.quote !== '';
}
