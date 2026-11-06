import { getDb } from '../db.js';

export interface ListMeetingsArgs {
  since?: string;
  until?: string;
  platform?: string;
  limit?: number;
}

interface MeetingRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  title: string | null;
  platform: string | null;
  summary: string | null;
  segment_count: number;
}

export interface MeetingSummaryItem {
  id: number;
  title: string | null;
  start: string;
  duration_seconds: number | null;
  platform: string | null;
  has_summary: boolean;
  segment_count: number;
}

export interface ListMeetingsResult {
  meetings: MeetingSummaryItem[];
  total: number;
}

/**
 * List meetings with optional filters and a count of transcript segments per meeting.
 * Returns id, title, start time, duration, platform, whether summary exists, and segment count.
 */
export function listMeetings(args: ListMeetingsArgs): ListMeetingsResult {
  const db = getDb();

  const sinceUnix = args.since ? Math.floor(new Date(args.since).getTime() / 1000) : 0;
  const untilUnix = args.until
    ? Math.floor(new Date(args.until).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  let query = `
    SELECT m.id, m.started_at, m.ended_at, m.title, m.platform, m.summary,
           COALESCE(COUNT(ms.id), 0) AS segment_count
    FROM meetings m
    LEFT JOIN meeting_segments ms ON ms.meeting_id = m.id
    WHERE m.started_at >= ? AND m.started_at <= ?
  `;
  const params: (string | number)[] = [sinceUnix, untilUnix];

  if (args.platform) {
    query += ` AND m.platform = ?`;
    params.push(args.platform);
  }

  query += ` GROUP BY m.id ORDER BY m.started_at DESC`;

  if (args.limit) {
    query += ` LIMIT ?`;
    params.push(args.limit);
  }

  const rows = db.prepare(query).all(...params) as MeetingRow[];

  const meetings: MeetingSummaryItem[] = rows.map(r => ({
    id: r.id,
    title: r.title,
    start: new Date(r.started_at * 1000).toISOString(),
    duration_seconds:
      r.ended_at != null ? r.ended_at - r.started_at : null,
    platform: r.platform,
    has_summary: r.summary != null && r.summary.length > 0,
    segment_count: r.segment_count,
  }));

  return {
    meetings,
    total: meetings.length,
  };
}
