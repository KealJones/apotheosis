import { getDb } from '../db.js';
import { isNotAThing, resolveCommitmentSource } from './rankedCommitments.js';
import type { Commitment, CommitmentSource, CommitmentStatus } from '../commitments/types.js';

export interface ListCommitmentsArgs {
  /** Filter to one source. Omit for every source. */
  source?: CommitmentSource;
  /** Filter to one status. Omit for every status - the full ledger, `/commitments`'s default view. */
  status?: CommitmentStatus;
  limit?: number;
  offset?: number;
}

export interface LedgerCommitment extends Commitment {
  /** Best-effort link to the underlying source; see resolveCommitmentSource. */
  source_url: string | null;
  /**
   * True only for a `dismissed` row tagged via `markCommitmentNotAThing` (see NOT_A_THING_TAG).
   * The `/commitments` history view uses this to distinguish "should never have been
   * detected" from a plain "dismissed, fair detection, just not doing it".
   */
  is_not_a_thing: boolean;
}

export interface ListCommitmentsResult {
  commitments: LedgerCommitment[];
  /** Count matching `source`/`status` before `limit`/`offset` - i.e. the filtered total, not the whole table. */
  total: number;
}

/**
 * The full-ledger read behind `/commitments` (C8) - unlike `getOpenCommitments` (status
 * pinned to 'open') and `getTodoList` (ranked, capped at TOP_CAP, open/snoozed only), this
 * is an unranked, unfiltered-by-default browse over every status and source, newest first.
 */
export function listCommitments(args: ListCommitmentsArgs = {}): ListCommitmentsResult {
  const db = getDb();
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (args.source) {
    where.push('source = ?');
    params.push(args.source);
  }
  if (args.status) {
    where.push('status = ?');
    params.push(args.status);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT * FROM commitments
    ${whereClause}
    ORDER BY detected_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Commitment[];

  const totalRow = db.prepare(`
    SELECT COUNT(*) as count FROM commitments ${whereClause}
  `).get(...params) as { count: number };

  return {
    commitments: rows.map((c) => ({
      ...c,
      source_url: resolveCommitmentSource(c),
      is_not_a_thing: c.status === 'dismissed' && isNotAThing(c),
    })),
    total: totalRow.count,
  };
}
