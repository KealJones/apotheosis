import { getDb } from '../db.js';

interface StandupRow {
  date: string;
  yesterday: string | null;
  today: string | null;
  blockers: string | null;
  generated_at: number;
}

export interface StandupSummary {
  date: string;
  yesterday: string | null;
  today: string | null;
  blockers: string | null;
  generated_at: string;
}

export interface ListStandupsArgs {
  limit?: number;
  offset?: number;
}

export interface ListStandupsResult {
  standups: StandupSummary[];
  total: number;
}

/** List standups, most recent first. */
export function listStandups(args: ListStandupsArgs = {}): ListStandupsResult {
  const db = getDb();

  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  const rows = db.prepare(`
    SELECT date, yesterday, today, blockers, generated_at
    FROM standups
    ORDER BY date DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as StandupRow[];

  const countResult = db.prepare('SELECT COUNT(*) as count FROM standups').get() as { count: number };

  return {
    standups: rows.map(r => ({
      date: r.date,
      yesterday: r.yesterday,
      today: r.today,
      blockers: r.blockers,
      generated_at: new Date(r.generated_at * 1000).toISOString(),
    })),
    total: countResult.count,
  };
}
