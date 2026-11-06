import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ClaudeSessionsArgs {
  /** Unix seconds, inclusive. */
  since: number;
  /** Unix seconds, inclusive. */
  until: number;
  /** Override for tests; defaults to $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects. */
  projectsDir?: string;
}

export interface ClaudeSession {
  session_id: string;
  title: string | null;
  cwd: string | null;
  git_branch: string | null;
  start: string;
  end: string;
  prompt_count: number;
  /** My first few prompts in the range, clipped. */
  prompts: string[];
  pr_urls: string[];
}

const MAX_PROMPTS = 5;
const PROMPT_CHARS = 300;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function defaultProjectsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
}

/** Text I typed, or null for tool results, slash-command wrappers and other harness content. */
function promptText(content: unknown): string | null {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
      : '';
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('[Request interrupted')) return null;
  return trimmed;
}

/**
 * Claude Code sessions (CLI, desktop Code tab, IDE) with activity in [since, until], read from
 * the local transcripts. Subagent transcripts live in per-session subdirectories and are skipped, as are headless
 * `claude -p` runs.
 * claude.ai chats are not stored locally, so they never show up here.
 */
export function getClaudeSessions(args: ClaudeSessionsArgs): ClaudeSession[] {
  const root = args.projectsDir ?? defaultProjectsDir();
  if (!fs.existsSync(root)) return [];

  const sessions: ClaudeSession[] = [];
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const full = path.join(dir, file);
      // A file last written before the range can't have activity in it.
      if (fs.statSync(full).mtimeMs / 1000 < args.since) continue;
      const session = readSession(full, args.since, args.until);
      if (session) sessions.push(session);
    }
  }
  return sessions.sort((a, b) => a.start.localeCompare(b.start));
}

function readSession(file: string, since: number, until: number): ClaudeSession | null {
  let title: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  let first: number | null = null;
  let last: number | null = null;
  let promptCount = 0;
  const prompts: string[] = [];
  const prUrls = new Set<string>();

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    // Most lines are API blobs and assistant turns; skip them before parsing.
    const isUser = line.includes('"type":"user"');
    const isTitle = line.includes('"type":"custom-title"');
    const isPr = line.includes('"type":"pr-link"');
    if (!isUser && !isTitle && !isPr) continue;

    let entry: Record<string, any>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
      title = entry.customTitle;
      continue;
    }

    const at = Date.parse(entry.timestamp) / 1000;
    if (!(at >= since && at <= until)) continue;

    if (entry.type === 'pr-link' && typeof entry.prUrl === 'string') {
      prUrls.add(entry.prUrl);
      continue;
    }
    if (entry.type !== 'user' || entry.isSidechain || entry.isMeta) continue;
    // Headless `claude -p` runs are scripts and scheduled jobs, not my work sessions.
    if (entry.entrypoint === 'sdk-cli') return null;

    first ??= at;
    last = at;
    cwd = entry.cwd ?? cwd;
    branch = entry.gitBranch ?? branch;
    const text = promptText(entry.message?.content);
    if (!text) continue;
    promptCount++;
    if (prompts.length < MAX_PROMPTS) prompts.push(clip(text, PROMPT_CHARS));
  }

  if (first === null || last === null || promptCount === 0) return null;
  return {
    session_id: path.basename(file, '.jsonl'),
    title,
    cwd,
    git_branch: branch,
    start: new Date(first * 1000).toISOString(),
    end: new Date(last * 1000).toISOString(),
    prompt_count: promptCount,
    prompts,
    pr_urls: [...prUrls],
  };
}
