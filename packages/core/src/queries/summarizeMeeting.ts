import { getDb } from '../db.js';
import * as ollama from '../llm/ollama.js';
import { summarizeTranscript, type MeetingSummaryReport, type TranscriptSegment } from '../meetings/summarize.js';

export interface SummarizeMeetingArgs {
  meeting_id: number;
  /** Regenerate even if a cached summary already exists. Default false. */
  force?: boolean;
}

export type SummarizeMeetingResult =
  | { error: string }
  | {
      meeting_id: number;
      summary: MeetingSummaryReport;
      model: string;
      generated_at: string;
      cached: boolean;
    };

interface MeetingCacheRow {
  summary: string | null;
  summary_model: string | null;
  summary_generated_at: number | null;
}

/**
 * Generate (or return a cached) structured summary for a meeting, via a local
 * Ollama model. Caches the result on the meetings row (summary,
 * summary_model, summary_generated_at, action_items) so repeat calls without
 * `force` don't re-run the LLM. Never caches a failure — if Ollama is
 * unreachable or the request fails, the meetings row is left untouched and a
 * clear error is returned instead.
 */
export async function summarizeMeeting(args: SummarizeMeetingArgs): Promise<SummarizeMeetingResult> {
  const db = getDb();

  const meetingRow = db
    .prepare('SELECT summary, summary_model, summary_generated_at FROM meetings WHERE id = ?')
    .get(args.meeting_id) as MeetingCacheRow | undefined;

  if (!meetingRow) {
    return { error: `Meeting ${args.meeting_id} not found.` };
  }

  if (!args.force && meetingRow.summary) {
    return {
      meeting_id: args.meeting_id,
      summary: JSON.parse(meetingRow.summary) as MeetingSummaryReport,
      model: meetingRow.summary_model ?? '',
      generated_at:
        meetingRow.summary_generated_at != null
          ? new Date(meetingRow.summary_generated_at * 1000).toISOString()
          : '',
      cached: true,
    };
  }

  const available = await ollama.isAvailable();
  if (!available) {
    return {
      error:
        `Ollama is not reachable at ${ollama.getOllamaUrl()}. ` +
        `Start it (e.g. \`ollama serve\`, and make sure model "${ollama.getOllamaModel()}" is pulled) and try again.`,
    };
  }

  const segments = db
    .prepare('SELECT started_ms, channel, speaker, text FROM meeting_segments WHERE meeting_id = ? ORDER BY started_ms ASC')
    .all(args.meeting_id) as TranscriptSegment[];

  if (segments.length === 0) {
    return { error: `Meeting ${args.meeting_id} has no transcript segments to summarize.` };
  }

  let summary: MeetingSummaryReport;
  try {
    summary = await summarizeTranscript(segments);
  } catch (err) {
    return {
      error: `Summarization failed: ${err instanceof Error ? err.message : String(err)}. Check that Ollama is running and reachable.`,
    };
  }

  const model = ollama.getOllamaModel();
  const generatedAtUnix = Math.floor(Date.now() / 1000);

  db.prepare(
    'UPDATE meetings SET summary = ?, summary_model = ?, summary_generated_at = ?, action_items = ? WHERE id = ?'
  ).run(
    JSON.stringify(summary),
    model,
    generatedAtUnix,
    JSON.stringify(summary.action_items),
    args.meeting_id
  );

  return {
    meeting_id: args.meeting_id,
    summary,
    model,
    generated_at: new Date(generatedAtUnix * 1000).toISOString(),
    cached: false,
  };
}
