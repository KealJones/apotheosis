/**
 * Map-reduce summarization of a meeting transcript via a local Ollama model.
 *
 * NOT to be confused with `packages/core/src/summarize.ts`, which is unrelated
 * session/block-grouping logic (`groupIntoBlocks`, `getTopWords`, etc.) used
 * by summarize_window/standup_draft/triage_samples.
 */
import * as ollama from '../llm/ollama.js';

export interface TranscriptSegment {
  started_ms: number;
  channel: string;
  speaker: string | null;
  text: string;
}

export interface MeetingActionItem {
  text: string;
  owner: 'me' | 'them' | 'unknown';
}

export interface MeetingSummaryReport {
  tldr: string;
  topics: string[];
  decisions: string[];
  action_items: MeetingActionItem[];
  open_questions: string[];
  /** Feeds evidence_report. */
  my_contributions: string[];
}

/** A contiguous run of segments from the same speaker/channel. */
interface Turn {
  channel: string;
  speaker: string | null;
  started_ms: number;
  text: string;
}

const DEFAULT_CHUNK_CHARS = 6000;

function formatTime(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** Group consecutive same-channel/speaker segments into turns, in order. */
export function groupIntoTurns(segments: TranscriptSegment[]): Turn[] {
  const turns: Turn[] = [];
  for (const seg of segments) {
    const last = turns[turns.length - 1];
    if (last && last.channel === seg.channel && last.speaker === seg.speaker) {
      last.text += ' ' + seg.text;
    } else {
      turns.push({
        channel: seg.channel,
        speaker: seg.speaker,
        started_ms: seg.started_ms,
        text: seg.text,
      });
    }
  }
  return turns;
}

function renderTurn(turn: Turn): string {
  const who = turn.speaker || turn.channel;
  return `[${formatTime(turn.started_ms)}] ${who}: ${turn.text}`;
}

/**
 * Chunk a transcript into roughly `targetChars`-character windows, splitting
 * only on turn boundaries (a "turn" = a contiguous run of segments from the
 * same channel) so a chunk never cuts a segment or a turn in half. A single
 * turn longer than targetChars still becomes its own chunk (never dropped).
 */
export function chunkTranscript(
  segments: TranscriptSegment[],
  targetChars = DEFAULT_CHUNK_CHARS
): string[] {
  const turns = groupIntoTurns(segments);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const turn of turns) {
    const rendered = renderTurn(turn);
    if (current.length > 0 && currentLen + 1 + rendered.length > targetChars) {
      chunks.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
    current.push(rendered);
    currentLen += (current.length > 1 ? 1 : 0) + rendered.length;
  }
  if (current.length > 0) {
    chunks.push(current.join('\n'));
  }
  return chunks;
}

const GROUNDING_RULES = `Rules:
- Ground every item you output in what was actually said in the transcript. Never invent content that isn't there.
- For action items, never invent an owner. Use "me" only if the transcript clearly shows the current user owns it, "them" if someone else clearly owns it, and "unknown" if it's genuinely unclear who owns it.
- Prefer quoting a decision verbatim (in quotes) over paraphrasing it.`;

function mapPrompt(chunk: string, index: number, total: number): ollama.OllamaChatMessage[] {
  return [
    {
      role: 'system',
      content:
        `You are analyzing part ${index + 1} of ${total} of a meeting transcript. ` +
        `Extract, in plain prose, the topics discussed, any decisions made (quote them verbatim where possible), ` +
        `action items mentioned (with owner if stated), open questions raised, and anything the current user ` +
        `("me" channel) contributed. ${GROUNDING_RULES}`,
    },
    { role: 'user', content: chunk },
  ];
}

function reducePrompt(chunkSummaries: string[]): ollama.OllamaChatMessage[] {
  return [
    {
      role: 'system',
      content:
        `You are merging partial summaries of a single meeting transcript into one final structured JSON summary. ` +
        `${GROUNDING_RULES}\n\n` +
        `Respond with ONLY a JSON object matching this exact shape (no markdown fences, no commentary):\n` +
        `{\n` +
        `  "tldr": "2-3 sentence summary",\n` +
        `  "topics": ["..."],\n` +
        `  "decisions": ["..."],\n` +
        `  "action_items": [{ "text": "...", "owner": "me" | "them" | "unknown" }],\n` +
        `  "open_questions": ["..."],\n` +
        `  "my_contributions": ["..."]\n` +
        `}`,
    },
    {
      role: 'user',
      content: chunkSummaries
        .map((s, i) => `--- Partial summary ${i + 1}/${chunkSummaries.length} ---\n${s}`)
        .join('\n\n'),
    },
  ];
}

/** Directly summarize a transcript short enough to fit in one chunk — skips the map step. */
function singleChunkPrompt(chunk: string): ollama.OllamaChatMessage[] {
  return [
    {
      role: 'system',
      content:
        `You are summarizing a meeting transcript into structured JSON. ${GROUNDING_RULES}\n\n` +
        `Respond with ONLY a JSON object matching this exact shape (no markdown fences, no commentary):\n` +
        `{\n` +
        `  "tldr": "2-3 sentence summary",\n` +
        `  "topics": ["..."],\n` +
        `  "decisions": ["..."],\n` +
        `  "action_items": [{ "text": "...", "owner": "me" | "them" | "unknown" }],\n` +
        `  "open_questions": ["..."],\n` +
        `  "my_contributions": ["..."]\n` +
        `}`,
    },
    { role: 'user', content: chunk },
  ];
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

function coerceOwner(value: unknown): 'me' | 'them' | 'unknown' {
  return value === 'me' || value === 'them' ? value : 'unknown';
}

function parseMeetingSummary(raw: string): MeetingSummaryReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch (err) {
    throw new Error(
      `Ollama returned a summary that wasn't valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const obj = parsed as Record<string, unknown>;

  const actionItems = Array.isArray(obj.action_items)
    ? obj.action_items.map((item) => {
        const it = item as Record<string, unknown>;
        return {
          text: typeof it.text === 'string' ? it.text : String(it.text ?? ''),
          owner: coerceOwner(it.owner),
        };
      })
    : [];

  return {
    tldr: typeof obj.tldr === 'string' ? obj.tldr : '',
    topics: Array.isArray(obj.topics) ? obj.topics.filter((t) => typeof t === 'string') : [],
    decisions: Array.isArray(obj.decisions) ? obj.decisions.filter((t) => typeof t === 'string') : [],
    action_items: actionItems,
    open_questions: Array.isArray(obj.open_questions)
      ? obj.open_questions.filter((t) => typeof t === 'string')
      : [],
    my_contributions: Array.isArray(obj.my_contributions)
      ? obj.my_contributions.filter((t) => typeof t === 'string')
      : [],
  };
}

export interface SummarizeTranscriptOptions {
  chunkChars?: number;
  /** Injectable for testing — defaults to the real Ollama client's chat(), used for prose map-step calls. */
  chatFn?: (messages: ollama.OllamaChatMessage[]) => Promise<string>;
  /** Injectable for testing — defaults to chat() with format:'json', used for calls expecting a JSON response. */
  jsonChatFn?: (messages: ollama.OllamaChatMessage[]) => Promise<string>;
}

/**
 * Map-reduce a meeting transcript into a structured MeetingSummaryReport.
 * Single-chunk transcripts skip the map step and go straight to a final
 * structured-JSON prompt; multi-chunk transcripts summarize each chunk in
 * prose first (map), then merge those into the final JSON (reduce).
 */
export async function summarizeTranscript(
  segments: TranscriptSegment[],
  opts: SummarizeTranscriptOptions = {}
): Promise<MeetingSummaryReport> {
  if (segments.length === 0) {
    throw new Error('No transcript segments to summarize.');
  }

  const chatFn = opts.chatFn ?? ollama.chat;
  const jsonChatFn = opts.jsonChatFn ?? ((messages) => ollama.chat(messages, { format: 'json' }));
  const chunks = chunkTranscript(segments, opts.chunkChars);

  if (chunks.length === 1) {
    const response = await jsonChatFn(singleChunkPrompt(chunks[0]));
    return parseMeetingSummary(response);
  }

  const chunkSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const response = await chatFn(mapPrompt(chunks[i], i, chunks.length));
    chunkSummaries.push(response);
  }

  const finalResponse = await jsonChatFn(reducePrompt(chunkSummaries));
  return parseMeetingSummary(finalResponse);
}
