import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
  getMyPrsForRepo: vi.fn(),
  parsePrUrl: vi.fn(),
}));
vi.mock('../../../src/integrations/github.js', () => ({
  getMyPrsForRepo: mocks.getMyPrsForRepo,
  getViewerLogin: () => 'me',
  parsePrUrl: mocks.parsePrUrl,
}));
vi.mock('../../../src/commitments/detectors/repoDiscovery.js', () => ({
  discoverLocalRepos: () => [{ root: '/fake/repo', nwo: 'acme/widgets' }],
}));

import { getDb, _resetDb, type Db } from '../../../src/db.js';
import { runDetectors, type Commitment } from '../../../src/commitments/index.js';
import { githubStale } from '../../../src/commitments/detectors/githubStale.js';

const NOW = 1_790_000_000; // 2026-09-19T21:33:20Z-ish
const DAY = 86_400;
const PR_URL = 'https://github.com/acme/widgets/pull/7';

function basePr(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: 'Refactor query layer',
    url: PR_URL,
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-18T00:00:00Z', // 1-2 days before NOW by default: not stale
    closedAt: null,
    mergedAt: null,
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    headRefName: 'refactor-query',
    reviews: [],
    comments: [],
    commits: [],
    statusCheckRollup: [],
    ...overrides,
  };
}

function rows(db: Db): Commitment[] {
  return db.prepare("SELECT * FROM commitments WHERE source = 'github_stale' ORDER BY id").all() as Commitment[];
}

let tempDir: string;
let originalDataDir: string | undefined;
let db: Db;

beforeEach(() => {
  originalDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-ghstale-'));
  process.env.DATA_DIR = tempDir;
  _resetDb();
  db = getDb();
  mocks.getMyPrsForRepo.mockReset();
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

describe('github_stale', () => {
  it('does not flag a recently-updated PR', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([basePr()]); // updated ~1 day before NOW
    const report = await runDetectors({ detectors: [githubStale], now: NOW });
    expect(report.detectors[0].detected).toBe(0);
  });

  it('flags no activity in 7+ days', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([basePr({ updatedAt: new Date((NOW - 8 * DAY) * 1000).toISOString() })]);
    const report = await runDetectors({ detectors: [githubStale], now: NOW });
    expect(report.detectors[0].detected).toBe(1);
    expect(rows(db)[0].detail).toContain('no activity');
  });

  it('flags approved but unmerged even if recently updated', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([basePr({ reviewDecision: 'APPROVED' })]);
    const report = await runDetectors({ detectors: [githubStale], now: NOW });
    expect(report.detectors[0].detected).toBe(1);
    expect(rows(db)[0].detail).toContain('approved but unmerged');
  });

  it('flags a draft older than 14 days but not a fresh one', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([
      basePr({ isDraft: true, createdAt: new Date((NOW - 15 * DAY) * 1000).toISOString() }),
    ]);
    const stale = await runDetectors({ detectors: [githubStale], now: NOW });
    expect(stale.detectors[0].detected).toBe(1);

    mocks.getMyPrsForRepo.mockReturnValue([
      basePr({ number: 8, url: `${PR_URL}-fresh`, isDraft: true, createdAt: new Date((NOW - 2 * DAY) * 1000).toISOString() }),
    ]);
    const fresh = await runDetectors({ detectors: [githubStale], now: NOW });
    expect(fresh.detectors[0].detected).toBe(0);
  });

  it('merging closes it on the next run', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([basePr({ reviewDecision: 'APPROVED' })]);
    await runDetectors({ detectors: [githubStale], now: NOW });

    mocks.getMyPrsForRepo.mockReturnValue([basePr({ state: 'MERGED', mergedAt: new Date().toISOString() })]);
    const report = await runDetectors({ detectors: [githubStale], now: NOW + DAY });
    expect(report.detectors[0].resolved).toBe(1);
    expect(rows(db)[0]).toMatchObject({ status: 'done', resolution_note: 'PR merged' });
  });

  it('resolves done when activity resumes and none of the stale conditions hold anymore', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([basePr({ updatedAt: new Date((NOW - 8 * DAY) * 1000).toISOString() })]);
    await runDetectors({ detectors: [githubStale], now: NOW });

    mocks.getMyPrsForRepo.mockReturnValue([basePr({ updatedAt: new Date(NOW * 1000).toISOString() })]);
    const report = await runDetectors({ detectors: [githubStale], now: NOW + DAY });
    expect(report.detectors[0].resolved).toBe(1);
    expect(rows(db)[0]).toMatchObject({ status: 'done', resolution_note: 'No longer stale' });
  });
});
