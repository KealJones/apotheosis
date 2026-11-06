/**
 * Citeable evidence for the review scorer.
 *
 * evidence_report returns aggregate, id-less payloads (standups without ids,
 * PRs only as a count in links_by_kind), which the scorer cannot cite. This
 * module reads the same tables with the same filters, but every item carries a
 * `ref` that points at exactly one real record, and `getEvidenceItem(ref)`
 * re-reads that record so a citation can always be checked end to end.
 *
 * Integrity: nothing here synthesizes evidence. If a record is deleted, it
 * disappears from `collectEvidence` and `getEvidenceItem` returns null.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir, getDb } from '../db.js';
import {
  AI_USAGE_LOG_FILE_RE,
  DEFAULT_SLACK_SIGNALS,
  getAiUsageLogDir,
  readAiUsageLog,
} from '../queries/evidenceReport.js';

/** Every source name a criterion's `evidence_sources` may use. */
export const EVIDENCE_SOURCES = [
  'projects',
  'standups',
  'prs',
  'meetings',
  'ideas',
  'ai_usage_wins',
  'slack_signals',
  'code_time',
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export function isEvidenceSource(s: string): s is EvidenceSource {
  return (EVIDENCE_SOURCES as readonly string[]).includes(s);
}

/**
 * Sources that exist but can never produce a citeable item. `code_time` is an
 * aggregate estimate (sample counts x 15s per repo, plus git log), not a
 * record, so there is nothing a citation could point at. It is kept as a
 * known source so the ladder config validates, and the UI says why it adds
 * nothing rather than silently ignoring it.
 */
export const UNCITEABLE_SOURCES: Partial<Record<EvidenceSource, string>> = {
  code_time:
    'Aggregate coding-time estimates are not individual records, so they cannot be cited. ' +
    'Code fluency has to be shown through PRs and projects instead.',
};

export interface EvidenceItem {
  /** Stable citation id, `<source>:<key>`. The only thing the scorer may cite. */
  ref: string;
  source: EvidenceSource;
  /** Where the record lives: a table name, or `file` for the AI usage log. */
  store: string;
  /** Row id (or filename for the AI usage log). */
  key: string;
  /** ISO date/time the record is about. */
  date: string;
  title: string;
  /** Plain-text body the model reads. */
  text: string;
  /** Link to the record inside the dashboard. */
  href: string;
  /** Link to the record's origin (PR, Slack permalink), when one exists. */
  external_url: string | null;
}

export interface EvidenceRange {
  since: string;
  until: string;
}

function toUnix(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) throw new Error(`Invalid date: ${iso}`);
  return Math.floor(t / 1000);
}

export function evidenceHref(ref: string): string {
  return `/review/evidence/${encodeURIComponent(ref)}`;
}

function item(
  source: EvidenceSource,
  store: string,
  key: string | number,
  fields: Omit<EvidenceItem, 'ref' | 'source' | 'store' | 'key' | 'href'>
): EvidenceItem {
  const ref = `${source}:${key}`;
  return { ref, source, store, key: String(key), href: evidenceHref(ref), ...fields };
}

function joinLines(parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join('\n');
}

// ── Row mappers (shared by the range collectors and the single-row lookup) ────

interface StandupRow { id: number; date: string; yesterday: string | null; today: string | null; blockers: string | null }
function standupItem(r: StandupRow): EvidenceItem {
  return item('standups', 'standups', r.id, {
    date: r.date.slice(0, 10),
    title: `Standup ${r.date.slice(0, 10)}`,
    text: joinLines([
      r.yesterday && `Done: ${r.yesterday}`,
      r.today && `Planned: ${r.today}`,
      r.blockers && `Blockers: ${r.blockers}`,
    ]),
    external_url: null,
  });
}

interface ProjectRow {
  id: number; slug: string; name: string; description: string | null; status: string | null;
  created_at: number; links_in_range: number; first_activity: number | null; last_activity: number | null;
}
function projectItem(r: ProjectRow): EvidenceItem {
  const span =
    r.first_activity != null && r.last_activity != null
      ? `Linked activity ${new Date(r.first_activity * 1000).toISOString().slice(0, 10)} to ` +
        `${new Date(r.last_activity * 1000).toISOString().slice(0, 10)} (${r.links_in_range} linked records)`
      : null;
  return item('projects', 'projects', r.id, {
    date: new Date(r.created_at).toISOString(),
    title: `Project: ${r.name}`,
    text: joinLines([
      `${r.name} (${r.slug})${r.status ? `, status ${r.status}` : ''}`,
      r.description,
      span,
    ]),
    external_url: null,
  });
}

interface PrRow { rowid: number; external_id: string; created_at: number; project_name: string; project_slug: string }
function prItem(r: PrRow): EvidenceItem {
  const isUrl = /^https?:\/\//.test(r.external_id);
  return item('prs', 'project_links', r.rowid, {
    date: new Date(r.created_at).toISOString(),
    title: `PR ${r.external_id.replace(/^https:\/\/github\.com\//, '')}`,
    text: `Pull request ${r.external_id}, linked to project ${r.project_name} (${r.project_slug})`,
    external_url: isUrl ? r.external_id : null,
  });
}

interface MeetingRow { id: number; started_at: number; ended_at: number | null; title: string | null; platform: string | null; summary: string | null }
function meetingItem(r: MeetingRow): EvidenceItem {
  let summaryText: string | null = null;
  if (r.summary) {
    try {
      const s = JSON.parse(r.summary) as Record<string, unknown>;
      const list = (k: string) => (Array.isArray(s[k]) ? (s[k] as unknown[]).filter((x) => typeof x === 'string') as string[] : []);
      summaryText = joinLines([
        typeof s.tldr === 'string' && `Summary: ${s.tldr}`,
        list('my_contributions').length > 0 && `My contributions: ${list('my_contributions').join('; ')}`,
        list('decisions').length > 0 && `Decisions: ${list('decisions').join('; ')}`,
      ]);
    } catch {
      summaryText = `Summary: ${r.summary}`;
    }
  }
  const minutes = r.ended_at != null ? Math.round((r.ended_at - r.started_at) / 60) : null;
  return item('meetings', 'meetings', r.id, {
    date: new Date(r.started_at * 1000).toISOString(),
    title: `Meeting: ${r.title ?? 'Untitled'}`,
    text: joinLines([
      `${r.title ?? 'Untitled meeting'}${r.platform ? ` on ${r.platform}` : ''}${minutes != null ? `, ${minutes} min` : ''}`,
      summaryText ?? 'No summary generated.',
    ]),
    external_url: null,
  });
}

interface IdeaRow { id: number; body: string; source: string | null; created_at: number }
function ideaItem(r: IdeaRow): EvidenceItem {
  return item('ideas', 'ideas', r.id, {
    date: new Date(r.created_at).toISOString(),
    title: `Idea: ${r.body.slice(0, 60)}`,
    text: r.body,
    external_url: null,
  });
}

interface SlackRow { id: number; captured_at: number; channel: string | null; sender: string; text: string; permalink: string | null }
function slackItem(r: SlackRow, myName: string | null): EvidenceItem {
  const fromMe = myName != null && r.sender.toLowerCase().startsWith(myName.toLowerCase());
  return item('slack_signals', 'slack_messages', r.id, {
    date: new Date(r.captured_at * 1000).toISOString(),
    title: `Slack ${r.channel ? `#${r.channel}` : ''} from ${r.sender}`.replace(/\s+/g, ' '),
    text: `${fromMe ? 'Sent by me' : `From ${r.sender} (not me)`}${r.channel ? ` in ${r.channel}` : ''}: ${r.text}`,
    external_url: r.permalink,
  });
}

function aiWinItem(file: string, date: string, content: string): EvidenceItem {
  const heading = content.split('\n').find((l) => l.trim().startsWith('#'))?.replace(/^#+\s*/, '').trim();
  return item('ai_usage_wins', 'file', file, {
    date,
    title: `AI usage win: ${heading || file}`,
    text: content,
    external_url: null,
  });
}

/** The user's own Slack display name, so recognition *from others* can be told apart. */
function myDisplayName(): string | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(getDataDir(), 'user-config.json'), 'utf8'));
    return typeof cfg.display_name === 'string' && cfg.display_name.trim() ? cfg.display_name.trim() : null;
  } catch {
    return null;
  }
}

const SLACK_LIKE = DEFAULT_SLACK_SIGNALS.map(() => 'LOWER(text) LIKE ?').join(' OR ');
const SLACK_PARAMS = DEFAULT_SLACK_SIGNALS.map((k) => `%${k.toLowerCase()}%`);

const PROJECT_SELECT = `
  SELECT p.id, p.slug, p.name, p.description, p.status, p.created_at,
         COUNT(s.id) AS links_in_range, MIN(s.taken_at) AS first_activity, MAX(s.taken_at) AS last_activity
  FROM projects p
  LEFT JOIN project_links pl ON pl.project_id = p.id AND pl.kind = 'sample'
  LEFT JOIN samples s ON s.id = CAST(pl.external_id AS INTEGER) AND s.taken_at >= ? AND s.taken_at <= ?`;

// ── Range collectors, one per citeable source ────────────────────────────────

type Collector = (r: { sinceUnix: number; untilUnix: number; sinceDate: string; untilDate: string }) => EvidenceItem[];

const COLLECTORS: Record<EvidenceSource, Collector> = {
  standups: ({ sinceDate, untilDate }) =>
    (getDb().prepare(`
      SELECT id, date, yesterday, today, blockers FROM standups
      WHERE substr(date, 1, 10) >= ? AND substr(date, 1, 10) <= ? ORDER BY date
    `).all(sinceDate, untilDate) as StandupRow[]).map(standupItem),

  // A project counts if it was created in range or has linked samples taken in range.
  projects: ({ sinceUnix, untilUnix }) =>
    (getDb().prepare(`${PROJECT_SELECT}
      GROUP BY p.id
      HAVING (p.created_at >= ? AND p.created_at <= ?) OR COUNT(s.id) > 0
      ORDER BY p.created_at
    `).all(sinceUnix, untilUnix, sinceUnix * 1000, untilUnix * 1000) as ProjectRow[]).map(projectItem),

  prs: ({ sinceUnix, untilUnix }) =>
    (getDb().prepare(`
      SELECT pl.rowid AS rowid, pl.external_id, pl.created_at, p.name AS project_name, p.slug AS project_slug
      FROM project_links pl JOIN projects p ON p.id = pl.project_id
      WHERE pl.kind = 'pr' AND pl.created_at >= ? AND pl.created_at <= ?
      ORDER BY pl.created_at
    `).all(sinceUnix * 1000, untilUnix * 1000) as PrRow[]).map(prItem),

  meetings: ({ sinceUnix, untilUnix }) =>
    (getDb().prepare(`
      SELECT id, started_at, ended_at, title, platform, summary FROM meetings
      WHERE started_at >= ? AND started_at <= ? ORDER BY started_at
    `).all(sinceUnix, untilUnix) as MeetingRow[]).map(meetingItem),

  ideas: ({ sinceUnix, untilUnix }) =>
    (getDb().prepare(`
      SELECT id, body, source, created_at FROM ideas
      WHERE created_at >= ? AND created_at <= ? ORDER BY created_at
    `).all(sinceUnix * 1000, untilUnix * 1000) as IdeaRow[]).map(ideaItem),

  slack_signals: ({ sinceUnix, untilUnix }) => {
    const me = myDisplayName();
    return (getDb().prepare(`
      SELECT id, captured_at, channel, sender, text, permalink FROM slack_messages
      WHERE captured_at >= ? AND captured_at <= ? AND (${SLACK_LIKE})
      ORDER BY captured_at
    `).all(sinceUnix, untilUnix, ...SLACK_PARAMS) as SlackRow[]).map((r) => slackItem(r, me));
  },

  ai_usage_wins: ({ sinceDate, untilDate }) =>
    readAiUsageLog(sinceDate, untilDate).entries.map((e) => aiWinItem(e.file, e.date, e.content)),

  code_time: () => [],
};

export type EvidenceBySource = Record<EvidenceSource, EvidenceItem[]>;

/** All citeable evidence in range, by source. Collects only the sources asked for. */
export function collectEvidence(
  range: EvidenceRange,
  sources: readonly EvidenceSource[] = EVIDENCE_SOURCES
): EvidenceBySource {
  const sinceUnix = toUnix(range.since);
  const untilUnix = toUnix(range.until);
  const ctx = {
    sinceUnix,
    untilUnix,
    sinceDate: new Date(sinceUnix * 1000).toISOString().slice(0, 10),
    untilDate: new Date(untilUnix * 1000).toISOString().slice(0, 10),
  };
  const out = Object.fromEntries(EVIDENCE_SOURCES.map((s) => [s, [] as EvidenceItem[]])) as EvidenceBySource;
  for (const s of new Set(sources)) out[s] = COLLECTORS[s](ctx);
  return out;
}

/**
 * Re-read the single record behind a citation. Returns null if it no longer
 * exists, which is what lets the UI and tests prove a citation is real.
 */
export function getEvidenceItem(ref: string): EvidenceItem | null {
  const idx = ref.indexOf(':');
  if (idx <= 0) return null;
  const source = ref.slice(0, idx);
  const key = ref.slice(idx + 1);
  if (!isEvidenceSource(source)) return null;
  const db = getDb();
  const id = /^\d+$/.test(key) ? Number(key) : null;

  switch (source) {
    case 'standups': {
      if (id == null) return null;
      const r = db.prepare('SELECT id, date, yesterday, today, blockers FROM standups WHERE id = ?').get(id) as StandupRow | undefined;
      return r ? standupItem(r) : null;
    }
    case 'projects': {
      if (id == null) return null;
      const r = db.prepare(`${PROJECT_SELECT} WHERE p.id = ? GROUP BY p.id`).get(0, Number.MAX_SAFE_INTEGER, id) as ProjectRow | undefined;
      return r ? projectItem(r) : null;
    }
    case 'prs': {
      if (id == null) return null;
      const r = db.prepare(`
        SELECT pl.rowid AS rowid, pl.external_id, pl.created_at, p.name AS project_name, p.slug AS project_slug
        FROM project_links pl JOIN projects p ON p.id = pl.project_id
        WHERE pl.rowid = ? AND pl.kind = 'pr'
      `).get(id) as PrRow | undefined;
      return r ? prItem(r) : null;
    }
    case 'meetings': {
      if (id == null) return null;
      const r = db.prepare('SELECT id, started_at, ended_at, title, platform, summary FROM meetings WHERE id = ?').get(id) as MeetingRow | undefined;
      return r ? meetingItem(r) : null;
    }
    case 'ideas': {
      if (id == null) return null;
      const r = db.prepare('SELECT id, body, source, created_at FROM ideas WHERE id = ?').get(id) as IdeaRow | undefined;
      return r ? ideaItem(r) : null;
    }
    case 'slack_signals': {
      if (id == null) return null;
      const r = db.prepare('SELECT id, captured_at, channel, sender, text, permalink FROM slack_messages WHERE id = ?').get(id) as SlackRow | undefined;
      return r ? slackItem(r, myDisplayName()) : null;
    }
    case 'ai_usage_wins': {
      // The filename regex doubles as the path-traversal guard.
      const m = key.match(AI_USAGE_LOG_FILE_RE);
      if (!m) return null;
      try {
        return aiWinItem(key, m[1], fs.readFileSync(path.join(getAiUsageLogDir(), key), 'utf8'));
      } catch {
        return null;
      }
    }
    case 'code_time':
      return null;
  }
}

/** Content hash of an item, so an edited record invalidates cached scores too. */
export function itemFingerprint(i: EvidenceItem): string {
  return createHash('sha256').update(`${i.ref}\u0000${i.date}\u0000${i.text}`).digest('hex').slice(0, 16);
}
