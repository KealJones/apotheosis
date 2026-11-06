import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDb } from '../db.js';

// Curated AI-usage wins written by the log-ai-use skill live here, not in the DB.
// APOTHEOSIS_AI_USAGE_LOG_DIR overrides it (tests point it at a temp dir).
export function getAiUsageLogDir(): string {
  return process.env.APOTHEOSIS_AI_USAGE_LOG_DIR ?? path.join(os.homedir(), 'ai-usage-log');
}

/** Dated entry files the log-ai-use skill writes; the date prefix is the entry's date. */
export const AI_USAGE_LOG_FILE_RE = /^(\d{4}-\d{2}-\d{2})-ai-log-[\w-]+\.md$/;

export function readAiUsageLog(sinceDate: string, untilDate: string) {
  const dir = getAiUsageLogDir();
  const entries: { date: string; file: string; content: string }[] = [];
  let bestUsage: string | null = null;
  try {
    // User data outside the project, resolved at runtime; nothing for the bundler to trace.
    for (const file of fs.readdirSync(/*turbopackIgnore: true*/ dir)) {
      const full = path.join(dir, file);
      if (file === 'best-usage.md') {
        bestUsage = fs.readFileSync(full, 'utf8');
        continue;
      }
      const m = file.match(AI_USAGE_LOG_FILE_RE);
      if (!m) continue;
      const date = m[1];
      if (date < sinceDate || date > untilDate) continue;
      entries.push({ date, file, content: fs.readFileSync(full, 'utf8') });
    }
  } catch {
    // dir may not exist; leave empty
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return { entries, bestUsage };
}

// Default keywords that surface recognition, leadership, and impact moments in Slack.
export const DEFAULT_SLACK_SIGNALS = [
  'lead', 'baton', 'congrats', 'thank', 'thanks', 'shout out', 'shoutout',
  'kudos', 'great work', 'awesome', 'nice work', 'promotion', 'promoted',
  'rockstar', 'kicking ass', 'appreciate', 'lifesaver', 'saved',
];

export interface EvidenceReportArgs {
  since?: string;
  until?: string;
  slack_keywords?: string[];
  include_standups?: boolean;
}

interface MeetingRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  title: string | null;
  platform: string | null;
  summary: string | null;
}

export interface EvidenceReportResult {
  period: { since: string; until: string };
  projects: { slug: string; name: string; status: string | null; link_count: number }[];
  links_by_kind: { kind: string; n: number }[];
  evidence_sample_count: number;
  standups: { date: string; yesterday: string | null; today: string | null; blockers: string | null }[];
  meetings: {
    id: number;
    title: string | null;
    start: string;
    duration_seconds: number | null;
    platform: string | null;
    has_summary: boolean;
  }[];
  decisions_from_meetings: { decision: string; meeting_title: string | null }[];
  ai_usage: {
    totals: Record<string, number>;
    top: { kind: string; name: string; total_calls: number; last_used: string }[];
  };
  ai_usage_wins: {
    best: string | null;
    entries_in_range: { date: string; file: string; content: string }[];
  };
  ideas: { body: string; source: string | null; created_at: string }[];
  slack_signals: {
    captured_at: string;
    channel: string | null;
    sender: string;
    text: string;
    permalink: string | null;
  }[];
  _hint: string;
}

export function getEvidenceReport(args: EvidenceReportArgs): EvidenceReportResult {
  const db = getDb();

  const sinceUnix = args.since ? Math.floor(new Date(args.since).getTime() / 1000) : 0;
  const untilUnix = args.until
    ? Math.floor(new Date(args.until).getTime() / 1000)
    : Math.floor(Date.now() / 1000);
  const sinceDate = args.since ? args.since.slice(0, 10) : '0000-01-01';
  const untilDate = args.until ? args.until.slice(0, 10) : '9999-12-31';
  const includeStandups = args.include_standups !== false;

  // ── Projects + linked-evidence volume ──────────────────────────────────────
  const projects = db.prepare(`
    SELECT p.slug, p.name, p.status,
           COUNT(pl.external_id) AS link_count
    FROM projects p
    LEFT JOIN project_links pl ON pl.project_id = p.id
    GROUP BY p.id
    ORDER BY link_count DESC
  `).all() as { slug: string; name: string; status: string | null; link_count: number }[];

  // Linked-evidence breakdown by kind (pr, jira, sample, doc, ...)
  const linksByKind = db.prepare(`
    SELECT kind, COUNT(*) AS n FROM project_links GROUP BY kind ORDER BY n DESC
  `).all() as { kind: string; n: number }[];

  // ── Standups in range (primary narrative source) ───────────────────────────
  const standups = includeStandups
    ? db.prepare(`
        SELECT substr(date, 1, 10) AS date, yesterday, today, blockers
        FROM standups
        WHERE substr(date, 1, 10) >= ? AND substr(date, 1, 10) <= ?
        ORDER BY date
      `).all(sinceDate, untilDate) as {
        date: string; yesterday: string | null; today: string | null; blockers: string | null;
      }[]
    : [];

  // ── AI / tool usage in range ───────────────────────────────────────────────
  const usageTotals = db.prepare(`
    SELECT kind, COUNT(*) AS total
    FROM tool_usage
    WHERE called_at >= ? AND called_at <= ?
    GROUP BY kind
  `).all(sinceUnix, untilUnix) as { kind: string; total: number }[];

  const usageTop = db.prepare(`
    SELECT kind, name, COUNT(*) AS total_calls, MAX(called_at) AS last_used
    FROM tool_usage
    WHERE called_at >= ? AND called_at <= ?
    GROUP BY kind, name
    ORDER BY total_calls DESC
    LIMIT 25
  `).all(sinceUnix, untilUnix) as {
    kind: string; name: string; total_calls: number; last_used: number;
  }[];

  // ── Captured ideas in range ────────────────────────────────────────────────
  const ideas = db.prepare(`
    SELECT body, source, created_at
    FROM ideas
    WHERE created_at >= ? AND created_at <= ?
    ORDER BY created_at
  `).all(sinceUnix * 1000, untilUnix * 1000) as {
    body: string; source: string | null; created_at: number;
  }[];

  // ── Evidence-tagged sample count ───────────────────────────────────────────
  const evidenceCount = (db.prepare(
    `SELECT COUNT(*) AS n FROM samples WHERE is_evidence = 1`
  ).get() as { n: number }).n;

  // ── Meetings in range ────────────────────────────────────────────────────────
  const meetingRows = db.prepare(`
    SELECT id, started_at, ended_at, title, platform, summary
    FROM meetings
    WHERE started_at >= ? AND started_at <= ?
    ORDER BY started_at DESC
  `).all(sinceUnix, untilUnix) as MeetingRow[];

  // Extract decisions from meeting summaries
  const allDecisions: { decision: string; meeting_title: string | null }[] = [];
  for (const meeting of meetingRows) {
    if (meeting.summary) {
      try {
        const summary = JSON.parse(meeting.summary);
        if (summary.decisions && Array.isArray(summary.decisions)) {
          for (const decision of summary.decisions) {
            allDecisions.push({
              decision: typeof decision === 'string' ? decision : decision.text || JSON.stringify(decision),
              meeting_title: meeting.title,
            });
          }
        }
      } catch {
        // Ignore JSON parse errors - summary may not be JSON
      }
    }
  }

  // ── Slack recognition / leadership signals ─────────────────────────────────
  const keywords = (args.slack_keywords?.length ? args.slack_keywords : DEFAULT_SLACK_SIGNALS)
    .map(k => k.toLowerCase());
  const likeClause = keywords.map(() => 'LOWER(text) LIKE ?').join(' OR ');
  const likeParams = keywords.map(k => `%${k}%`);
  const slackSignals = db.prepare(`
    SELECT captured_at, channel, sender, text, permalink
    FROM slack_messages
    WHERE captured_at >= ? AND captured_at <= ? AND (${likeClause})
    ORDER BY captured_at DESC
    LIMIT 40
  `).all(sinceUnix, untilUnix, ...likeParams) as {
    captured_at: number; channel: string | null; sender: string;
    text: string; permalink: string | null;
  }[];

  // ── Curated AI-usage wins (log-ai-use skill output) ────────────────────────
  const aiLog = readAiUsageLog(sinceDate, untilDate);

  return {
    period: {
      since: args.since ?? 'all-time',
      until: args.until ?? new Date(untilUnix * 1000).toISOString(),
    },
    projects,
    links_by_kind: linksByKind,
    evidence_sample_count: evidenceCount,
    standups,
    meetings: meetingRows.map(m => ({
      id: m.id,
      title: m.title,
      start: new Date(m.started_at * 1000).toISOString(),
      duration_seconds: m.ended_at != null ? m.ended_at - m.started_at : null,
      platform: m.platform,
      has_summary: m.summary != null && m.summary.length > 0,
    })),
    decisions_from_meetings: allDecisions,
    ai_usage: {
      totals: Object.fromEntries(usageTotals.map(t => [t.kind, t.total])),
      top: usageTop.map(r => ({
        kind: r.kind,
        name: r.name,
        total_calls: r.total_calls,
        last_used: new Date(r.last_used * 1000).toISOString(),
      })),
    },
    ai_usage_wins: {
      best: aiLog.bestUsage,
      entries_in_range: aiLog.entries,
    },
    ideas: ideas.map(i => ({
      body: i.body,
      source: i.source,
      created_at: new Date(i.created_at).toISOString(),
    })),
    slack_signals: slackSignals.map(s => ({
      captured_at: new Date(s.captured_at * 1000).toISOString(),
      channel: s.channel,
      sender: s.sender,
      text: s.text,
      permalink: s.permalink,
    })),
    _hint:
      'Standups are the richest narrative source. ai_usage_wins holds curated, quantified AI ' +
      'impact entries (from the log-ai-use skill) — far stronger review evidence than the raw ' +
      'ai_usage call counts; lead the AI section with best + entries_in_range. Cross-reference ' +
      'projects + links_by_kind for scope, slack_signals for peer recognition and leadership ' +
      'moments (verify each quote before citing). Enrich with the GitHub MCP for PR/review counts.',
  };
}
