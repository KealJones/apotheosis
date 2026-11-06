import { getDb } from '../db.js';

export interface LogIdeaArgs {
  body: string;
  source?: string;
}

interface SimilarIdeaRow {
  id: number;
  body: string;
  source: string | null;
  created_at: number;
}

export interface LogIdeaResult {
  idea: {
    id: number;
    body: string;
    source: string | null;
    created_at: string;
  };
  similar_ideas: {
    id: number;
    body: string;
    source: string | null;
    created_at: string;
  }[];
  note: string;
}

export function logIdea(args: LogIdeaArgs): LogIdeaResult {
  const db = getDb();
  const now = Date.now();

  const insert = db.prepare(`
    INSERT INTO ideas (body, source, created_at)
    VALUES (?, ?, ?)
  `);
  const result = insert.run(args.body, args.source ?? null, now);
  const newId = result.lastInsertRowid as number;

  // Look for similar existing ideas using first 20 chars as a rough fingerprint
  const prefix = args.body.slice(0, 20);
  const similar = db.prepare(`
    SELECT id, body, source, created_at
    FROM ideas
    WHERE id != ? AND body LIKE ?
    LIMIT 5
  `).all(newId, `%${prefix}%`) as SimilarIdeaRow[];

  const newIdea = {
    id: newId,
    body: args.body,
    source: args.source ?? null,
    created_at: new Date(now).toISOString(),
  };

  const similarFormatted = similar.map(s => ({
    id: s.id,
    body: s.body,
    source: s.source,
    created_at: new Date(s.created_at).toISOString(),
  }));

  return {
    idea: newIdea,
    similar_ideas: similarFormatted,
    note: similarFormatted.length > 0
      ? `Found ${similarFormatted.length} possibly similar idea(s) — check for duplicates.`
      : 'No similar ideas found.',
  };
}
