import { getDb } from '../db.js';

export interface SearchMeetingsArgs {
  query: string;
  limit?: number;
}

interface FtsResult {
  id: number;
  started_ms: number;
  text: string;
  meeting_id: number;
  started_at: number;
  title: string | null;
}

export interface SearchResult {
  meeting_id: number;
  meeting_title: string | null;
  meeting_start: string;
  segment_id: number;
  timestamp: string;
  text: string;
}

export interface SearchMeetingsResult {
  query: string;
  results: SearchResult[];
  total: number;
}

/**
 * Full-text search across meeting_segments. Uses FTS5 to find matching snippets
 * and returns results with meeting context (id, title, start) and segment timestamp.
 */
export function searchMeetings(args: SearchMeetingsArgs): SearchMeetingsResult {
  const db = getDb();

  const limit = args.limit ?? 50;

  // FTS5 search returns rowid (which is the segment id)
  const ftsRows = db.prepare(`
    SELECT fts.rowid, ms.started_ms, ms.text, ms.meeting_id,
           m.started_at, m.title
    FROM meeting_segments_fts fts
    JOIN meeting_segments ms ON ms.id = fts.rowid
    JOIN meetings m ON m.id = ms.meeting_id
    WHERE meeting_segments_fts MATCH ?
    ORDER BY m.started_at DESC, ms.started_ms ASC
    LIMIT ?
  `).all(args.query, limit) as FtsResult[];

  const results: SearchResult[] = ftsRows.map(row => {
    const mins = Math.floor(row.started_ms / 60000);
    const secs = Math.floor((row.started_ms % 60000) / 1000);
    const timestamp = `${mins}:${String(secs).padStart(2, '0')}`;

    return {
      meeting_id: row.meeting_id,
      meeting_title: row.title,
      meeting_start: new Date(row.started_at * 1000).toISOString(),
      segment_id: row.id,
      timestamp,
      text: row.text,
    };
  });

  return {
    query: args.query,
    results,
    total: results.length,
  };
}
