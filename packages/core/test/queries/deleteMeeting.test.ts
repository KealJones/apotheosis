import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { deleteMeeting } from '../../src/queries/deleteMeeting.js';
import type { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let db: DatabaseSync;

beforeEach(() => { db = setupTestDb(); });
afterEach(() => { teardownTestDb(); });

describe('delete_meeting', () => {
  it('deletes the meeting row, its segments, and its audio directory on disk', () => {
    const audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-meeting-audio-'));
    const audioFile = path.join(audioDir, 'me.caf');
    fs.writeFileSync(audioFile, 'fake audio bytes');

    const insertMeeting = db.prepare(
      `INSERT INTO meetings (started_at, ended_at, platform, external_id, title, transcript_status, audio_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const result = insertMeeting.run(1000, 1060, 'zoom', 'meeting-audio-test', 'Test meeting', 'done', audioDir);
    const meetingId = Number(result.lastInsertRowid);

    db.prepare(
      `INSERT INTO meeting_segments (meeting_id, started_ms, ended_ms, channel, text) VALUES (?, ?, ?, ?, ?)`
    ).run(meetingId, 0, 1000, 'me', 'hello there');

    const data = deleteMeeting({ meeting_id: meetingId });

    expect(data.deleted).toBe(true);
    expect(data.errors).toEqual([]);

    const meetingRow = db.prepare('SELECT id FROM meetings WHERE id = ?').get(meetingId);
    expect(meetingRow).toBeUndefined();

    const segmentRows = db.prepare('SELECT id FROM meeting_segments WHERE meeting_id = ?').all(meetingId);
    expect(segmentRows).toEqual([]);

    expect(fs.existsSync(audioDir)).toBe(false);
  });

  it('deletes a meeting with no audio_path (already cleaned up) without error', () => {
    const insertMeeting = db.prepare(
      `INSERT INTO meetings (started_at, ended_at, platform, external_id, title, transcript_status, audio_path)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`
    );
    const result = insertMeeting.run(2000, 2060, 'zoom', 'meeting-no-audio', 'No audio meeting', 'done');
    const meetingId = Number(result.lastInsertRowid);

    const data = deleteMeeting({ meeting_id: meetingId });

    expect(data.deleted).toBe(true);
    expect(data.errors).toEqual([]);
    const meetingRow = db.prepare('SELECT id FROM meetings WHERE id = ?').get(meetingId);
    expect(meetingRow).toBeUndefined();
  });

  it('reports not found for a non-existent meeting id', () => {
    const data = deleteMeeting({ meeting_id: 999999 });
    expect(data.deleted).toBe(false);
    expect(data.errors[0]).toContain('999999');
  });
});
