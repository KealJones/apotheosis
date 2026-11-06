import { getDb } from '../db.js';

export interface ListUncorrelatedMeetingsArgs {
  limit?: number;
}

interface MeetingRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  title: string | null;
  url: string | null;
  platform: string | null;
}

export interface UncorrelatedMeetingItem {
  id: number;
  title: string | null;
  start: string;
  end: string | null;
  url: string | null;
  platform: string | null;
}

export interface ListUncorrelatedMeetingsResult {
  meetings: UncorrelatedMeetingItem[];
  total: number;
}

/**
 * Meetings that have not yet been correlated with a Google Calendar event
 * (`calendar_event_id IS NULL`). This is a dedicated query rather than a flag
 * on `listMeetings` because the caller here (the calendar-correlation skill)
 * needs a different shape: no date range (it should always see every
 * uncorrelated meeting, not just "today"), no segment-count join (irrelevant
 * to matching against a calendar), but it does need `url`/`platform`, which
 * `listMeetings` doesn't return, to help disambiguate close-in-time matches.
 *
 * Returns `started_at`/`ended_at` as ISO8601 so the caller can build a
 * calendar time-range query (e.g. `list_events` with `startTime`/`endTime`)
 * directly from the result.
 */
export function listUncorrelatedMeetings(
  args: ListUncorrelatedMeetingsArgs = {}
): ListUncorrelatedMeetingsResult {
  const db = getDb();

  let query = `
    SELECT id, started_at, ended_at, title, url, platform
    FROM meetings
    WHERE calendar_event_id IS NULL
    ORDER BY started_at DESC
  `;
  const params: number[] = [];

  if (args.limit) {
    query += ` LIMIT ?`;
    params.push(args.limit);
  }

  const rows = db.prepare(query).all(...params) as MeetingRow[];

  const meetings: UncorrelatedMeetingItem[] = rows.map(r => ({
    id: r.id,
    title: r.title,
    start: new Date(r.started_at * 1000).toISOString(),
    end: r.ended_at != null ? new Date(r.ended_at * 1000).toISOString() : null,
    url: r.url,
    platform: r.platform,
  }));

  return {
    meetings,
    total: meetings.length,
  };
}
