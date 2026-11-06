import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// This file exercises the real production registry (including the github_* detectors), so
// `gh` is mocked the same way pendingReviews.test.ts does it — no real subprocess/network
// calls from a unit test, ever.
vi.mock('../../src/integrations/github.js', () => ({
  getPendingReviews: () => [],
  getPrState: () => null,
  getMyPrsForRepo: () => [],
  getViewerLogin: () => 'test-user',
  parsePrUrl: () => null,
}));

import { getDb, _resetDb, type Db } from '../../src/db.js';
import {
  runDetectors,
  validateRegistry,
  detectors as registry,
  EXPIRY_SECONDS,
  type Commitment,
  type Detector,
} from '../../src/commitments/index.js';
import { resolveTodo } from '../../src/queries/todoResolve.js';

const DAY = 86_400;
const NOW = 1_790_000_000;

/**
 * Example detector over a fake "GitHub". `requested` is what detect() sees; `merged` is what
 * reconcile() treats as satisfied. Shows the intended shape: pure in, structured data out.
 */
function makeReviewDetector() {
  const world = {
    requested: new Map<string, { title: string; updatedAt?: number }>(),
    merged: new Set<string>(),
    failDetect: false,
  };
  const detector: Detector = {
    id: 'example_review',
    sources: ['github_review_requested'],
    async detect() {
      if (world.failDetect) throw new Error('gh: not logged in');
      return [...world.requested].map(([ref, pr]) => ({
        source: 'github_review_requested' as const,
        source_ref: ref,
        title: pr.title,
        confidence: 0.95,
        last_activity_at: pr.updatedAt,
      }));
    },
    async reconcile(open: Commitment[]) {
      return open
        .filter((c) => world.merged.has(c.source_ref))
        .map((c) => ({ id: c.id, status: 'done' as const, note: 'PR merged' }));
    },
  };
  return { world, detector };
}

function rows(db: Db): Commitment[] {
  return db.prepare('SELECT * FROM commitments ORDER BY id').all() as Commitment[];
}

function insertRaw(db: Db, fields: Partial<Commitment> & Pick<Commitment, 'source' | 'source_ref' | 'detected_at'>): number {
  const r = db.prepare(`
    INSERT INTO commitments (detected_at, source, source_ref, title, confidence, status, snoozed_until, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.detected_at, fields.source, fields.source_ref, fields.title ?? 'x', 0.5,
    fields.status ?? 'open', fields.snoozed_until ?? null, fields.last_activity_at ?? null,
  );
  return Number(r.lastInsertRowid);
}

let tempDir: string;
let originalDataDir: string | undefined;
let db: Db;

beforeEach(() => {
  // Real runMigrations() path, so the last_activity_at migration is exercised too.
  originalDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-commitments-'));
  process.env.DATA_DIR = tempDir;
  _resetDb();
  db = getDb();
});

afterEach(() => {
  _resetDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
  else delete process.env.DATA_DIR;
});

describe('registry', () => {
  it('is well-formed and runs cleanly against an empty DB', async () => {
    expect(registry.length).toBeGreaterThan(0);
    expect(() => validateRegistry(registry)).not.toThrow();
    // No `gh` calls should blow up the run even if `gh` is missing/unauthenticated in CI —
    // each github_* detector's detect() catches its own errors, and git_local's repo
    // discovery finds nothing in a DB with no samples/context_events.
    const report = await runDetectors({ now: NOW });
    expect(report.detectors.map((d) => d.id).sort()).toEqual(registry.map((d) => d.id).sort());
  });

  it('rejects duplicate ids and doubly-owned sources', () => {
    const { detector } = makeReviewDetector();
    expect(() => validateRegistry([detector, { ...detector }])).toThrow(/Duplicate detector id/);
    expect(() => validateRegistry([detector, { ...detector, id: 'other' }])).toThrow(/owned by both/);
  });
});

describe('runDetectors', () => {
  it('upserts candidates without duplicating on a second run', async () => {
    const { world, detector } = makeReviewDetector();
    world.requested.set('pr/1', { title: 'Review PR 1' });
    world.requested.set('pr/2', { title: 'Review PR 2' });

    const first = await runDetectors({ detectors: [detector], now: NOW });
    expect(first.detectors[0]).toMatchObject({ detected: 2, inserted: 2, resolved: 0, errors: [] });

    const second = await runDetectors({ detectors: [detector], now: NOW + 60 });
    expect(second.detectors[0]).toMatchObject({ detected: 2, inserted: 0, resolved: 0 });

    const after = rows(db);
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.status)).toEqual(['open', 'open']);
    // detected_at is first-seen; last_activity_at tracks the re-sighting.
    expect(after[0].detected_at).toBe(NOW);
    expect(after[0].last_activity_at).toBe(NOW + 60);
  });

  it('closes a commitment only via an explicit reconciler resolution', async () => {
    const { world, detector } = makeReviewDetector();
    world.requested.set('pr/1', { title: 'Review PR 1' });
    world.requested.set('pr/2', { title: 'Review PR 2' });
    await runDetectors({ detectors: [detector], now: NOW });

    // pr/1 vanishes from detect() output but isn't merged: must stay open.
    // pr/2 is merged: reconcile() says done.
    world.requested.delete('pr/1');
    world.merged.add('pr/2');
    const report = await runDetectors({ detectors: [detector], now: NOW + 60 });
    expect(report.detectors[0].resolved).toBe(1);

    const [pr1, pr2] = rows(db);
    expect(pr1.status).toBe('open');
    expect(pr2).toMatchObject({ status: 'done', resolved_by: 'auto', resolution_note: 'PR merged', resolved_at: NOW + 60 });

    // Idempotent: the same world again changes nothing.
    const again = await runDetectors({ detectors: [detector], now: NOW + 120 });
    expect(again.detectors[0].resolved).toBe(0);
    expect(rows(db).map((r) => r.status)).toEqual(['open', 'done']);
    expect(rows(db)[1].resolved_at).toBe(NOW + 60);
  });

  it('never clobbers a user-set status when the detector re-detects the item', async () => {
    const { world, detector } = makeReviewDetector();
    world.requested.set('pr/1', { title: 'Review PR 1' });
    world.requested.set('pr/2', { title: 'Review PR 2' });
    await runDetectors({ detectors: [detector], now: NOW });
    const [pr1, pr2] = rows(db);

    // User acts through the real tool paths.
    resolveTodo({ id: pr1.id, resolution: 'done', note: 'reviewed' });
    resolveTodo({ id: pr2.id, resolution: 'dismissed', note: 'not mine' });

    // Detector still sees both, with a new title; reconciler would call pr/2 done.
    world.requested.set('pr/1', { title: 'Review PR 1 (renamed)' });
    world.merged.add('pr/2');
    const report = await runDetectors({ detectors: [detector], now: NOW + 60 });
    expect(report.detectors[0]).toMatchObject({ inserted: 0, resolved: 0 });

    const [a, b] = rows(db);
    expect(a).toMatchObject({ status: 'done', resolved_by: 'user', title: 'Review PR 1 (renamed)' });
    expect(b).toMatchObject({ status: 'dismissed', resolved_by: 'user' });
    expect(rows(db)).toHaveLength(2);
  });

  it('reconciles snoozed items and wakes expired snoozes', async () => {
    const { world, detector } = makeReviewDetector();
    const snoozedMerged = insertRaw(db, { source: 'github_review_requested', source_ref: 'pr/9', detected_at: NOW - DAY, status: 'snoozed', snoozed_until: NOW + DAY });
    // Snoozed for 40 days, snooze just ended: wakes, and the snooze end counts as activity.
    const woke = insertRaw(db, { source: 'slack_ask', source_ref: 'msg/1', detected_at: NOW - 45 * DAY, status: 'snoozed', snoozed_until: NOW - 60 });
    world.merged.add('pr/9');

    const report = await runDetectors({ detectors: [detector], now: NOW });
    expect(report.woken).toBe(1);
    expect(report.expired).toBe(0);
    const byId = new Map(rows(db).map((r) => [r.id, r]));
    expect(byId.get(snoozedMerged)).toMatchObject({ status: 'done', snoozed_until: null });
    expect(byId.get(woke)).toMatchObject({ status: 'open', snoozed_until: null, last_activity_at: NOW - 60 });
  });

  it('rejects candidates and resolutions outside the detector\'s ownership', async () => {
    const foreign = insertRaw(db, { source: 'slack_ask', source_ref: 'msg/1', detected_at: NOW });
    const rogue: Detector = {
      id: 'rogue',
      sources: ['github_stale'],
      async detect() {
        return [
          { source: 'slack_ask', source_ref: 'x', title: 'not mine', confidence: 0.5 },
          { source: 'github_stale', source_ref: 'y', title: 'bad confidence', confidence: 7 },
          { source: 'github_stale', source_ref: 'z', title: 'fine', confidence: 0.5 },
        ];
      },
      async reconcile() {
        return [{ id: foreign, status: 'done', note: 'not mine to close' }];
      },
    };
    const report = await runDetectors({ detectors: [rogue], now: NOW });
    expect(report.detectors[0].detected).toBe(1);
    expect(report.detectors[0].resolved).toBe(0);
    expect(report.detectors[0].errors).toHaveLength(3);
    expect(rows(db).find((r) => r.id === foreign)!.status).toBe('open');
  });

  it('gives detectors a read-only DB', async () => {
    const writer: Detector = {
      id: 'writer',
      sources: ['idea'],
      async detect(ctx) {
        (ctx.db.prepare("UPDATE commitments SET status = 'done'") as any).all();
        return [];
      },
      async reconcile() { return []; },
    };
    insertRaw(db, { source: 'idea', source_ref: 'i/1', detected_at: NOW });
    const report = await runDetectors({ detectors: [writer], now: NOW });
    expect(report.detectors[0].errors[0]).toMatch(/read-only/);
    expect(rows(db)[0].status).toBe('open');
  });
});

describe('auto-expiry', () => {
  it('dismisses stale open items and leaves recent, manual, and snoozed ones alone', async () => {
    const stale = insertRaw(db, { source: 'slack_promise', source_ref: 'old', detected_at: NOW - 31 * DAY });
    const staleButActive = insertRaw(db, { source: 'slack_promise', source_ref: 'active', detected_at: NOW - 60 * DAY, last_activity_at: NOW - 2 * DAY });
    const recent = insertRaw(db, { source: 'slack_promise', source_ref: 'new', detected_at: NOW - 29 * DAY });
    const manual = insertRaw(db, { source: 'manual', source_ref: 'm', detected_at: NOW - 90 * DAY });
    const snoozed = insertRaw(db, { source: 'slack_promise', source_ref: 'zz', detected_at: NOW - 90 * DAY, status: 'snoozed', snoozed_until: NOW + DAY });

    const report = await runDetectors({ detectors: [], now: NOW });
    expect(report.expired).toBe(1);

    const byId = new Map(rows(db).map((r) => [r.id, r]));
    expect(byId.get(stale)).toMatchObject({ status: 'dismissed', resolved_by: 'auto', resolved_at: NOW });
    expect(byId.get(stale)!.resolution_note).toMatch(/^Auto-expired: no supporting activity for 30 days/);
    expect(byId.get(staleButActive)!.status).toBe('open');
    expect(byId.get(recent)!.status).toBe('open');
    expect(byId.get(manual)!.status).toBe('open');
    expect(byId.get(snoozed)!.status).toBe('snoozed');

    // Idempotent.
    expect((await runDetectors({ detectors: [], now: NOW })).expired).toBe(0);
  });

  it('treats re-detection as activity unless the detector supplies an older last_activity_at', async () => {
    const { world, detector } = makeReviewDetector();
    world.requested.set('pr/live', { title: 'still requested' });
    world.requested.set('pr/dead', { title: 'untouched for 40 days', updatedAt: NOW - 40 * DAY });
    await runDetectors({ detectors: [detector], now: NOW - 35 * DAY });

    await runDetectors({ detectors: [detector], now: NOW });
    const [live, dead] = rows(db);
    expect(live.status).toBe('open');
    expect(dead.status).toBe('dismissed');
  });

  it('skips expiry for sources whose detect() failed this run', async () => {
    const { world, detector } = makeReviewDetector();
    world.requested.set('pr/1', { title: 'Review PR 1' });
    await runDetectors({ detectors: [detector], now: NOW - EXPIRY_SECONDS - DAY });

    world.failDetect = true;
    const report = await runDetectors({ detectors: [detector], now: NOW });
    expect(report.detectors[0].errors).toEqual(['detect: gh: not logged in']);
    expect(report.expired).toBe(0);
    expect(rows(db)[0].status).toBe('open');

    // Once the detector has been removed (or recovers but no longer sees it), expiry resumes.
    expect((await runDetectors({ detectors: [], now: NOW })).expired).toBe(1);
  });
});
