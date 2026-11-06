import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// GhPrRow shape matches real `gh pr list --repo X --author @me --state all --json ...`
// output recorded against acme/web-app while building these detectors.
const mocks = vi.hoisted(() => ({
  getMyPrsForRepo: vi.fn(),
  getViewerLogin: vi.fn(),
  parsePrUrl: vi.fn(),
}));
vi.mock('../../../src/integrations/github.js', () => ({
  getMyPrsForRepo: mocks.getMyPrsForRepo,
  getViewerLogin: mocks.getViewerLogin,
  parsePrUrl: mocks.parsePrUrl,
}));
vi.mock('../../../src/commitments/detectors/repoDiscovery.js', () => ({
  discoverLocalRepos: () => [{ root: '/fake/repo', nwo: 'acme/widgets' }],
}));

import { getDb, _resetDb, type Db } from '../../../src/db.js';
import { runDetectors, type Commitment } from '../../../src/commitments/index.js';
import { githubUnaddressed } from '../../../src/commitments/detectors/githubUnaddressed.js';

const NOW = 1_790_000_000;
const DAY = 86_400;
const PR_URL = 'https://github.com/acme/widgets/pull/42';

function basePr(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: 'Add dark mode toggle',
    url: PR_URL,
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-09-01T12:00:00Z',
    updatedAt: '2026-09-10T12:00:00Z',
    closedAt: null,
    mergedAt: null,
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    headRefName: 'dark-mode',
    reviews: [] as unknown[],
    comments: [] as unknown[],
    commits: [{ oid: 'abc', committedDate: '2026-09-08T00:00:00Z', authoredDate: '2026-09-08T00:00:00Z' }],
    statusCheckRollup: [],
    ...overrides,
  };
}

function rows(db: Db): Commitment[] {
  return db.prepare("SELECT * FROM commitments WHERE source = 'github_unaddressed' ORDER BY id").all() as Commitment[];
}

let tempDir: string;
let originalDataDir: string | undefined;
let db: Db;

beforeEach(() => {
  originalDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-ghunaddr-'));
  process.env.DATA_DIR = tempDir;
  _resetDb();
  db = getDb();
  mocks.getMyPrsForRepo.mockReset();
  mocks.getViewerLogin.mockReset().mockReturnValue('me');
  mocks.parsePrUrl.mockReset().mockImplementation((url: string) => {
    const m = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
    return m ? { nwo: m[1], number: Number(m[2]) } : null;
  });
});

afterEach(() => {
  _resetDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
  else delete process.env.DATA_DIR;
});

describe('github_unaddressed', () => {
  it('flags a PR with a review comment newer than your last push', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([
      basePr({ comments: [{ author: { login: 'reviewer1' }, createdAt: '2026-09-11T00:00:00Z' }] }),
    ]);
    const report = await runDetectors({ detectors: [githubUnaddressed], now: NOW });
    expect(report.detectors[0]).toMatchObject({ detected: 1, inserted: 1 });
    expect(rows(db)[0]).toMatchObject({ status: 'open', source_ref: PR_URL });
  });

  it('flags "changes requested" regardless of comment timing', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([basePr({ reviewDecision: 'CHANGES_REQUESTED' })]);
    const report = await runDetectors({ detectors: [githubUnaddressed], now: NOW });
    expect(report.detectors[0].detected).toBe(1);
  });

  it('does not flag feedback from before your last push', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([
      basePr({ comments: [{ author: { login: 'reviewer1' }, createdAt: '2026-09-05T00:00:00Z' }] }), // before commit on 09-08
    ]);
    const report = await runDetectors({ detectors: [githubUnaddressed], now: NOW });
    expect(report.detectors[0].detected).toBe(0);
  });

  it('does not flag your own comments', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([
      basePr({ comments: [{ author: { login: 'me' }, createdAt: '2026-09-12T00:00:00Z' }] }),
    ]);
    const report = await runDetectors({ detectors: [githubUnaddressed], now: NOW });
    expect(report.detectors[0].detected).toBe(0);
  });

  it('merging the PR closes the commitment on the next run', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([
      basePr({ comments: [{ author: { login: 'reviewer1' }, createdAt: '2026-09-11T00:00:00Z' }] }),
    ]);
    await runDetectors({ detectors: [githubUnaddressed], now: NOW });
    expect(rows(db)[0].status).toBe('open');

    mocks.getMyPrsForRepo.mockReturnValue([basePr({ state: 'MERGED', mergedAt: '2026-09-15T00:00:00Z' })]);
    const report = await runDetectors({ detectors: [githubUnaddressed], now: NOW + DAY });

    expect(report.detectors[0].resolved).toBe(1);
    expect(rows(db)[0]).toMatchObject({ status: 'done', resolution_note: 'PR merged' });
  });

  it('closing without merging dismisses it', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([basePr({ reviewDecision: 'CHANGES_REQUESTED' })]);
    await runDetectors({ detectors: [githubUnaddressed], now: NOW });

    mocks.getMyPrsForRepo.mockReturnValue([basePr({ state: 'CLOSED', closedAt: '2026-09-15T00:00:00Z', reviewDecision: 'CHANGES_REQUESTED' })]);
    const report = await runDetectors({ detectors: [githubUnaddressed], now: NOW + DAY });

    expect(rows(db)[0]).toMatchObject({ status: 'dismissed', resolution_note: 'PR closed without merging' });
  });

  it('pushing after the last outside comment resolves it done without closing the PR', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([
      basePr({ comments: [{ author: { login: 'reviewer1' }, createdAt: '2026-09-11T00:00:00Z' }] }),
    ]);
    await runDetectors({ detectors: [githubUnaddressed], now: NOW });

    mocks.getMyPrsForRepo.mockReturnValue([
      basePr({
        comments: [{ author: { login: 'reviewer1' }, createdAt: '2026-09-11T00:00:00Z' }],
        commits: [{ oid: 'def', committedDate: '2026-09-12T00:00:00Z', authoredDate: '2026-09-12T00:00:00Z' }],
      }),
    ]);
    const report = await runDetectors({ detectors: [githubUnaddressed], now: NOW + DAY });

    expect(report.detectors[0].resolved).toBe(1);
    expect(rows(db)[0]).toMatchObject({ status: 'done', resolution_note: 'Addressed: pushed after the last outside review/comment' });
  });
});
