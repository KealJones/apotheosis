import { getDb } from '../db.js';

// Aggregation queries backing the /analytics dashboard (apps/web/app/analytics).
// Every function here is range-aware (since/until) and range-scans on an
// existing indexed timestamp column — see db.ts for the supporting indexes.

export interface AnalyticsRangeArgs {
  since: string;
  until?: string;
}

function toRange(args: AnalyticsRangeArgs): { sinceUnix: number; untilUnix: number } {
  const sinceUnix = Math.floor(new Date(args.since).getTime() / 1000);
  const untilUnix = Math.floor((args.until ? new Date(args.until).getTime() : Date.now()) / 1000);
  return { sinceUnix, untilUnix };
}

// Each `samples` row represents one capture tick at this cadence — mirrors the
// estimate codeTime.ts already uses (sample_count * 15 seconds), so "active
// time" reads consistently across the whole app rather than each query
// inventing its own unit.
const SAMPLE_INTERVAL_SECONDS = 15;

function samplesToHours(sampleCount: number): number {
  return Math.round(((sampleCount * SAMPLE_INTERVAL_SECONDS) / 3600) * 100) / 100;
}

function secondsToHours(totalSeconds: number): number {
  return Math.round((totalSeconds / 3600) * 100) / 100;
}

// App bundles classified as "coding" for the coding/meeting/Slack split.
// Meeting time comes from the `meetings` table, not from samples, so a
// Zoom/Meet sample simply falls into "other" here rather than double-counting.
const CODING_APP_BUNDLES = new Set([
  'com.microsoft.VSCode',
  'com.todesktop.230313mzl4w4u92', // Cursor
  'com.apple.dt.Xcode',
  'com.jetbrains.intellij',
  'com.jetbrains.WebStorm',
  'com.jetbrains.PyCharm',
  'com.googlecode.iterm2',
  'com.apple.Terminal',
]);
const SLACK_APP_BUNDLE = 'com.tinyspeck.slackmacgap';

// ─────────────────────────────────────────────────────────────────────────
// Active hours per day, weekday vs weekend
// ─────────────────────────────────────────────────────────────────────────

export interface ActiveHoursByDayRow {
  day: string; // YYYY-MM-DD, localtime
  hours: number;
  isWeekend: boolean;
}

export interface ActiveHoursByDayResult {
  days: ActiveHoursByDayRow[];
}

export function getActiveHoursByDay(args: AnalyticsRangeArgs): ActiveHoursByDayResult {
  const db = getDb();
  const { sinceUnix, untilUnix } = toRange(args);

  const rows = db.prepare(`
    SELECT strftime('%Y-%m-%d', taken_at, 'unixepoch', 'localtime') AS day,
           CAST(strftime('%w', taken_at, 'unixepoch', 'localtime') AS INTEGER) AS dow,
           COUNT(*) AS sample_count
    FROM samples
    WHERE taken_at >= ? AND taken_at <= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(sinceUnix, untilUnix) as { day: string; dow: number; sample_count: number }[];

  return {
    days: rows.map((r) => ({
      day: r.day,
      hours: samplesToHours(r.sample_count),
      isWeekend: r.dow === 0 || r.dow === 6,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Time by app
// ─────────────────────────────────────────────────────────────────────────

export interface TimeByAppRow {
  app: string;
  hours: number;
}

export interface TimeByAppResult {
  apps: TimeByAppRow[];
  otherHours: number;
}

export function getTimeByApp(args: AnalyticsRangeArgs & { limit?: number }): TimeByAppResult {
  const db = getDb();
  const { sinceUnix, untilUnix } = toRange(args);
  // Dataviz series cap for a legend-backed categorical chart (see palette.md).
  const limit = args.limit ?? 7;

  const rows = db.prepare(`
    SELECT COALESCE(app_name, 'Unknown') AS app, COUNT(*) AS sample_count
    FROM samples
    WHERE taken_at >= ? AND taken_at <= ?
    GROUP BY app
    ORDER BY sample_count DESC
  `).all(sinceUnix, untilUnix) as { app: string; sample_count: number }[];

  const top = rows.slice(0, limit);
  const rest = rows.slice(limit);
  const otherHours = samplesToHours(rest.reduce((sum, r) => sum + r.sample_count, 0));

  return {
    apps: top.map((r) => ({ app: r.app, hours: samplesToHours(r.sample_count) })),
    otherHours,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Time by project
//
// There's no `project_links` convention yet for mapping a project to a repo
// path or JIRA prefix (the only `project_links.kind` written anywhere today
// is 'sample', from manual evidence-linking). So this reuses the same
// heuristic codeTime.ts already relies on: match the project's slug/name as
// a substring of window_title/document_path/url. Anything that matches no
// project is reported as unassignedHours rather than silently dropped.
// ─────────────────────────────────────────────────────────────────────────

export interface TimeByProjectRow {
  project: string;
  hours: number;
}

export interface TimeByProjectResult {
  projects: TimeByProjectRow[];
  unassignedHours: number;
}

export function getTimeByProject(args: AnalyticsRangeArgs): TimeByProjectResult {
  const db = getDb();
  const { sinceUnix, untilUnix } = toRange(args);

  const projects = db.prepare(`SELECT slug, name FROM projects`).all() as {
    slug: string;
    name: string;
  }[];

  const totalRow = db.prepare(
    `SELECT COUNT(*) AS n FROM samples WHERE taken_at >= ? AND taken_at <= ?`
  ).get(sinceUnix, untilUnix) as { n: number };

  if (projects.length === 0) {
    return { projects: [], unassignedHours: samplesToHours(totalRow.n) };
  }

  const rows = db.prepare(`
    SELECT window_title, document_path, url
    FROM samples
    WHERE taken_at >= ? AND taken_at <= ?
  `).all(sinceUnix, untilUnix) as {
    window_title: string | null;
    document_path: string | null;
    url: string | null;
  }[];

  const needles = projects.map((p) => ({
    slug: p.slug,
    name: p.name,
    slugNeedle: p.slug.toLowerCase(),
    nameNeedle: p.name.toLowerCase(),
  }));

  const counts = new Map<string, number>(projects.map((p) => [p.slug, 0]));
  let unassigned = 0;

  for (const row of rows) {
    const haystack = `${row.window_title ?? ''} ${row.document_path ?? ''} ${row.url ?? ''}`.toLowerCase();
    const match = needles.find((p) => haystack.includes(p.slugNeedle) || haystack.includes(p.nameNeedle));
    if (match) {
      counts.set(match.slug, (counts.get(match.slug) ?? 0) + 1);
    } else {
      unassigned++;
    }
  }

  return {
    projects: projects
      .map((p) => ({ project: p.name, hours: samplesToHours(counts.get(p.slug) ?? 0) }))
      .filter((p) => p.hours > 0)
      .sort((a, b) => b.hours - a.hours),
    unassignedHours: samplesToHours(unassigned),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Context-switch rate per hour (focus proxy)
// ─────────────────────────────────────────────────────────────────────────

export interface ContextSwitchRateRow {
  hour: string; // "YYYY-MM-DD HH:00", localtime
  switches: number;
}

export interface ContextSwitchRateResult {
  hours: ContextSwitchRateRow[];
}

export function getContextSwitchRate(args: AnalyticsRangeArgs): ContextSwitchRateResult {
  const db = getDb();
  const { sinceUnix, untilUnix } = toRange(args);

  const rows = db.prepare(`
    SELECT strftime('%Y-%m-%d %H:00', taken_at, 'unixepoch', 'localtime') AS hour,
           COUNT(*) AS switches
    FROM context_events
    WHERE event_type = 'app_switch' AND taken_at >= ? AND taken_at <= ?
    GROUP BY hour
    ORDER BY hour ASC
  `).all(sinceUnix, untilUnix) as { hour: string; switches: number }[];

  return { hours: rows };
}

// ─────────────────────────────────────────────────────────────────────────
// Coding vs meeting vs Slack time, per day
// ─────────────────────────────────────────────────────────────────────────

export interface TimeBreakdownDayRow {
  day: string;
  codingHours: number;
  meetingHours: number;
  slackHours: number;
  otherHours: number;
}

export interface TimeBreakdownResult {
  days: TimeBreakdownDayRow[];
}

export function getTimeBreakdown(args: AnalyticsRangeArgs): TimeBreakdownResult {
  const db = getDb();
  const { sinceUnix, untilUnix } = toRange(args);

  const sampleRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', taken_at, 'unixepoch', 'localtime') AS day,
           app_bundle, COUNT(*) AS sample_count
    FROM samples
    WHERE taken_at >= ? AND taken_at <= ?
    GROUP BY day, app_bundle
  `).all(sinceUnix, untilUnix) as { day: string; app_bundle: string | null; sample_count: number }[];

  const meetingRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', started_at, 'unixepoch', 'localtime') AS day,
           SUM(ended_at - started_at) AS total_seconds
    FROM meetings
    WHERE started_at >= ? AND started_at <= ? AND ended_at IS NOT NULL
    GROUP BY day
  `).all(sinceUnix, untilUnix) as { day: string; total_seconds: number }[];

  const byDay = new Map<string, { coding: number; slack: number; other: number }>();
  for (const row of sampleRows) {
    const bucket = byDay.get(row.day) ?? { coding: 0, slack: 0, other: 0 };
    if (row.app_bundle && CODING_APP_BUNDLES.has(row.app_bundle)) {
      bucket.coding += row.sample_count;
    } else if (row.app_bundle === SLACK_APP_BUNDLE) {
      bucket.slack += row.sample_count;
    } else {
      bucket.other += row.sample_count;
    }
    byDay.set(row.day, bucket);
  }

  const meetingSecondsByDay = new Map(meetingRows.map((r) => [r.day, r.total_seconds]));
  const allDays = new Set([...byDay.keys(), ...meetingSecondsByDay.keys()]);

  return {
    days: [...allDays].sort().map((day) => {
      const b = byDay.get(day) ?? { coding: 0, slack: 0, other: 0 };
      return {
        day,
        codingHours: samplesToHours(b.coding),
        meetingHours: secondsToHours(meetingSecondsByDay.get(day) ?? 0),
        slackHours: samplesToHours(b.slack),
        otherHours: samplesToHours(b.other),
      };
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// AI leverage: tool_usage calls per day, top tools, skills invoked
// ─────────────────────────────────────────────────────────────────────────

export interface AiLeverageResult {
  perDay: { day: string; calls: number }[];
  topTools: { name: string; calls: number }[];
  skillsInvoked: { name: string; calls: number }[];
}

export function getAiLeverage(args: AnalyticsRangeArgs & { limit?: number }): AiLeverageResult {
  const db = getDb();
  const { sinceUnix, untilUnix } = toRange(args);
  const limit = args.limit ?? 8;

  const perDay = db.prepare(`
    SELECT strftime('%Y-%m-%d', called_at, 'unixepoch', 'localtime') AS day, COUNT(*) AS calls
    FROM tool_usage
    WHERE called_at >= ? AND called_at <= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(sinceUnix, untilUnix) as { day: string; calls: number }[];

  const topTools = db.prepare(`
    SELECT name, COUNT(*) AS calls
    FROM tool_usage
    WHERE kind = 'tool' AND called_at >= ? AND called_at <= ?
    GROUP BY name
    ORDER BY calls DESC
    LIMIT ?
  `).all(sinceUnix, untilUnix, limit) as { name: string; calls: number }[];

  const skillsInvoked = db.prepare(`
    SELECT name, COUNT(*) AS calls
    FROM tool_usage
    WHERE kind = 'skill' AND called_at >= ? AND called_at <= ?
    GROUP BY name
    ORDER BY calls DESC
    LIMIT ?
  `).all(sinceUnix, untilUnix, limit) as { name: string; calls: number }[];

  return { perDay, topTools, skillsInvoked };
}

// ─────────────────────────────────────────────────────────────────────────
// Meeting load: hours per week, count, average length
// ─────────────────────────────────────────────────────────────────────────

export interface MeetingLoadWeekRow {
  week: string; // "YYYY-Www", localtime
  hours: number;
  count: number;
  avgMinutes: number;
}

export interface MeetingLoadResult {
  weeks: MeetingLoadWeekRow[];
}

export function getMeetingLoad(args: AnalyticsRangeArgs): MeetingLoadResult {
  const db = getDb();
  const { sinceUnix, untilUnix } = toRange(args);

  const rows = db.prepare(`
    SELECT strftime('%Y-W%W', started_at, 'unixepoch', 'localtime') AS week,
           COUNT(*) AS count,
           SUM(ended_at - started_at) AS total_seconds
    FROM meetings
    WHERE started_at >= ? AND started_at <= ? AND ended_at IS NOT NULL
    GROUP BY week
    ORDER BY week ASC
  `).all(sinceUnix, untilUnix) as { week: string; count: number; total_seconds: number }[];

  return {
    weeks: rows.map((r) => ({
      week: r.week,
      hours: secondsToHours(r.total_seconds),
      count: r.count,
      avgMinutes: Math.round(r.total_seconds / r.count / 60),
    })),
  };
}
