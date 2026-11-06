import { getDb } from '../db.js';

export interface RecentActivityArgs {
  since: string;
  until?: string;
  app?: string;
}

interface ActivityRow {
  id: number;
  taken_at: number;
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  ocr_text: string | null;
  screenshot_path: string;
  document_path: string | null;
  selected_text: string | null;
  focused_element: string | null;
}

export interface RecentActivitySample {
  id: number;
  time: string;
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  ocr_excerpt: string | null;
  screenshot_path: string;
  document_path: string | null;
  selected_text: string | null;
  focused_element: string | null;
}

export interface RecentActivityResult {
  samples: RecentActivitySample[];
}

export function getRecentActivity(args: RecentActivityArgs): RecentActivityResult {
  const db = getDb();
  const sinceMs = Math.floor(new Date(args.since).getTime() / 1000);
  const untilMs = Math.floor((args.until ? new Date(args.until).getTime() : Date.now()) / 1000);

  let sql: string;
  let params: (number | string)[];

  if (args.app) {
    const like = `%${args.app}%`;
    sql = `
      SELECT id, taken_at, app_name, window_title, url, ocr_text, screenshot_path,
             document_path, selected_text, focused_element
      FROM samples
      WHERE taken_at >= ? AND taken_at <= ?
        AND (app_name LIKE ? OR app_bundle LIKE ?)
      ORDER BY taken_at ASC
      LIMIT 200
    `;
    params = [sinceMs, untilMs, like, like];
  } else {
    sql = `
      SELECT id, taken_at, app_name, window_title, url, ocr_text, screenshot_path,
             document_path, selected_text, focused_element
      FROM samples
      WHERE taken_at >= ? AND taken_at <= ?
      ORDER BY taken_at ASC
      LIMIT 200
    `;
    params = [sinceMs, untilMs];
  }

  const rows = db.prepare(sql).all(...params) as ActivityRow[];

  const samples = rows.map(r => ({
    id: r.id,
    time: new Date(r.taken_at * 1000).toISOString(),
    app_name: r.app_name,
    window_title: r.window_title,
    url: r.url,
    ocr_excerpt: r.ocr_text ? r.ocr_text.slice(0, 200) : null,
    screenshot_path: r.screenshot_path,
    document_path: r.document_path ?? null,
    selected_text: r.selected_text ? r.selected_text.slice(0, 200) : null,
    focused_element: r.focused_element ?? null,
  }));

  return { samples };
}
