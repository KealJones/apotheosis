import { getDb, transaction } from '../db.js';

export interface LinkEvidenceArgs {
  project_slug: string;
  sample_ids: number[];
}

interface Project {
  id: number;
  slug: string;
  name: string;
}

export type LinkEvidenceResult =
  | { error: string }
  | { project_slug: string; project_name: string; requested: number; linked: number };

export function linkEvidence(args: LinkEvidenceArgs): LinkEvidenceResult {
  const db = getDb();

  const project = db.prepare(
    'SELECT id, slug, name FROM projects WHERE slug = ?'
  ).get(args.project_slug) as Project | undefined;

  if (!project) {
    return { error: `Project not found: ${args.project_slug}` };
  }

  const now = Date.now();
  let linked = 0;

  const updateSample = db.prepare('UPDATE samples SET is_evidence = 1 WHERE id = ?');
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO project_links (project_id, kind, external_id, created_at)
    VALUES (?, 'sample', ?, ?)
  `);

  transaction(db, () => {
    for (const id of args.sample_ids) {
      updateSample.run(id);
      const info = insertLink.run(project.id, id.toString(), now);
      if (Number(info.changes) > 0) linked++;
    }
  });

  return {
    project_slug: args.project_slug,
    project_name: project.name,
    requested: args.sample_ids.length,
    linked,
  };
}
