import { getDb } from '../db.js';

interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  status: string | null;
}

export interface ProjectSummary {
  id: number;
  slug: string;
  name: string;
  status: string | null;
}

export interface ListProjectsResult {
  projects: ProjectSummary[];
}

/** All projects, most recently created first. Used for project pickers (e.g. link-to-project actions). */
export function listProjects(): ListProjectsResult {
  const db = getDb();

  const rows = db.prepare(`
    SELECT id, slug, name, status
    FROM projects
    ORDER BY created_at DESC
  `).all() as ProjectRow[];

  return { projects: rows.map(r => ({ id: r.id, slug: r.slug, name: r.name, status: r.status })) };
}
