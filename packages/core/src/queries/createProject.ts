import { getDb } from '../db.js';

export interface CreateProjectArgs {
  slug: string;
  name: string;
  description?: string;
}

interface Project {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  status: string | null;
  created_at: number;
}

export type CreateProjectResult =
  | { error: string }
  | {
      id: number;
      slug: string;
      name: string;
      description: string | null;
      status: string | null;
      created_at: string;
    };

export function createProject(args: CreateProjectArgs): CreateProjectResult {
  const db = getDb();
  const now = Date.now();

  try {
    const result = db.prepare(`
      INSERT INTO projects (slug, name, description, status, created_at)
      VALUES (?, ?, ?, 'active', ?)
    `).run(args.slug, args.name, args.description ?? null, now);

    const project = db.prepare(
      'SELECT id, slug, name, description, status, created_at FROM projects WHERE id = ?'
    ).get(result.lastInsertRowid) as Project;

    return {
      ...project,
      created_at: new Date(project.created_at).toISOString(),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isDup = message.includes('UNIQUE constraint failed');
    return {
      error: isDup
        ? `A project with slug "${args.slug}" already exists.`
        : message,
    };
  }
}
