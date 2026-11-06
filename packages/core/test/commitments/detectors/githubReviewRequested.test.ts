import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Shapes below match real `gh search prs --review-requested=@me --json ...` /
// `gh pr view --json state,reviews` output recorded while building this detector.
const mocks = vi.hoisted(() => ({
  getPendingReviews: vi.fn(),
  getPrState: vi.fn(),
}));
vi.mock('../../../src/integrations/github.js', () => ({
  getPendingReviews: mocks.getPendingReviews,
  getPrState: mocks.getPrState,
}));

import { getDb, _resetDb, type Db } from '../../../src/db.js';
import { runDetectors, type Commitment } from '../../../src/commitments/index.js';
import { githubReviewRequested } from '../../../src/commitments/detectors/githubReviewRequested.js';

const NOW = 1_790_000_000;

function rows(db: Db): Commitment[] {
  return db.prepare("SELECT * FROM commitments WHERE source = 'github_review_requested' ORDER BY id").all() as Commitment[];
}

let tempDir: string;
let originalDataDir: string | undefined;
let db: Db;

beforeEach(() => {
  originalDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-ghreview-'));
  process.env.DATA_DIR = tempDir;
  _resetDb();
  db = getDb();
  mocks.getPendingReviews.mockReset();
  mocks.getPrState.mockReset();
});

afterEach(() => {
  _resetDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
  else delete process.env.DATA_DIR;
});

const PR = {
  number: 234,
  title: 'Dynamic workflow name and updated tooltip copy',
  url: 'https://github.com/acme/agent-tools/pull/234',
  updatedAt: '2026-09-22T20:38:02Z',
  repo: 'acme/agent-tools',
};

describe('github_review_requested', () => {
  it('creates a commitment for an outstanding review request, idempotently', async () => {
    mocks.getPendingReviews.mockReturnValue([PR]);

    const first = await runDetectors({ detectors: [githubReviewRequested], now: NOW });
    expect(first.detectors[0]).toMatchObject({ detected: 1, inserted: 1 });

    const second = await runDetectors({ detectors: [githubReviewRequested], now: NOW + 60 });
    expect(second.detectors[0]).toMatchObject({ detected: 1, inserted: 0 });

    const [row] = rows(db);
    expect(row).toMatchObject({ status: 'open', source_ref: `${PR.url}#round=0` });
    expect(row.title).toContain(PR.title);
  });

  it('resolves done when the PR merged after review was requested', async () => {
    mocks.getPendingReviews.mockReturnValue([PR]);
    await runDetectors({ detectors: [githubReviewRequested], now: NOW });

    // Merging closes it on the next detector run without user action.
    mocks.getPendingReviews.mockReturnValue([]); // review request no longer outstanding
    mocks.getPrState.mockReturnValue({ state: 'MERGED', reviews: [] });
    const report = await runDetectors({ detectors: [githubReviewRequested], now: NOW + DAY() });

    expect(report.detectors[0].resolved).toBe(1);
    expect(rows(db)[0]).toMatchObject({ status: 'done', resolution_note: 'PR merged' });
  });

  it('dismisses when the PR closed without merging', async () => {
    mocks.getPendingReviews.mockReturnValue([PR]);
    await runDetectors({ detectors: [githubReviewRequested], now: NOW });

    mocks.getPendingReviews.mockReturnValue([]);
    mocks.getPrState.mockReturnValue({ state: 'CLOSED', reviews: [] });
    const report = await runDetectors({ detectors: [githubReviewRequested], now: NOW + DAY() });

    expect(report.detectors[0].resolved).toBe(1);
    expect(rows(db)[0]).toMatchObject({ status: 'dismissed', resolution_note: 'PR closed without merging' });
  });

  it('resolves done when your review lands and the PR stays open', async () => {
    mocks.getPendingReviews.mockReturnValue([PR]);
    await runDetectors({ detectors: [githubReviewRequested], now: NOW });

    mocks.getPendingReviews.mockReturnValue([]); // you're no longer a requested reviewer
    mocks.getPrState.mockReturnValue({ state: 'OPEN', reviews: [{ author: { login: 'me' }, state: 'APPROVED', submittedAt: '2026-09-22T21:00:00Z' }] });
    const report = await runDetectors({ detectors: [githubReviewRequested], now: NOW + DAY() });

    expect(report.detectors[0].resolved).toBe(1);
    expect(rows(db)[0]).toMatchObject({ status: 'done', resolution_note: 'Review submitted' });
  });

  it('leaves it open when gh state cannot be determined this run', async () => {
    mocks.getPendingReviews.mockReturnValue([PR]);
    await runDetectors({ detectors: [githubReviewRequested], now: NOW });

    mocks.getPendingReviews.mockReturnValue([]);
    mocks.getPrState.mockReturnValue(null); // e.g. gh errored
    const report = await runDetectors({ detectors: [githubReviewRequested], now: NOW + DAY() });

    expect(report.detectors[0].resolved).toBe(0);
    expect(rows(db)[0].status).toBe('open');
  });

  it('re-requesting a review after you already reviewed opens a new round, not a reopen', async () => {
    mocks.getPendingReviews.mockReturnValue([PR]);
    await runDetectors({ detectors: [githubReviewRequested], now: NOW });

    // Review submitted, request cleared.
    mocks.getPendingReviews.mockReturnValue([]);
    mocks.getPrState.mockReturnValue({ state: 'OPEN', reviews: [] });
    await runDetectors({ detectors: [githubReviewRequested], now: NOW + DAY() });
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({ status: 'done', source_ref: `${PR.url}#round=0` });

    // Author pushed changes; your review is requested again on the same PR.
    mocks.getPendingReviews.mockReturnValue([PR]);
    const report = await runDetectors({ detectors: [githubReviewRequested], now: NOW + 2 * DAY() });

    expect(report.detectors[0].inserted).toBe(1);
    const all = rows(db);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ status: 'done', source_ref: `${PR.url}#round=0` });
    expect(all[1]).toMatchObject({ status: 'open', source_ref: `${PR.url}#round=1` });
  });
});

function DAY(): number {
  return 86_400;
}
