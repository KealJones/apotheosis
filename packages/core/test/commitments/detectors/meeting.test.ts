import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDb, _resetDb, type Db } from '../../../src/db.js';
import { runDetectors, type Commitment } from '../../../src/commitments/index.js';
import { meeting } from '../../../src/commitments/detectors/meeting.js';

const DAY = 86_400;

interface MeetingRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  title: string | null;
  url: string | null;
  action_items: string | null;
  summary_generated_at: number | null;
}

function insertMeeting(
  db: Db,
  opts: {
    startedAt: number;
    endedAt?: number;
    title?: string;
    url?: string;
    actionItems?: { text: string; owner: 'me' | 'them' | 'unknown' }[] | null;
    summaryGeneratedAt?: number;
  },
): number {
  const result = db.prepare(`
    INSERT INTO meetings (started_at, ended_at, title, url, action_items, summary_generated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    opts.startedAt,
    opts.endedAt ?? null,
    opts.title ?? null,
    opts.url ?? null,
    opts.actionItems ? JSON.stringify(opts.actionItems) : null,
    opts.summaryGeneratedAt ?? null,
  );
  return Number(result.lastInsertRowid);
}

function rows(db: Db): Commitment[] {
  return db.prepare("SELECT * FROM commitments WHERE source = 'meeting' ORDER BY id").all() as Commitment[];
}

let dataDir: string;
let originalDataDir: string | undefined;
let db: Db;
const realNow = Math.floor(Date.now() / 1000);

beforeEach(() => {
  originalDataDir = process.env.DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-meeting-data-'));
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

describe('meeting detector', () => {
  it('does not flag meetings without action_items', async () => {
    insertMeeting(db, {
      startedAt: realNow - 2 * DAY,
      endedAt: realNow - 2 * DAY + 3600,
      title: 'Standup',
      actionItems: null,
      summaryGeneratedAt: realNow - 2 * DAY + 3600,
    });

    const report = await runDetectors({ detectors: [meeting], now: realNow });
    expect(report.detectors[0].detected).toBe(0);
  });

  it('does not flag meetings without summary_generated_at', async () => {
    insertMeeting(db, {
      startedAt: realNow - 2 * DAY,
      endedAt: realNow - 2 * DAY + 3600,
      title: 'Meeting',
      actionItems: [{ text: 'Fix the bug', owner: 'me' }],
      summaryGeneratedAt: null,
    });

    const report = await runDetectors({ detectors: [meeting], now: realNow });
    expect(report.detectors[0].detected).toBe(0);
  });

  it('emits candidates for action items owned by me', async () => {
    insertMeeting(db, {
      startedAt: realNow - 2 * DAY,
      endedAt: realNow - 2 * DAY + 3600,
      title: 'Team Sync',
      url: 'https://meet.google.com/abc-def-ghi',
      actionItems: [
        { text: 'Fix the critical bug', owner: 'me' },
        { text: 'Alice to write docs', owner: 'them' },
        { text: 'Unknown for now', owner: 'unknown' },
      ],
      summaryGeneratedAt: realNow - 2 * DAY + 3600,
    });

    const report = await runDetectors({ detectors: [meeting], now: realNow });
    expect(report.detectors[0]).toMatchObject({ detected: 1, inserted: 1 });

    const meeting_rows = rows(db);
    expect(meeting_rows).toHaveLength(1);
    expect(meeting_rows[0]).toMatchObject({
      status: 'open',
      source: 'meeting',
      confidence: 0.9,
    });
    expect(meeting_rows[0].title).toContain('Fix the critical bug');
    expect(meeting_rows[0].detail).toContain('Team Sync');
    expect(meeting_rows[0].last_activity_at).toBe(realNow - 2 * DAY + 3600);
  });

  it('uses stable refs based on item text hash (survives re-detection)', async () => {
    const meetingId = insertMeeting(db, {
      startedAt: realNow - 2 * DAY,
      endedAt: realNow - 2 * DAY + 3600,
      title: 'Planning',
      actionItems: [{ text: 'Implement feature X', owner: 'me' }],
      summaryGeneratedAt: realNow - 2 * DAY + 3600,
    });

    // First run
    let report = await runDetectors({ detectors: [meeting], now: realNow });
    expect(report.detectors[0]).toMatchObject({ detected: 1, inserted: 1 });

    const firstId = rows(db)[0].id;
    const firstRef = rows(db)[0].source_ref;

    // Second run with same data should not duplicate
    report = await runDetectors({ detectors: [meeting], now: realNow + 60 });
    expect(report.detectors[0]).toMatchObject({ detected: 1, inserted: 0 });

    const secondRows = rows(db);
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0].id).toBe(firstId); // Same commitment row
    expect(secondRows[0].source_ref).toBe(firstRef);
  });

  it('recognizes the same item text across re-summarization', async () => {
    const meetingId = insertMeeting(db, {
      startedAt: realNow - 2 * DAY,
      endedAt: realNow - 2 * DAY + 3600,
      title: 'Sync',
      actionItems: [
        { text: 'Task A', owner: 'me' },
        { text: 'Task B', owner: 'them' },
      ],
      summaryGeneratedAt: realNow - 2 * DAY + 3600,
    });

    const report1 = await runDetectors({ detectors: [meeting], now: realNow });
    expect(report1.detectors[0].detected).toBe(1); // Only "Task A"

    // Simulate re-summarization: reorder items and add/remove one
    db.prepare(`
      UPDATE meetings
      SET action_items = ?, summary_generated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify([
        { text: 'Task B (updated)', owner: 'them' }, // Changed & still not mine
        { text: 'Task A', owner: 'me' }, // Same text, reordered
      ]),
      realNow - 1 * DAY,
      meetingId,
    );

    // Re-detect: should still find only 1 (Task A with same hash, no new duplicates)
    const report2 = await runDetectors({ detectors: [meeting], now: realNow });
    expect(report2.detectors[0]).toMatchObject({ detected: 1, inserted: 0 });

    // Verify no duplication
    const allRows = rows(db);
    expect(allRows).toHaveLength(1);
    expect(allRows[0].title).toContain('Task A');
  });

  it('emits multiple candidates from the same meeting', async () => {
    insertMeeting(db, {
      startedAt: realNow - 1 * DAY,
      endedAt: realNow - 1 * DAY + 7200,
      title: 'Sprint Planning',
      actionItems: [
        { text: 'Implement feature X', owner: 'me' },
        { text: 'Review PR #123', owner: 'me' },
        { text: 'Write tests', owner: 'me' },
        { text: 'Bob: integrate with backend', owner: 'them' },
      ],
      summaryGeneratedAt: realNow - 1 * DAY + 7200,
    });

    const report = await runDetectors({ detectors: [meeting], now: realNow });
    expect(report.detectors[0]).toMatchObject({ detected: 3, inserted: 3 });

    const meeting_rows = rows(db);
    expect(meeting_rows).toHaveLength(3);
    expect(meeting_rows.map((r) => r.title)).toEqual([
      'Implement feature X',
      'Review PR #123',
      'Write tests',
    ]);
    expect(meeting_rows.every((r) => r.source === 'meeting')).toBe(true);
  });

  it('handles malformed JSON gracefully', async () => {
    db.prepare(`
      INSERT INTO meetings (started_at, action_items, summary_generated_at)
      VALUES (?, ?, ?)
    `).run(realNow - 1 * DAY, '{invalid json}', realNow - 1 * DAY + 3600);

    const report = await runDetectors({ detectors: [meeting], now: realNow });
    expect(report.detectors[0].detected).toBe(0); // Silently skipped
  });

  it('does not reconcile (defers to auto-expiry)', async () => {
    insertMeeting(db, {
      startedAt: realNow - 2 * DAY,
      endedAt: realNow - 2 * DAY + 3600,
      title: 'Meeting',
      actionItems: [{ text: 'Do something', owner: 'me' }],
      summaryGeneratedAt: realNow - 2 * DAY + 3600,
    });

    let report = await runDetectors({ detectors: [meeting], now: realNow });
    expect(report.detectors[0].detected).toBe(1);

    // Re-remove the action_items to simulate the meeting being re-summarized with no items
    // (or the meeting being deleted). The commitment should remain open; reconcile() doesn't close it.
    db.prepare('UPDATE meetings SET action_items = NULL WHERE action_items IS NOT NULL').run();

    report = await runDetectors({ detectors: [meeting], now: realNow + DAY });
    expect(report.detectors[0].resolved).toBe(0); // No reconciliation

    const meeting_rows = rows(db);
    expect(meeting_rows[0].status).toBe('open'); // Still open
  });
});
