import { getDb } from '../db.js';

export interface ContextTimelineArgs {
  since: string;
  until?: string;
  event_type?: string;
}

interface EventRow {
  id: number;
  taken_at: number;
  event_type: string;
  app_bundle: string | null;
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  document_path: string | null;
  previous_app_bundle: string | null;
  detail: string | null;
}

interface CountRow {
  event_type: string;
  count: number;
}

export interface ContextTimelineEvent {
  id: number;
  time: string;
  event_type: string;
  app_name: string | null;
  app_bundle: string | null;
  window_title: string | null;
  url: string | null;
  document_path: string | null;
  previous_app_bundle: string | null;
  detail: string | null;
}

export interface ContextTimelineResult {
  events: ContextTimelineEvent[];
  counts: Record<string, number>;
}

export function getContextTimeline(args: ContextTimelineArgs): ContextTimelineResult {
  const db = getDb();
  const sinceUnix = Math.floor(new Date(args.since).getTime() / 1000);
  const untilUnix = Math.floor(
    (args.until ? new Date(args.until).getTime() : Date.now()) / 1000
  );

  let eventsSql: string;
  let eventsParams: (number | string)[];

  if (args.event_type) {
    eventsSql = `
      SELECT id, taken_at, event_type, app_bundle, app_name, window_title,
             url, document_path, previous_app_bundle, detail
      FROM context_events
      WHERE taken_at >= ? AND taken_at <= ? AND event_type = ?
      ORDER BY taken_at ASC
      LIMIT 500
    `;
    eventsParams = [sinceUnix, untilUnix, args.event_type];
  } else {
    eventsSql = `
      SELECT id, taken_at, event_type, app_bundle, app_name, window_title,
             url, document_path, previous_app_bundle, detail
      FROM context_events
      WHERE taken_at >= ? AND taken_at <= ?
      ORDER BY taken_at ASC
      LIMIT 500
    `;
    eventsParams = [sinceUnix, untilUnix];
  }

  const rows = db.prepare(eventsSql).all(...eventsParams) as EventRow[];

  const events = rows.map((r) => ({
    id: r.id,
    time: new Date(r.taken_at * 1000).toISOString(),
    event_type: r.event_type,
    app_name: r.app_name,
    app_bundle: r.app_bundle,
    window_title: r.window_title,
    url: r.url,
    document_path: r.document_path,
    previous_app_bundle: r.previous_app_bundle,
    detail: r.detail,
  }));

  // Counts by event type for the full range (not limited by the 500 row cap)
  const countsSql = `
    SELECT event_type, COUNT(*) as count
    FROM context_events
    WHERE taken_at >= ? AND taken_at <= ?
    GROUP BY event_type
  `;
  const countRows = db.prepare(countsSql).all(sinceUnix, untilUnix) as CountRow[];

  const counts: Record<string, number> = {};
  for (const row of countRows) {
    counts[row.event_type] = row.count;
  }

  return { events, counts };
}
