import * as fs from 'fs';
import { getDb } from '../db.js';
import { groupIntoBlocks, groupIntoSessions, Session, SampleRow } from '../summarize.js';

export interface TimelineArgs {
  since: string;
  until?: string;
}

interface EventRow {
  id: number;
  taken_at: number;
  event_type: string;
  window_title: string | null;
  document_path: string | null;
}

export interface TimelineEvent {
  id: number;
  time: string;
  event_type: string;
  window_title: string | null;
  document_path: string | null;
}

export interface TimelineSession extends Session {
  ocr_excerpt: string;
  representative_sample_id: number | null;
  screenshot_exists: boolean;
  events: TimelineEvent[];
}

export interface TimelineResult {
  sessions: TimelineSession[];
  total_samples: number;
}

/**
 * Day-timeline view: groups `samples` into sessions via the same
 * groupIntoBlocks/groupIntoSessions pipeline standup_draft, summarize_window,
 * and triage_samples already use, then enriches each session with an OCR
 * excerpt, a representative sample (for the screenshot route), and the
 * `context_events` that fall inside its time range.
 */
export function getTimelineSessions(args: TimelineArgs): TimelineResult {
  const db = getDb();
  const sinceSec = Math.floor(new Date(args.since).getTime() / 1000);
  const untilSec = Math.floor((args.until ? new Date(args.until).getTime() : Date.now()) / 1000);

  const rows = db.prepare(`
    SELECT id, taken_at, app_bundle, app_name, window_title, url,
           screenshot_path, ocr_text, active_seconds, is_evidence,
           document_path, selected_text, focused_element
    FROM samples
    WHERE taken_at >= ? AND taken_at <= ?
    ORDER BY taken_at ASC
  `).all(sinceSec, untilSec) as SampleRow[];

  const blocks = groupIntoBlocks(rows);
  const sessions = groupIntoSessions(blocks);

  const byId = new Map(rows.map(r => [r.id, r]));

  const eventRows = db.prepare(`
    SELECT id, taken_at, event_type, window_title, document_path
    FROM context_events
    WHERE taken_at >= ? AND taken_at <= ?
    ORDER BY taken_at ASC
  `).all(sinceSec, untilSec) as EventRow[];

  const timelineSessions: TimelineSession[] = sessions.map(session => {
    const startSec = Math.floor(new Date(session.start).getTime() / 1000);
    const endSec = Math.floor(new Date(session.end).getTime() / 1000);

    const ocrTexts = session.sample_ids
      .map(id => byId.get(id)?.ocr_text ?? '')
      .filter(Boolean);
    const ocr_excerpt = ocrTexts.join(' ').slice(0, 500);

    // Screenshot files get cleaned up well before their DB rows do (retention/cleanup
    // jobs prune disk usage independently), so `screenshot_path` being set doesn't mean
    // the file is still there. Walk from the most recent sample backwards and pick the
    // first one whose file actually still exists on disk.
    let representative_sample_id: number | null = null;
    let screenshot_exists = false;
    for (let i = session.sample_ids.length - 1; i >= 0; i--) {
      const candidateId = session.sample_ids[i];
      const candidatePath = byId.get(candidateId)?.screenshot_path;
      if (candidatePath && fs.existsSync(candidatePath)) {
        representative_sample_id = candidateId;
        screenshot_exists = true;
        break;
      }
    }

    const events: TimelineEvent[] = eventRows
      .filter(e => e.taken_at >= startSec && e.taken_at <= endSec)
      .map(e => ({
        id: e.id,
        time: new Date(e.taken_at * 1000).toISOString(),
        event_type: e.event_type,
        window_title: e.window_title,
        document_path: e.document_path,
      }));

    return { ...session, ocr_excerpt, representative_sample_id, screenshot_exists, events };
  });

  return { sessions: timelineSessions, total_samples: rows.length };
}
