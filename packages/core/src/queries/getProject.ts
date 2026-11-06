import { getDb } from '../db.js';

export interface GetProjectArgs {
  slug: string;
}

interface Project {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  status: string | null;
  created_at: number;
}

interface ProjectLink {
  kind: string;
  external_id: string;
  created_at: number;
}

export type GetProjectResult =
  | { error: string }
  | {
      id: number;
      slug: string;
      name: string;
      description: string | null;
      status: string | null;
      created_at: string;
      links: { kind: string; external_id: string; created_at: string }[];
    };

export function getProject(args: GetProjectArgs): GetProjectResult {
  const db = getDb();

  const project = db.prepare(
    'SELECT id, slug, name, description, status, created_at FROM projects WHERE slug = ?'
  ).get(args.slug) as Project | undefined;

  if (!project) {
    return { error: `Project not found: ${args.slug}` };
  }

  const links = db.prepare(
    'SELECT kind, external_id, created_at FROM project_links WHERE project_id = ? ORDER BY created_at ASC'
  ).all(project.id) as ProjectLink[];

  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    status: project.status,
    created_at: new Date(project.created_at).toISOString(),
    links: links.map(l => ({
      kind: l.kind,
      external_id: l.external_id,
      created_at: new Date(l.created_at).toISOString(),
    })),
  };
}
