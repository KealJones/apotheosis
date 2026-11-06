import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getClaudeSessions } from '../../src/queries/claudeSessions.js';

const SINCE = Date.parse('2026-10-30T00:00:00Z') / 1000;
const UNTIL = Date.parse('2026-10-30T23:59:59Z') / 1000;

let dir: string;

const user = (timestamp: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user', timestamp, cwd: '/repo/widgets', gitBranch: 'main', entrypoint: 'claude-desktop',
  message: { role: 'user', content }, ...extra,
});

function writeSession(project: string, id: string, entries: object[]) {
  const projectDir = path.join(dir, project);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n'));
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-'));
  writeSession('-repo-widgets', 'work', [
    { type: 'custom-title', customTitle: 'MUI license conflict' },
    user('2026-10-30T20:00:00Z', 'why does the grid show a license mismatch?'),
    user('2026-10-30T20:01:00Z', [{ type: 'tool_result', content: 'ok' }]),
    user('2026-10-30T20:02:00Z', '<command-name>/model</command-name>'),
    user('2026-10-30T20:05:00Z', [{ type: 'text', text: 'write notes for the thread' }]),
    { type: 'pr-link', prUrl: 'https://github.com/acme/widgets/pull/1', timestamp: '2026-10-30T20:06:00Z' },
    user('2026-10-31T10:00:00Z', 'next day prompt'),
  ]);
  writeSession('-repo-bot', 'headless', [
    user('2026-10-30T12:00:00Z', 'autonomous tick', { entrypoint: 'sdk-cli' }),
  ]);
  writeSession('-repo-old', 'old', [user('2026-10-28T12:00:00Z', 'too early')]);
  // Subagent transcripts sit one level deeper and are not sessions of their own.
  writeSession(path.join('-repo-widgets', 'work', 'subagents'), 'agent-1', [
    user('2026-10-30T20:03:00Z', 'You are a subagent.'),
  ]);
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('getClaudeSessions', () => {
  const sessions = () => getClaudeSessions({ since: SINCE, until: UNTIL, projectsDir: dir });

  it('returns only interactive sessions with prompts in the range', () => {
    expect(sessions().map((s) => s.session_id)).toEqual(['work']);
  });

  it('keeps my prompts and drops tool results and command wrappers', () => {
    const [s] = sessions();
    expect(s.prompts).toEqual(['why does the grid show a license mismatch?', 'write notes for the thread']);
    expect(s.prompt_count).toBe(2);
  });

  it('carries the title, repo, branch, PR links and the in-range time span', () => {
    const [s] = sessions();
    expect(s).toMatchObject({
      title: 'MUI license conflict',
      cwd: '/repo/widgets',
      git_branch: 'main',
      pr_urls: ['https://github.com/acme/widgets/pull/1'],
      start: '2026-10-30T20:00:00.000Z',
      end: '2026-10-30T20:05:00.000Z',
    });
  });

  it('returns nothing when the projects directory is missing', () => {
    expect(getClaudeSessions({ since: SINCE, until: UNTIL, projectsDir: path.join(dir, 'nope') })).toEqual([]);
  });
});
