import { getDb, type Db } from '../db.js';
import { readUserConfig } from '../userConfig.js';

export interface MentionsArgs {
  since: string;
  compact?: boolean;
}

interface SampleRow {
  id: number;
  taken_at: number;
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  ocr_text: string | null;
  screenshot_path: string;
}

export interface MentionResult {
  sample_id: number;
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  when: string;
  context_excerpt: string;
  screenshot_path: string;
  match: string;
}

export interface GroupedMention {
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  mention_count: number;
  mentions: MentionResult[];
}

export interface CompactGroupedMention {
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  mention_count: number;
  first_seen: string;
  last_seen: string;
}

function loadMentionPatterns(): Array<{ re: RegExp; label: string }> {
  const patterns = readUserConfig().mention_patterns;
  if (!Array.isArray(patterns)) return [];
  return patterns.map((p: string) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { re: new RegExp(escaped, 'gi'), label: p };
  });
}

function extractContext(text: string, index: number, matchLen: number, windowSize = 150): string {
  const start = Math.max(0, index - windowSize);
  const end = Math.min(text.length, index + matchLen + windowSize);
  let excerpt = text.slice(start, end).trim();
  if (start > 0) excerpt = '…' + excerpt;
  if (end < text.length) excerpt = excerpt + '…';
  return excerpt;
}

/**
 * Shared mention scanning logic — reusable by get_inbox and other tools.
 * Returns fully grouped mention results.
 */
export function scanAndGroupMentions(db: Db, sinceUnix: number): GroupedMention[] {
  const rows = db.prepare(`
    SELECT id, taken_at, app_name, window_title, url, ocr_text, screenshot_path
    FROM samples
    WHERE taken_at >= ? AND ocr_text IS NOT NULL
    ORDER BY taken_at ASC
  `).all(sinceUnix) as SampleRow[];

  const mentions: MentionResult[] = [];

  for (const row of rows) {
    if (!row.ocr_text) continue;

    const patterns = loadMentionPatterns();
    for (const { re, label } of patterns) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(row.ocr_text)) !== null) {
        mentions.push({
          sample_id: row.id,
          app_name: row.app_name,
          window_title: row.window_title,
          url: row.url,
          when: new Date(row.taken_at * 1000).toISOString(),
          context_excerpt: extractContext(row.ocr_text, match.index, match[0].length),
          screenshot_path: row.screenshot_path,
          match: label,
        });
      }
    }
  }

  // Group by (app_name, window_title, url)
  const grouped = new Map<string, MentionResult[]>();
  for (const m of mentions) {
    const key = `${m.app_name}||${m.window_title}||${m.url}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(m);
  }

  return Array.from(grouped.values()).map(group => ({
    app_name: group[0].app_name,
    window_title: group[0].window_title,
    url: group[0].url,
    mention_count: group.length,
    mentions: group,
  }));
}

export function getMentions(args: MentionsArgs): GroupedMention[] | CompactGroupedMention[] {
  const db = getDb();
  const sinceMs = Math.floor(new Date(args.since).getTime() / 1000);

  const groups = scanAndGroupMentions(db, sinceMs);

  if (args.compact) {
    return groups.map(g => ({
      app_name: g.app_name,
      window_title: g.window_title,
      url: g.url,
      mention_count: g.mention_count,
      first_seen: g.mentions[0].when,
      last_seen: g.mentions[g.mentions.length - 1].when,
    }));
  }

  return groups;
}
