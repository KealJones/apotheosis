import { getDb } from '../db.js';

export interface UsageStatsArgs {
  since?: string;
  kind?: 'tool' | 'skill';
}

export interface UsageStatsResult {
  totals: Record<string, number>;
  by_name: {
    kind: string;
    name: string;
    total_calls: number;
    first_used: string;
    last_used: string;
    avg_duration_ms: number | null;
  }[];
  daily_last_14d: { day: string; kind: string; calls: number }[];
}

export function getUsageStats(args: UsageStatsArgs): UsageStatsResult {
  const db = getDb();

  const sinceUnix = args.since
    ? Math.floor(new Date(args.since).getTime() / 1000)
    : 0;

  // Build WHERE clause
  const conditions: string[] = ['called_at >= ?'];
  const params: (number | string)[] = [sinceUnix];

  if (args.kind) {
    conditions.push('kind = ?');
    params.push(args.kind);
  }

  const where = conditions.join(' AND ');

  // Per-name summary
  const perName = db.prepare(`
    SELECT kind, name,
           COUNT(*) as total_calls,
           MIN(called_at) as first_used,
           MAX(called_at) as last_used,
           ROUND(AVG(duration_ms)) as avg_duration_ms
    FROM tool_usage
    WHERE ${where}
    GROUP BY kind, name
    ORDER BY total_calls DESC
  `).all(...params) as {
    kind: string;
    name: string;
    total_calls: number;
    first_used: number;
    last_used: number;
    avg_duration_ms: number | null;
  }[];

  // Daily breakdown (last 14 days)
  const fourteenDaysAgo = Math.floor(Date.now() / 1000) - 14 * 86400;
  const daily = db.prepare(`
    SELECT DATE(called_at, 'unixepoch', 'localtime') as day,
           kind,
           COUNT(*) as calls
    FROM tool_usage
    WHERE called_at >= ?
    GROUP BY day, kind
    ORDER BY day DESC
  `).all(fourteenDaysAgo) as { day: string; kind: string; calls: number }[];

  // Grand totals
  const totals = db.prepare(`
    SELECT kind, COUNT(*) as total
    FROM tool_usage
    WHERE ${where}
    GROUP BY kind
  `).all(...params) as { kind: string; total: number }[];

  return {
    totals: Object.fromEntries(totals.map(t => [t.kind, t.total])),
    by_name: perName.map(r => ({
      kind: r.kind,
      name: r.name,
      total_calls: r.total_calls,
      first_used: new Date(r.first_used * 1000).toISOString(),
      last_used: new Date(r.last_used * 1000).toISOString(),
      avg_duration_ms: r.avg_duration_ms,
    })),
    daily_last_14d: daily,
  };
}
