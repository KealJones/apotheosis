import { getDb } from '../db.js';
import { readUserConfig } from '../userConfig.js';
import {
  groupIntoBlocks,
  SampleRow,
  WorkBlock,
  JIRA_PATTERN,
  PR_URL_PATTERN,
  REPO_PATH_PATTERN,
} from '../summarize.js';

export interface TriageSamplesArgs {
  date: string;
  compact?: boolean;
}

type Signal = 'high' | 'medium' | 'low';

export interface TriageCluster {
  app_name: string | null;
  window_title: string | null;
  sample_ids: number[];
  start: string;
  end: string;
  duration_min: number;
  signal: Signal;
  ocr_excerpt?: string;
}

export interface TriageSamplesResult {
  date: string;
  total_samples: number;
  total_clusters: number;
  by_signal: { high: number; medium: number; low: number };
  clusters: TriageCluster[];
}

/** Apps where nearly everything is work: Slack is only the work workspace. */
const WORK_APPS = new Set(['com.tinyspeck.slackmacgap']);

/** AI coding apps: work more often than not, but they also host side projects. */
const AI_APPS = new Set(['com.anthropic.claudefordesktop', 'com.conductor.app', 'com.openai.codex']);

/**
 * Pages where reading counts as work even when nothing gets produced: code review, tickets,
 * docs, training. Matched against the window title and URL. Company-specific places
 * (your org's domains and repos) come from `work_patterns` in user-config.json.
 */
const GENERIC_WORK_PLACES = ['jira', 'confluence', 'figma', 'figjam', 'datadog', 'myworkday', 'workday'];

/** Built per call so user-config edits apply without a restart. Bad user regex is skipped, not fatal. */
export function workPlacesPattern(extra: string[] = readUserConfig().work_patterns ?? []): RegExp {
  const valid = extra.filter((p) => {
    try {
      new RegExp(p);
      return true;
    } catch {
      return false;
    }
  });
  return new RegExp([...GENERIC_WORK_PLACES, ...valid].map((p) => `(?:${p})`).join('|'), 'i');
}

/** Browser counterparts of AI_APPS, plus GitHub outside the org (library issues, side repos). */
const MAYBE_WORK_PLACES = /claude\.ai|chatgpt\.com| - Claude\b|Claude Code|github\.com/i;

/** Ticket keys in OCR need a tighter match than in titles: OCR is full of "UTF-8"-like noise. */
const OCR_JIRA_PATTERN = /\b[A-Z]{2,10}-\d{2,6}\b/;

export function scoreBlock(block: WorkBlock, workPlaces: RegExp = workPlacesPattern()): Signal {
  const place = `${block.window_title ?? ''} ${block.url ?? ''}`;

  if (
    WORK_APPS.has(block.app_bundle ?? '') ||
    workPlaces.test(place) ||
    JIRA_PATTERN.test(place) ||
    PR_URL_PATTERN.test(place) ||
    OCR_JIRA_PATTERN.test(block.ocr_excerpt)
  ) {
    return 'high';
  }

  // Time on screen alone is a weak signal (a long video is still a video), so it caps at medium.
  if (
    AI_APPS.has(block.app_bundle ?? '') ||
    MAYBE_WORK_PLACES.test(place) ||
    REPO_PATH_PATTERN.test(`${place} ${block.ocr_excerpt}`) ||
    block.duration_min >= 10
  ) {
    return 'medium';
  }

  return 'low';
}

export function getTriageSamples(args: TriageSamplesArgs): TriageSamplesResult {
  const db = getDb();

  // Parse yyyy-mm-dd as local time
  const [y, m, d] = args.date.split('-').map(Number);
  const dayStart = Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000);
  const dayEnd = Math.floor(new Date(y, m - 1, d, 23, 59, 59, 999).getTime() / 1000);

  const rows = db.prepare(`
    SELECT id, taken_at, app_bundle, app_name, window_title, url,
           screenshot_path, ocr_text, active_seconds, is_evidence,
           document_path, selected_text, focused_element
    FROM samples
    WHERE taken_at >= ? AND taken_at <= ? AND is_evidence = 0
    ORDER BY taken_at ASC
  `).all(dayStart, dayEnd) as SampleRow[];

  const blocks = groupIntoBlocks(rows);
  const workPlaces = workPlacesPattern();

  const clusters: TriageCluster[] = blocks.map(block => {
    const signal = scoreBlock(block, workPlaces);

    const cluster: TriageCluster = {
      app_name: block.app_name,
      window_title: block.window_title,
      sample_ids: block.sample_ids,
      start: block.start,
      end: block.end,
      duration_min: block.duration_min,
      signal,
    };
    if (!args.compact) {
      cluster.ocr_excerpt = block.ocr_excerpt;
    }
    return cluster;
  });

  return {
    date: args.date,
    total_samples: rows.length,
    total_clusters: clusters.length,
    by_signal: {
      high: clusters.filter(c => c.signal === 'high').length,
      medium: clusters.filter(c => c.signal === 'medium').length,
      low: clusters.filter(c => c.signal === 'low').length,
    },
    clusters,
  };
}
