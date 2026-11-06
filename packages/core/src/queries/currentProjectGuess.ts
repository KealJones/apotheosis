import { getDb } from '../db.js';
import { groupIntoBlocks, extractMetadata, SampleRow } from '../summarize.js';

interface ProjectRow {
  id: number;
  slug: string;
  name: string;
}

export type CurrentProjectGuess =
  | {
      matched: true;
      project_slug: string;
      project_name: string;
      basis: string; // e.g. "WID-4582" — what tipped the match
    }
  | {
      matched: false;
      app_name: string | null;
      window_title: string | null;
    }
  | null;

/**
 * Best-effort guess at "what am I working on right now": looks at the most
 * recent activity block (last 45 min) and tries to match a JIRA ticket
 * mentioned there against a project slug. Falls back to just naming the
 * app/window of the latest block. Returns null with no recent activity.
 *
 * This is a heuristic, not a tracked assignment — there's no explicit
 * "current project" concept in the schema, so treat this as a nudge, not
 * a fact.
 */
export function getCurrentProjectGuess(): CurrentProjectGuess {
  const db = getDb();
  const sinceSec = Math.floor(Date.now() / 1000) - 45 * 60;

  const rows = db.prepare(`
    SELECT id, taken_at, app_bundle, app_name, window_title, url,
           screenshot_path, ocr_text, active_seconds, is_evidence,
           document_path, selected_text, focused_element
    FROM samples
    WHERE taken_at >= ?
    ORDER BY taken_at ASC
  `).all(sinceSec) as SampleRow[];

  if (rows.length === 0) return null;

  const blocks = groupIntoBlocks(rows);
  const latest = blocks[blocks.length - 1];

  const metadata = extractMetadata([latest.window_title ?? '', latest.url ?? '', latest.ocr_excerpt]);
  const ticket = metadata.jira_tickets[0];

  if (ticket) {
    const project = db.prepare(
      'SELECT id, slug, name FROM projects WHERE slug = ?'
    ).get(ticket.toLowerCase()) as ProjectRow | undefined;

    if (project) {
      return { matched: true, project_slug: project.slug, project_name: project.name, basis: ticket };
    }
  }

  return { matched: false, app_name: latest.app_name, window_title: latest.window_title };
}
