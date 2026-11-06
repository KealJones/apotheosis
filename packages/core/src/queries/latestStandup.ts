import { getDb } from '../db.js';

interface StandupRow {
  date: string;
  yesterday: string | null;
  today: string | null;
  blockers: string | null;
  generated_at: number;
}

export interface LatestStandup {
  date: string;
  yesterday: string | null;
  today: string | null;
  blockers: string | null;
  generated_at: string;
}

/** Most recently generated standup (see logStandup), or null if none exist yet. */
export function getLatestStandup(): LatestStandup | null {
  const db = getDb();

  const row = db.prepare(`
    SELECT date, yesterday, today, blockers, generated_at
    FROM standups
    ORDER BY date DESC
    LIMIT 1
  `).get() as StandupRow | undefined;

  if (!row) return null;

  return {
    date: row.date,
    yesterday: row.yesterday,
    today: row.today,
    blockers: row.blockers,
    generated_at: new Date(row.generated_at * 1000).toISOString(),
  };
}
