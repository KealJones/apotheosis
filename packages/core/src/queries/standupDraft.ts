import * as path from 'node:path';
import { getDb } from '../db.js';
import { groupIntoBlocks, groupIntoSessions, SampleRow } from '../summarize.js';
import { getPendingReviews, PrItem } from '../integrations/github.js';
import { getSlackActivity, type SlackActivityResult } from './slackActivity.js';
import { getClaudeSessions, type ClaudeSession } from './claudeSessions.js';

export interface StandupDraftArgs {
  date?: string;
  compact?: boolean;
  /** ISO8601 start of the "yesterday" range. Overrides the default (the day before `date`). */
  since?: string;
  /** ISO8601 end of the "yesterday" range. */
  until?: string;
}

interface Commitment {
  id: number;
  source: string;
  source_ref: string;
  title: string;
  detail: string | null;
  detected_at: number;
}

interface Idea {
  id: number;
  body: string;
  source: string | null;
  created_at: number;
}

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfDay(dateStr: string): Date {
  // Parse yyyy-mm-dd as local midnight
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

interface MeetingRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  title: string | null;
  platform: string | null;
  summary: string | null;
}

interface MeetingActionItem {
  task: string;
  assignee?: string;
}

export interface StandupDraftResult {
  date: string;
  yesterday: string;
  yesterday_sessions: unknown[];
  yesterday_blocks?: unknown[];
  slack: SlackActivityResult;
  claude_sessions: ClaudeSession[];
  pending_commitments: {
    id: number;
    source: string;
    source_ref: string;
    title: string;
    detail: string | null;
    detected_at: string;
  }[];
  open_prs: PrItem[];
  recent_ideas: {
    id: number;
    body: string;
    source: string | null;
    created_at: string;
  }[];
  meetings: {
    id: number;
    title: string | null;
    start: string;
    duration_seconds: number | null;
    platform: string | null;
    has_summary: boolean;
  }[];
  action_items_from_meetings: {
    task: string;
    assignee: string | null;
    meeting_title: string | null;
  }[];
  context_summary: {
    event_counts: { event_type: string; count: number }[];
    files_modified: (string | null)[];
  };
}

const MAX_DIRS = 25;

/**
 * A busy day touches thousands of files (one repo checkout alone can be 9k), so compact mode
 * reports the directories they sit in, busiest first: "/repo/src/ (12 files)".
 */
function byDirectory(paths: string[]): string[] {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const dir = path.dirname(p);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DIRS)
    .map(([dir, n]) => `${dir}/ (${n} file${n === 1 ? '' : 's'})`);
}

export function getStandupDraft(args: StandupDraftArgs): StandupDraftResult {
  const db = getDb();

  const today = args.date ?? localDateString(new Date());
  const todayDate = startOfDay(today);

  // Yesterday = one day before today
  const yesterdayDate = new Date(todayDate);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = localDateString(yesterdayDate);

  // Yesterday full day bounds in unix seconds, unless the caller gave a range
  const yesterdayStart = Math.floor((args.since ? new Date(args.since) : yesterdayDate).getTime() / 1000);
  const yesterdayEnd = args.until
    ? Math.floor(new Date(args.until).getTime() / 1000)
    : Math.floor(todayDate.getTime() / 1000) - 1;

  // Yesterday's work blocks
  const samples = db.prepare(`
    SELECT id, taken_at, app_bundle, app_name, window_title, url,
           screenshot_path, ocr_text, active_seconds, is_evidence,
           document_path, selected_text, focused_element
    FROM samples
    WHERE taken_at >= ? AND taken_at <= ?
    ORDER BY taken_at ASC
  `).all(yesterdayStart, yesterdayEnd) as SampleRow[];

  const yesterdayBlocks = groupIntoBlocks(samples, { compact: args.compact });
  const yesterdaySessions = groupIntoSessions(yesterdayBlocks);

  // Pending commitments (not yet resolved/dismissed)
  const pendingFollowUps = db.prepare(`
    SELECT id, source, source_ref, title, detail, detected_at
    FROM commitments
    WHERE status = 'open'
    ORDER BY detected_at DESC
    LIMIT 20
  `).all() as Commitment[];

  // Open PRs via gh
  const openPrs = getPendingReviews();

  // Recent ideas (last 24h)
  const since24h = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  const recentIdeas = db.prepare(`
    SELECT id, body, source, created_at
    FROM ideas
    WHERE created_at >= ?
    ORDER BY created_at DESC
  `).all(since24h) as Idea[];

  // Meetings attended yesterday
  const meetings = db.prepare(`
    SELECT id, started_at, ended_at, title, platform, summary
    FROM meetings
    WHERE started_at >= ? AND started_at <= ?
    ORDER BY started_at ASC
  `).all(yesterdayStart, yesterdayEnd) as MeetingRow[];

  // Extract action items from meetings with summaries
  const allActionItems: { task: string; assignee: string | null; meeting_title: string | null }[] = [];
  for (const meeting of meetings) {
    if (meeting.summary) {
      try {
        const summary = JSON.parse(meeting.summary);
        if (summary.action_items && Array.isArray(summary.action_items)) {
          for (const item of summary.action_items) {
            allActionItems.push({
              task:
                typeof item === 'string' ? item : item.task || JSON.stringify(item),
              assignee: typeof item === 'object' ? item.assignee : null,
              meeting_title: meeting.title,
            });
          }
        }
      } catch {
        // Ignore JSON parse errors - summary may not be JSON
      }
    }
  }

  // Context events summary (app switches, window focus, title changes, file modifications)
  const eventCounts = db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM context_events
    WHERE taken_at >= ? AND taken_at <= ?
    GROUP BY event_type
  `).all(yesterdayStart, yesterdayEnd) as { event_type: string; count: number }[];

  const modifiedFiles = db.prepare(`
    SELECT DISTINCT document_path
    FROM context_events
    WHERE taken_at >= ? AND taken_at <= ? AND event_type = 'file_modified'
    AND document_path IS NOT NULL
    ORDER BY document_path
  `).all(yesterdayStart, yesterdayEnd) as { document_path: string }[];

  const result: Record<string, unknown> = {
    date: today,
    yesterday,
    yesterday_sessions: yesterdaySessions.map(({ sample_ids, ...rest }) => rest),
    slack: getSlackActivity({ since: yesterdayStart, until: yesterdayEnd }, db),
    claude_sessions: getClaudeSessions({ since: yesterdayStart, until: yesterdayEnd }),
    pending_commitments: pendingFollowUps.map(f => ({
      id: f.id,
      source: f.source,
      source_ref: f.source_ref,
      title: f.title,
      detail: f.detail,
      detected_at: new Date(f.detected_at * 1000).toISOString(),
    })),
    open_prs: openPrs,
    recent_ideas: recentIdeas.map(i => ({
      id: i.id,
      body: i.body,
      source: i.source,
      created_at: new Date(i.created_at * 1000).toISOString(),
    })),
    meetings: meetings.map(m => ({
      id: m.id,
      title: m.title,
      start: new Date(m.started_at * 1000).toISOString(),
      duration_seconds: m.ended_at != null ? m.ended_at - m.started_at : null,
      platform: m.platform,
      has_summary: m.summary != null && m.summary.length > 0,
    })),
    action_items_from_meetings: allActionItems,
    context_summary: {
      event_counts: eventCounts,
      files_modified: args.compact
        ? byDirectory(modifiedFiles.map(f => f.document_path))
        : modifiedFiles.map(f => f.document_path),
    },
  };

  // In non-compact mode, also include raw blocks for backward compatibility
  if (!args.compact) {
    result.yesterday_blocks = yesterdayBlocks.map(({ sample_ids, ...rest }) => rest);
  }

  return result as unknown as StandupDraftResult;
}
