import { getDb } from '../db.js';

export interface OpenCommitmentsArgs {
  limit?: number;
}

interface CommitmentRow {
  id: number;
  source: string;
  source_ref: string;
  title: string;
  detail: string | null;
  due_hint: string | null;
  detected_at: number;
}

export interface OpenCommitment {
  id: number;
  source: string;
  source_ref: string;
  title: string;
  detail: string | null;
  due_hint: string | null;
  detected_at: string;
}

export interface OpenCommitmentsResult {
  commitments: OpenCommitment[];
  total_open: number;
}

/** Read-only list of open commitments, most recently detected first. */
export function getOpenCommitments(args: OpenCommitmentsArgs = {}): OpenCommitmentsResult {
  const db = getDb();
  const limit = args.limit ?? 20;

  const rows = db.prepare(`
    SELECT id, source, source_ref, title, detail, due_hint, detected_at
    FROM commitments
    WHERE status = 'open'
    ORDER BY detected_at DESC
    LIMIT ?
  `).all(limit) as CommitmentRow[];

  const totalRow = db.prepare(
    `SELECT COUNT(*) as count FROM commitments WHERE status = 'open'`
  ).get() as { count: number };

  return {
    commitments: rows.map(r => ({
      id: r.id,
      source: r.source,
      source_ref: r.source_ref,
      title: r.title,
      detail: r.detail,
      due_hint: r.due_hint,
      detected_at: new Date(r.detected_at * 1000).toISOString(),
    })),
    total_open: totalRow.count,
  };
}
