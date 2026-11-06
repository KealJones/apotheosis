import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDb, _resetDb, type Db } from '../../../src/db.js';
import { runDetectors, type Commitment } from '../../../src/commitments/index.js';
import { idea } from '../../../src/commitments/detectors/idea.js';

const DAY = 86_400;

function insertIdea(
  db: Db,
  opts: {
    body: string;
    createdAt: number;
    promotedToProjectId?: number | null;
  },
): number {
  const result = db.prepare(`
    INSERT INTO ideas (body, created_at, promoted_to_project_id)
    VALUES (?, ?, ?)
  `).run(opts.body, opts.createdAt, opts.promotedToProjectId ?? null);
  return Number(result.lastInsertRowid);
}

function rows(db: Db): Commitment[] {
  return db.prepare("SELECT * FROM commitments WHERE source = 'idea' ORDER BY id").all() as Commitment[];
}

let dataDir: string;
let originalDataDir: string | undefined;
let db: Db;
const realNow = Math.floor(Date.now() / 1000);

beforeEach(() => {
  originalDataDir = process.env.DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-idea-data-'));
  process.env.DATA_DIR = dataDir;
  _resetDb();
  db = getDb();
});

afterEach(() => {
  _resetDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
  else delete process.env.DATA_DIR;
});

describe('idea detector', () => {
  it('does not flag ideas created less than 14 days ago', async () => {
    insertIdea(db, {
      body: 'Fresh idea',
      createdAt: realNow - 10 * DAY, // Only 10 days old
    });

    const report = await runDetectors({ detectors: [idea], now: realNow });
    expect(report.detectors[0].detected).toBe(0);
  });

  it('does not flag ideas that have been promoted to a project', async () => {
    insertIdea(db, {
      body: 'Old idea now promoted',
      createdAt: realNow - 20 * DAY, // More than 14 days old
      promotedToProjectId: 42, // Already promoted
    });

    const report = await runDetectors({ detectors: [idea], now: realNow });
    expect(report.detectors[0].detected).toBe(0);
  });

  it('flags ideas older than 14 days with null promoted_to_project_id', async () => {
    insertIdea(db, {
      body: 'Unpromoted old idea',
      createdAt: realNow - 20 * DAY,
    });

    const report = await runDetectors({ detectors: [idea], now: realNow });
    expect(report.detectors[0]).toMatchObject({ detected: 1, inserted: 1 });

    const idea_rows = rows(db);
    expect(idea_rows).toHaveLength(1);
    expect(idea_rows[0]).toMatchObject({
      status: 'open',
      source: 'idea',
      confidence: 0.3, // Low confidence
    });
    expect(idea_rows[0].title).toBe('Unpromoted old idea');
    expect(idea_rows[0].detail).toBe('Unpromoted old idea');
  });

  it('truncates long idea bodies in the title', async () => {
    const longBody = 'A'.repeat(100);
    insertIdea(db, {
      body: longBody,
      createdAt: realNow - 20 * DAY,
    });

    const report = await runDetectors({ detectors: [idea], now: realNow });
    expect(report.detectors[0].detected).toBe(1);

    const idea_rows = rows(db);
    expect(idea_rows[0].title).toHaveLength(80); // 77 chars + '...'
    expect(idea_rows[0].title.endsWith('...')).toBe(true);
    expect(idea_rows[0].detail).toBe(longBody); // Full body in detail
  });

  it('uses stable source_ref based on idea id', async () => {
    const ideaId = insertIdea(db, {
      body: 'Stable idea',
      createdAt: realNow - 20 * DAY,
    });

    // First run
    let report = await runDetectors({ detectors: [idea], now: realNow });
    expect(report.detectors[0].detected).toBe(1);

    const firstRef = rows(db)[0].source_ref;
    expect(firstRef).toBe(`idea:${ideaId}`);

    // Second run should not duplicate
    report = await runDetectors({ detectors: [idea], now: realNow + 60 });
    expect(report.detectors[0]).toMatchObject({ detected: 1, inserted: 0 });

    const allRows = rows(db);
    expect(allRows).toHaveLength(1);
    expect(allRows[0].source_ref).toBe(firstRef);
  });

  it('emits low confidence to allow downstream filtering', async () => {
    insertIdea(db, {
      body: 'Low confidence idea',
      createdAt: realNow - 20 * DAY,
    });

    const report = await runDetectors({ detectors: [idea], now: realNow });
    expect(report.detectors[0].detected).toBe(1);

    const idea_rows = rows(db);
    expect(idea_rows[0].confidence).toBe(0.3);
  });

  it('resolves done when idea is promoted to a project', async () => {
    const ideaId = insertIdea(db, {
      body: 'Old idea',
      createdAt: realNow - 20 * DAY,
      promotedToProjectId: null,
    });

    // First run: should detect it
    let report = await runDetectors({ detectors: [idea], now: realNow });
    expect(report.detectors[0].detected).toBe(1);

    const commitmentId = rows(db)[0].id;
    expect(rows(db)[0].status).toBe('open');

    // Promote the idea
    db.prepare('UPDATE ideas SET promoted_to_project_id = ? WHERE id = ?').run(99, ideaId);

    // Re-run: should reconcile as done
    report = await runDetectors({ detectors: [idea], now: realNow + DAY });
    expect(report.detectors[0].resolved).toBe(1);

    const idea_rows = rows(db);
    expect(idea_rows[0].id).toBe(commitmentId);
    expect(idea_rows[0].status).toBe('done');
    expect(idea_rows[0].resolution_note).toContain('Promoted to project 99');
  });

  it('resolves dismissed when idea is deleted', async () => {
    const ideaId = insertIdea(db, {
      body: 'Deleted idea',
      createdAt: realNow - 20 * DAY,
    });

    // First run
    let report = await runDetectors({ detectors: [idea], now: realNow });
    expect(report.detectors[0].detected).toBe(1);

    const commitmentId = rows(db)[0].id;
    expect(rows(db)[0].status).toBe('open');

    // Delete the idea
    db.prepare('DELETE FROM ideas WHERE id = ?').run(ideaId);

    // Re-run: should reconcile as dismissed
    report = await runDetectors({ detectors: [idea], now: realNow + DAY });
    expect(report.detectors[0].resolved).toBe(1);

    const idea_rows = rows(db);
    expect(idea_rows[0].id).toBe(commitmentId);
    expect(idea_rows[0].status).toBe('dismissed');
    expect(idea_rows[0].resolution_note).toBe('Idea was deleted');
  });

  it('emits multiple old unpromoted ideas', async () => {
    insertIdea(db, { body: 'Old idea 1', createdAt: realNow - 20 * DAY });
    insertIdea(db, { body: 'Old idea 2', createdAt: realNow - 30 * DAY });
    insertIdea(db, { body: 'Recent idea', createdAt: realNow - 5 * DAY }); // Too recent
    insertIdea(db, { body: 'Old but promoted', createdAt: realNow - 25 * DAY, promotedToProjectId: 1 });

    const report = await runDetectors({ detectors: [idea], now: realNow });
    expect(report.detectors[0]).toMatchObject({ detected: 2, inserted: 2 });

    const idea_rows = rows(db);
    expect(idea_rows).toHaveLength(2);
    expect(idea_rows.map((r) => r.title)).toEqual(['Old idea 1', 'Old idea 2']);
  });

  it('does not duplicate on re-detection', async () => {
    insertIdea(db, { body: 'Stable idea', createdAt: realNow - 20 * DAY });

    // Run multiple times
    for (let i = 0; i < 3; i++) {
      const report = await runDetectors({ detectors: [idea], now: realNow + i * 60 });
      expect(report.detectors[0]).toMatchObject({
        detected: 1,
        inserted: i === 0 ? 1 : 0, // Only inserted on first run
      });
    }

    const idea_rows = rows(db);
    expect(idea_rows).toHaveLength(1);
  });
});
