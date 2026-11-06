import { getDb } from '../db.js';
import { groupIntoBlocks, groupIntoSessions, SampleRow, WorkBlock, Session } from '../summarize.js';

export interface SummarizeWindowArgs {
  since: string;
  until: string;
  compact?: boolean;
  min_duration_min?: number;
  merge_gap_min?: number;
}

export interface SummarizeWindowBlocksResult {
  blocks: WorkBlock[];
}

export interface SummarizeWindowSessionsResult {
  sessions: Session[];
}

export function getSummarizeWindow(
  args: SummarizeWindowArgs
): SummarizeWindowBlocksResult | SummarizeWindowSessionsResult {
  const db = getDb();
  const sinceMs = Math.floor(new Date(args.since).getTime() / 1000);
  const untilMs = Math.floor(new Date(args.until).getTime() / 1000);

  const rows = db.prepare(`
    SELECT id, taken_at, app_bundle, app_name, window_title, url,
           screenshot_path, ocr_text, active_seconds, is_evidence,
           document_path, selected_text, focused_element
    FROM samples
    WHERE taken_at >= ? AND taken_at <= ?
    ORDER BY taken_at ASC
  `).all(sinceMs, untilMs) as SampleRow[];

  const blocks = groupIntoBlocks(rows, {
    compact: args.compact,
    min_duration_min: args.min_duration_min,
  });

  // When merge_gap_min is set, return sessions instead of blocks
  if (args.merge_gap_min != null) {
    const sessions = groupIntoSessions(blocks, args.merge_gap_min);
    return { sessions };
  }

  return { blocks };
}
