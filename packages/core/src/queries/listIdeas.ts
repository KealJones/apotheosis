import { getDb } from '../db.js';

export interface ListIdeasArgs {
  since?: string;
  search?: string;
}

interface IdeaRow {
  id: number;
  body: string;
  source: string | null;
  created_at: number;
  cluster_id: number | null;
  promoted_to_project_id: number | null;
}

export interface ListedIdea {
  id: number;
  body: string;
  source: string | null;
  created_at: string;
  cluster_id: number | null;
  promoted_to_project_id: number | null;
}

export function listIdeas(args: ListIdeasArgs): ListedIdea[] {
  const db = getDb();

  const conditions: string[] = [];
  const params: (number | string)[] = [];

  if (args.since) {
    conditions.push('created_at >= ?');
    params.push(Math.floor(new Date(args.since).getTime() / 1000));
  }

  if (args.search) {
    conditions.push('body LIKE ?');
    params.push(`%${args.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT id, body, source, created_at, cluster_id, promoted_to_project_id
    FROM ideas
    ${where}
    ORDER BY created_at DESC
    LIMIT 200
  `;

  const rows = db.prepare(sql).all(...params) as IdeaRow[];

  return rows.map(r => ({
    id: r.id,
    body: r.body,
    source: r.source,
    created_at: new Date(r.created_at * 1000).toISOString(),
    cluster_id: r.cluster_id,
    promoted_to_project_id: r.promoted_to_project_id,
  }));
}
