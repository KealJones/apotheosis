import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setupTestDb, teardownTestDb } from './helpers/setup.js';
import { getDb, _resetDb } from '../src/db.js';

describe('commitments schema', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });

  it('rejects a second row with the same (source, source_ref)', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO commitments (detected_at, source, source_ref, title, confidence, status)
      VALUES (?, ?, ?, ?, ?, 'open')
    `).run(1000, 'github_review_requested', 'https://github.com/org/repo/pull/99', 'Review PR #99', 0.7);

    expect(() =>
      db.prepare(`
        INSERT INTO commitments (detected_at, source, source_ref, title, confidence, status)
        VALUES (?, ?, ?, ?, ?, 'open')
      `).run(2000, 'github_review_requested', 'https://github.com/org/repo/pull/99', 'Review PR #99 again', 0.7)
    ).toThrow();
  });

  it('lets a detector upsert on (source, source_ref) instead of duplicating, without clobbering a user-set status', () => {
    const db = getDb();

    const upsert = `
      INSERT INTO commitments (detected_at, source, source_ref, title, detail, confidence, status)
      VALUES (?, ?, ?, ?, ?, ?, 'open')
      ON CONFLICT (source, source_ref) DO UPDATE SET
        detected_at = excluded.detected_at,
        title = excluded.title,
        detail = excluded.detail,
        confidence = excluded.confidence
    `;

    // First detection.
    db.prepare(upsert).run(
      1000, 'slack_ask', 'slack-dedupe-hash-abc', 'Reply to Morgan', 'initial detection', 0.6,
    );

    // A user resolves it before the detector runs again.
    db.prepare(`UPDATE commitments SET status = 'done', resolved_by = 'user' WHERE source = ? AND source_ref = ?`)
      .run('slack_ask', 'slack-dedupe-hash-abc');

    // Detector re-runs and re-detects the same commitment (e.g. re-scanning the same thread).
    db.prepare(upsert).run(
      2000, 'slack_ask', 'slack-dedupe-hash-abc', 'Reply to Morgan (updated)', 're-detected', 0.9,
    );

    const rows = db.prepare(
      `SELECT id, detected_at, title, detail, confidence, status, resolved_by FROM commitments WHERE source = ? AND source_ref = ?`
    ).all('slack_ask', 'slack-dedupe-hash-abc') as {
      id: number; detected_at: number; title: string; detail: string; confidence: number; status: string; resolved_by: string;
    }[];

    // Still exactly one row — no duplicate.
    expect(rows.length).toBe(1);
    // Detection fields refreshed by the upsert.
    expect(rows[0].detected_at).toBe(2000);
    expect(rows[0].title).toBe('Reply to Morgan (updated)');
    expect(rows[0].confidence).toBe(0.9);
    // But the user's resolution is untouched.
    expect(rows[0].status).toBe('done');
    expect(rows[0].resolved_by).toBe('user');
  });
});

/**
 * Exercises the real `runMigrations()` path (not the fixture's mirrored schema) against
 * a throwaway on-disk DB, so a typo in db.ts's DDL fails here rather than only showing up
 * at runtime in the daemon/MCP server.
 */
describe('db migrations', () => {
  let tempDir: string | undefined;
  let originalDataDir: string | undefined;

  afterEach(() => {
    _resetDb();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
  });

  function freshDb() {
    originalDataDir = process.env.DATA_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-db-test-'));
    process.env.DATA_DIR = tempDir;
    return getDb();
  }

  it('creates the meetings and meeting_segments tables', () => {
    const db = freshDb();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meetings', 'meeting_segments')")
      .all() as { name: string }[];

    expect(tables.map((t) => t.name).sort()).toEqual(['meeting_segments', 'meetings']);
  });

  it('defaults transcript_status to pending and allows a full round trip', () => {
    const db = freshDb();

    const insert = db.prepare(`
      INSERT INTO meetings (started_at, ended_at, platform, external_id, title, url)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = insert.run(1000, 1120, 'google_meet', 'abc-defg-hij', 'Standup', 'https://meet.google.com/abc-defg-hij');
    const meetingId = result.lastInsertRowid;

    const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId) as Record<string, unknown>;
    expect(row.transcript_status).toBe('pending');
    expect(row.platform).toBe('google_meet');

    // meeting_segments FK + cascade delete
    db.prepare(`
      INSERT INTO meeting_segments (meeting_id, started_ms, ended_ms, channel, text)
      VALUES (?, 0, 1000, 'me', 'hello')
    `).run(meetingId);

    const segmentsBefore = db.prepare('SELECT COUNT(*) as n FROM meeting_segments WHERE meeting_id = ?').get(meetingId) as { n: number };
    expect(segmentsBefore.n).toBe(1);

    db.prepare('DELETE FROM meetings WHERE id = ?').run(meetingId);

    const segmentsAfter = db.prepare('SELECT COUNT(*) as n FROM meeting_segments WHERE meeting_id = ?').get(meetingId) as { n: number };
    expect(segmentsAfter.n).toBe(0);
  });

  it('is idempotent — running migrations twice does not error', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-db-test-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempDir;

    getDb();
    _resetDb();
    expect(() => getDb()).not.toThrow();
  });
});
