import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// statusCheckRollup shape (name/status/conclusion/workflowName) matches real
// `gh pr list --json statusCheckRollup` output recorded against acme/web-app.
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
import { githubCiFailing } from '../../../src/commitments/detectors/githubCiFailing.js';

const NOW = 1_790_000_000;
const DAY = 86_400;
const PR_URL = 'https://github.com/acme/widgets/pull/9';

function basePr(overrides: Record<string, unknown> = {}) {
  return {
    number: 9,
    title: 'Speed up build pipeline',
    url: PR_URL,
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-18T00:00:00Z',
    closedAt: null,
    mergedAt: null,
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    headRefName: 'speed-up-ci',
    reviews: [],
    comments: [],
    commits: [],
    statusCheckRollup: [
      { name: 'build-and-test', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI' },
    ],
    ...overrides,
  };
}

function rows(db: Db): Commitment[] {
  return db.prepare("SELECT * FROM commitments WHERE source = 'github_ci_failing' ORDER BY id").all() as Commitment[];
}

let tempDir: string;
let originalDataDir: string | undefined;
let db: Db;

beforeEach(() => {
  originalDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-ghci-'));
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

describe('github_ci_failing', () => {
  it('does not flag all-passing checks', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([basePr()]);
    const report = await runDetectors({ detectors: [githubCiFailing], now: NOW });
    expect(report.detectors[0].detected).toBe(0);
  });

  it('flags a completed, failing required-looking check', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([
      basePr({ statusCheckRollup: [{ name: 'build-and-test', status: 'COMPLETED', conclusion: 'FAILURE', workflowName: 'CI' }] }),
    ]);
    const report = await runDetectors({ detectors: [githubCiFailing], now: NOW });
    expect(report.detectors[0]).toMatchObject({ detected: 1, inserted: 1 });
    expect(rows(db)[0].detail).toContain('build-and-test');
  });

  it('ignores a check that is still running (no conclusion yet)', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([
      basePr({ statusCheckRollup: [{ name: 'build-and-test', status: 'IN_PROGRESS', conclusion: null, workflowName: 'CI' }] }),
    ]);
    const report = await runDetectors({ detectors: [githubCiFailing], now: NOW });
    expect(report.detectors[0].detected).toBe(0);
  });

  it('merging the PR closes the commitment on the next run', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([
      basePr({ statusCheckRollup: [{ name: 'build-and-test', status: 'COMPLETED', conclusion: 'FAILURE', workflowName: 'CI' }] }),
    ]);
    await runDetectors({ detectors: [githubCiFailing], now: NOW });

    mocks.getMyPrsForRepo.mockReturnValue([basePr({ state: 'MERGED', mergedAt: new Date().toISOString() })]);
    const report = await runDetectors({ detectors: [githubCiFailing], now: NOW + DAY });
    expect(report.detectors[0].resolved).toBe(1);
    expect(rows(db)[0]).toMatchObject({ status: 'done', resolution_note: 'PR merged' });
  });

  it('a passing rerun resolves it done without closing the PR', async () => {
    mocks.getMyPrsForRepo.mockReturnValue([
      basePr({ statusCheckRollup: [{ name: 'build-and-test', status: 'COMPLETED', conclusion: 'FAILURE', workflowName: 'CI' }] }),
    ]);
    await runDetectors({ detectors: [githubCiFailing], now: NOW });

    mocks.getMyPrsForRepo.mockReturnValue([basePr()]); // passing again
    const report = await runDetectors({ detectors: [githubCiFailing], now: NOW + DAY });
    expect(report.detectors[0].resolved).toBe(1);
    expect(rows(db)[0]).toMatchObject({ status: 'done', resolution_note: 'CI passing now' });
  });
});
