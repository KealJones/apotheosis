export interface SampleRow {
  id: number;
  taken_at: number;
  app_bundle: string | null;
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  screenshot_path: string;
  ocr_text: string | null;
  active_seconds: number | null;
  is_evidence: number;
  document_path: string | null;
  selected_text: string | null;
  focused_element: string | null;
}

export interface WorkBlock {
  start: string;       // ISO8601
  end: string;         // ISO8601
  duration_min: number;
  app_name: string | null;
  app_bundle: string | null;
  window_title: string | null;
  url: string | null;
  sample_count: number;
  sample_ids: number[];
  top_words: string[];
  ocr_excerpt: string;
  document_paths: string[];     // distinct file paths from AX document attribute
  selected_texts: string[];     // captured selected text snippets
  focused_elements: string[];   // focused element role+description
  metadata?: ExtractedMetadata; // jira_tickets, pr_urls, file_paths (present in compact mode, optional in default)
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'in', 'of', 'to', 'for', 'is', 'was', 'are', 'were',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'need', 'dare',
  'ought', 'used', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me',
  'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'all',
  'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'not', 'only', 'same', 'so', 'than', 'too', 'very', 'just', 'but', 'and',
  'or', 'nor', 'yet', 'with', 'at', 'by', 'from', 'up', 'about', 'into',
  'through', 'during', 'on', 'off', 'over', 'under', 'again', 'then', 'once',
  'here', 'there', 'any', 'if', 'as', 'because', 'while', 'although', 'since',
]);

export function getTopWords(texts: string[], topN = 10): string[] {
  const combined = texts.join(' ').toLowerCase();
  const words = combined.split(/\W+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));

  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word]) => word);
}

// ── Cleaning helpers ───────────────────────────────────────────────────────

/** Strip tracking params from URLs. Search engines keep ?q only; others drop query+fragment. */
export function cleanUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }

  if (/google\.|bing\.|duckduckgo\./i.test(parsed.hostname)) {
    const q = parsed.searchParams.get('q');
    return q
      ? `${parsed.protocol}//${parsed.host}${parsed.pathname}?q=${encodeURIComponent(q)}`
      : `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  }

  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

/** Strip trailing " - AppName" / " — AppName" suffix from window titles. */
export function cleanTitle(title: string, appName: string | null): string {
  if (!appName) return title;
  const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\s+[-–—]\\s+${escaped}.*$`, 'i');
  const cleaned = title.replace(re, '').trim();
  return cleaned || title;
}

/** Return true for filesystem paths (i.e. not http/https URLs). */
export function isFsPath(p: string): boolean {
  return !/^https?:\/\//i.test(p);
}

// ── Structured metadata patterns ────────────────────────────────────────────
// Shared extraction patterns — used by groupIntoSessions() and triage_samples
export const JIRA_PATTERN = /[A-Z]+-\d+/;
export const PR_URL_PATTERN = /github\.com\/.*\/pull\/\d+/i;
export const REPO_PATH_PATTERN = /\/(home|Users|workspace|src|projects|repos)\//i;

export interface ExtractedMetadata {
  jira_tickets: string[];
  pr_urls: string[];
  file_paths: string[];
}

const JIRA_DENYLIST = new Set(['UTF', 'ISO', 'UTC', 'SHA', 'RFC', 'AES', 'RGB', 'HSL', 'CSS', 'SQL', 'XML', 'HTML', 'HTTP', 'HTTPS', 'DNS', 'API', 'SDK', 'URL', 'URI', 'PNG', 'JPG', 'GIF', 'SVG', 'PDF', 'CSV', 'JSON', 'YAML', 'TOML']);

/** Scan text for JIRA tickets, PR URLs, and repo file paths. Returns deduplicated arrays. */
export function extractMetadata(texts: string[]): ExtractedMetadata {
  const combined = texts.join(' ');

  const jiraMatches = new Set<string>();
  const prMatches = new Set<string>();
  const pathMatches = new Set<string>();

  // Create global versions for matchAll (exported patterns are non-global for .test() compat)
  const jiraG = new RegExp(JIRA_PATTERN.source, 'g');
  const prG = new RegExp(PR_URL_PATTERN.source, 'gi');
  const pathG = new RegExp(REPO_PATH_PATTERN.source, 'gi');

  for (const m of combined.matchAll(jiraG)) {
    const prefix = m[0].split('-')[0];
    if (!JIRA_DENYLIST.has(prefix)) {
      jiraMatches.add(m[0]);
    }
  }
  for (const m of combined.matchAll(prG)) {
    prMatches.add(m[0]);
  }
  for (const m of combined.matchAll(pathG)) {
    // Grab from the match to the next whitespace for a meaningful path segment
    const startIdx = m.index!;
    const endIdx = combined.indexOf(' ', startIdx + m[0].length);
    const fullMatch = combined.slice(startIdx, endIdx === -1 ? undefined : endIdx);
    if (fullMatch.length < 200) pathMatches.add(fullMatch.trim());
  }

  return {
    jira_tickets: [...jiraMatches],
    pr_urls: [...prMatches],
    file_paths: [...pathMatches],
  };
}

export interface BlockOptions {
  compact?: boolean;          // omit ocr_excerpt, selected_texts, focused_elements
  min_duration_min?: number;  // filter blocks shorter than this
}

const GAP_THRESHOLD_S = 10 * 60; // 10 minutes in seconds

export function groupIntoBlocks(samples: SampleRow[], options?: BlockOptions): WorkBlock[] {
  if (samples.length === 0) return [];

  // Sort by taken_at ascending
  const sorted = [...samples].sort((a, b) => a.taken_at - b.taken_at);

  const blocks: WorkBlock[] = [];
  let blockSamples: SampleRow[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const sameContext =
      curr.app_bundle === prev.app_bundle &&
      curr.window_title === prev.window_title;
    const smallGap = curr.taken_at - prev.taken_at <= GAP_THRESHOLD_S;

    if (sameContext && smallGap) {
      blockSamples.push(curr);
    } else {
      blocks.push(makeBlock(blockSamples, options?.compact));
      blockSamples = [curr];
    }
  }
  blocks.push(makeBlock(blockSamples, options?.compact));

  const minDur = options?.min_duration_min;
  if (minDur != null) {
    return blocks.filter(b => b.duration_min >= minDur);
  }
  return blocks;
}

// ── Session merging ─────────────────────────────────────────────────────────
// Groups WorkBlocks into higher-level sessions by app, merging blocks < 5 min apart.

const DEFAULT_SESSION_GAP_S = 5 * 60; // 5 minutes in seconds

export interface Session {
  start: string;              // ISO8601 — earliest block start
  end: string;                // ISO8601 — latest block end
  duration_min: number;       // total duration from first start to last end
  app_name: string | null;
  app_bundle: string | null;
  window_titles: string[];    // distinct titles visited during session
  urls?: string[];            // distinct URLs visited (omitted when empty)
  sample_count: number;       // sum of all block sample counts
  sample_ids: number[];       // aggregated from all blocks
  top_words?: string[];       // re-computed from all block OCR (top 10, omitted when empty)
  block_count: number;        // how many blocks were merged
  metadata: ExtractedMetadata;  // jira_tickets, pr_urls, file_paths
  document_paths?: string[];  // distinct file paths from AX document attribute (omitted when empty)
  selected_texts?: string[];  // captured selected text snippets (omitted when empty)
  focused_elements?: string[]; // distinct focused element descriptions (omitted when empty)
}

export function groupIntoSessions(blocks: WorkBlock[], gapMinutes?: number): Session[] {
  if (blocks.length === 0) return [];

  // Sort blocks by start time
  const sorted = [...blocks].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  // Map: app_bundle -> list of session-builders (each is an array of blocks)
  const sessionMap = new Map<string, WorkBlock[][]>();

  for (const block of sorted) {
    const key = block.app_bundle ?? '__unknown__';
    if (!sessionMap.has(key)) {
      sessionMap.set(key, [[block]]);
      continue;
    }

    const sessions = sessionMap.get(key)!;
    const lastSession = sessions[sessions.length - 1];
    const lastBlock = lastSession[lastSession.length - 1];
    const lastEndSec = new Date(lastBlock.end).getTime() / 1000;
    const currStartSec = new Date(block.start).getTime() / 1000;

    const gapS = gapMinutes != null ? gapMinutes * 60 : DEFAULT_SESSION_GAP_S;
    if (currStartSec - lastEndSec <= gapS) {
      lastSession.push(block);
    } else {
      sessions.push([block]);
    }
  }

  // Flatten and build Session objects
  const allSessions: Session[] = [];
  for (const sessions of sessionMap.values()) {
    for (const blockGroup of sessions) {
      allSessions.push(buildSession(blockGroup));
    }
  }

  // Sort final sessions by start time
  return allSessions.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );
}

function buildSession(blocks: WorkBlock[]): Session {
  const first = blocks[0];
  const last = blocks[blocks.length - 1];

  const startMs = new Date(first.start).getTime();
  const endMs = new Date(last.end).getTime();
  const duration_min = Math.round((endMs - startMs) / (1000 * 60));

  // Collect distinct window titles (preserving order of first appearance)
  const titleSet = new Set<string>();
  const titles: string[] = [];
  for (const b of blocks) {
    const t = b.window_title ?? '';
    if (t && !titleSet.has(t)) {
      titleSet.add(t);
      titles.push(t);
    }
  }

  // Clean and re-dedupe window titles (strips app name suffixes)
  const cleanedTitleSet = new Set<string>();
  const cleanedTitles: string[] = [];
  for (const t of titles) {
    const cleaned = cleanTitle(t, first.app_name);
    if (!cleanedTitleSet.has(cleaned)) {
      cleanedTitleSet.add(cleaned);
      cleanedTitles.push(cleaned);
    }
  }

  // Collect distinct URLs
  const urlSet = new Set<string>();
  const urls: string[] = [];
  for (const b of blocks) {
    const u = b.url ?? '';
    if (u && !urlSet.has(u)) {
      urlSet.add(u);
      urls.push(u);
    }
  }

  // Clean and re-dedupe URLs (collapses tracking-param variants)
  const cleanedUrlSet = new Set<string>();
  const cleanedUrls: string[] = [];
  for (const u of urls) {
    const cleaned = cleanUrl(u);
    if (!cleanedUrlSet.has(cleaned)) {
      cleanedUrlSet.add(cleaned);
      cleanedUrls.push(cleaned);
    }
  }

  // Aggregate sample IDs
  const sample_ids = blocks.flatMap(b => b.sample_ids);

  // Re-compute top words from all blocks' OCR excerpts
  const allOcrTexts = blocks.map(b => b.ocr_excerpt).filter(Boolean);
  const top_words = getTopWords(allOcrTexts, 10);

  // Extract structured metadata from cleaned titles + URLs + OCR
  const metadataTexts = [
    ...cleanedTitles,
    ...cleanedUrls,
    ...blocks.map(b => b.ocr_excerpt),
  ];
  const metadata = extractMetadata(metadataTexts);

  // Aggregate accessibility context from blocks
  const docPathSet = new Set<string>();
  const document_paths: string[] = [];
  for (const b of blocks) {
    for (const p of b.document_paths) {
      if (!docPathSet.has(p)) {
        docPathSet.add(p);
        document_paths.push(p);
      }
    }
  }

  // Filter to filesystem paths only (exclude URL dupes)
  const fsDocPaths = document_paths.filter(isFsPath);

  const selected_texts = blocks.flatMap(b => b.selected_texts);

  const elemSet = new Set<string>();
  const focused_elements: string[] = [];
  for (const b of blocks) {
    for (const e of b.focused_elements) {
      if (!elemSet.has(e)) {
        elemSet.add(e);
        focused_elements.push(e);
      }
    }
  }

  const session: Session = {
    start: first.start,
    end: last.end,
    duration_min,
    app_name: first.app_name,
    app_bundle: first.app_bundle,
    window_titles: cleanedTitles,
    sample_count: blocks.reduce((sum, b) => sum + b.sample_count, 0),
    sample_ids,
    block_count: blocks.length,
    metadata,
  };

  if (cleanedUrls.length > 0) session.urls = cleanedUrls;
  if (top_words.length > 0) session.top_words = top_words;
  if (fsDocPaths.length > 0) session.document_paths = fsDocPaths;
  if (selected_texts.length > 0) session.selected_texts = selected_texts;
  if (focused_elements.length > 0) session.focused_elements = focused_elements;

  return session;
}

function makeBlock(samples: SampleRow[], compact?: boolean): WorkBlock {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const startSec = first.taken_at;
  const endSec = last.taken_at;
  const duration_min = Math.round((endSec - startSec) / 60);

  // In compact mode, we still need OCR for metadata extraction (JIRA/PR) and top_words,
  // but we don't include ocr_excerpt, selected_texts, or focused_elements in output
  const ocrTexts = samples.map(s => s.ocr_text ?? '').filter(Boolean);
  const top_words = getTopWords(ocrTexts, 5);

  // Extract metadata from OCR + window title (always needed for JIRA/PR detection)
  const metadataTexts = [first.window_title ?? '', first.url ?? '', ...ocrTexts];
  const metadata = extractMetadata(metadataTexts);

  if (compact) {
    // Compact: omit ocr_excerpt, selected_texts, focused_elements
    // Still include document_paths (small and useful)
    const docPathSet = new Set<string>();
    const document_paths: string[] = [];
    for (const s of samples) {
      if (s.document_path && !docPathSet.has(s.document_path)) {
        docPathSet.add(s.document_path);
        document_paths.push(s.document_path);
      }
    }

    return {
      start: new Date(startSec * 1000).toISOString(),
      end: new Date(endSec * 1000).toISOString(),
      duration_min,
      app_name: first.app_name,
      app_bundle: first.app_bundle,
      window_title: first.window_title,
      url: first.url,
      sample_count: samples.length,
      sample_ids: samples.map(s => s.id),
      top_words,
      ocr_excerpt: '',  // empty in compact mode
      document_paths,
      selected_texts: [],
      focused_elements: [],
      metadata,
    };
  }

  const allOcr = ocrTexts.join(' ');
  const ocr_excerpt = allOcr.slice(0, 300);

  // Accessibility context — deduplicated
  const docPathSet = new Set<string>();
  const document_paths: string[] = [];
  for (const s of samples) {
    if (s.document_path && !docPathSet.has(s.document_path)) {
      docPathSet.add(s.document_path);
      document_paths.push(s.document_path);
    }
  }

  const selected_texts = samples
    .map(s => s.selected_text)
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

  const elemSet = new Set<string>();
  const focused_elements: string[] = [];
  for (const s of samples) {
    if (s.focused_element && !elemSet.has(s.focused_element)) {
      elemSet.add(s.focused_element);
      focused_elements.push(s.focused_element);
    }
  }

  return {
    start: new Date(startSec * 1000).toISOString(),
    end: new Date(endSec * 1000).toISOString(),
    duration_min,
    app_name: first.app_name,
    app_bundle: first.app_bundle,
    window_title: first.window_title,
    url: first.url,
    sample_count: samples.length,
    sample_ids: samples.map(s => s.id),
    top_words,
    ocr_excerpt,
    document_paths,
    selected_texts,
    focused_elements,
    metadata,
  };
}
