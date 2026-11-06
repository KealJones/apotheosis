import { getDb } from '../db.js';

export interface MeetingsArgs {
  since: string;
  until?: string;
}

interface MeetingRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  platform: string | null;
  title: string | null;
  url: string | null;
  transcript_status: string;
}

export interface MeetingSummary {
  id: number;
  started_at: string;
  ended_at: string | null;
  platform: string | null;
  title: string | null;
  url: string | null;
  transcript_status: string;
}

export interface MeetingsResult {
  meetings: MeetingSummary[];
}

/** Meetings (from capture-daemon detection) that started within the given range. */
export function getMeetings(args: MeetingsArgs): MeetingsResult {
  const db = getDb();
  const sinceSec = Math.floor(new Date(args.since).getTime() / 1000);
  const untilSec = Math.floor((args.until ? new Date(args.until).getTime() : Date.now()) / 1000);

  const rows = db.prepare(`
    SELECT id, started_at, ended_at, platform, title, url, transcript_status
    FROM meetings
    WHERE started_at >= ? AND started_at <= ?
    ORDER BY started_at ASC
  `).all(sinceSec, untilSec) as MeetingRow[];

  return {
    meetings: rows.map(r => ({
      id: r.id,
      started_at: new Date(r.started_at * 1000).toISOString(),
      ended_at: r.ended_at != null ? new Date(r.ended_at * 1000).toISOString() : null,
      platform: r.platform,
      title: r.title,
      url: r.url,
      transcript_status: r.transcript_status,
    })),
  };
}
