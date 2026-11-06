import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { listUncorrelatedMeetings } from '../../src/queries/listUncorrelatedMeetings.js';
import type { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;

beforeEach(() => { db = setupTestDb(); });
afterEach(() => { teardownTestDb(); });

function insertMeeting(overrides: {
  started_at: number;
  ended_at?: number | null;
  title?: string | null;
  url?: string | null;
  platform?: string | null;
  calendar_event_id?: string | null;
}): number {
  const result = db.prepare(
    `INSERT INTO meetings (started_at, ended_at, platform, title, url, transcript_status, calendar_event_id)
     VALUES (?, ?, ?, ?, ?, 'done', ?)`
  ).run(
    overrides.started_at,
    overrides.ended_at ?? null,
    overrides.platform ?? 'zoom',
    overrides.title ?? 'Test meeting',
    overrides.url ?? null,
    overrides.calendar_event_id ?? null
  );
  return Number(result.lastInsertRowid);
}

// The seeded fixture DB (see `../fixtures/seed-test-db.ts`) already contains its own
// meetings, some correlated and some not, so assertions here filter down to the rows
// this file inserts rather than assuming the table starts empty.

describe('list_uncorrelated_meetings', () => {
  it('returns only meetings with a NULL calendar_event_id', () => {
    const uncorrelatedId = insertMeeting({ started_at: 100_000_000, title: 'Uncorrelated' });
    const correlatedId = insertMeeting({ started_at: 100_000_001, title: 'Correlated', calendar_event_id: 'evt-123' });

    const result = listUncorrelatedMeetings();
    const ids = result.meetings.map(m => m.id);

    expect(ids).toContain(uncorrelatedId);
    expect(ids).not.toContain(correlatedId);
  });

  it('includes start/end (ISO), url, and platform', () => {
    const id = insertMeeting({
      started_at: 100_000_010,
      ended_at: 100_000_610,
      title: 'With details',
      url: 'https://meet.google.com/abc-defg-hij',
      platform: 'google_meet',
    });

    const result = listUncorrelatedMeetings();
    const meeting = result.meetings.find(m => m.id === id);

    expect(meeting).toMatchObject({
      title: 'With details',
      url: 'https://meet.google.com/abc-defg-hij',
      platform: 'google_meet',
    });
    expect(meeting?.start).toBe(new Date(100_000_010 * 1000).toISOString());
    expect(meeting?.end).toBe(new Date(100_000_610 * 1000).toISOString());
  });

  it('handles a null ended_at', () => {
    const id = insertMeeting({ started_at: 100_000_020, ended_at: null });

    const result = listUncorrelatedMeetings();
    const meeting = result.meetings.find(m => m.id === id);

    expect(meeting?.end).toBeNull();
  });

  it('orders by started_at descending', () => {
    const earlierId = insertMeeting({ started_at: 100_000_030, title: 'Earlier' });
    const laterId = insertMeeting({ started_at: 100_000_040, title: 'Later' });

    const result = listUncorrelatedMeetings();
    const laterIndex = result.meetings.findIndex(m => m.id === laterId);
    const earlierIndex = result.meetings.findIndex(m => m.id === earlierId);

    expect(laterIndex).toBeGreaterThanOrEqual(0);
    expect(earlierIndex).toBeGreaterThanOrEqual(0);
    expect(laterIndex).toBeLessThan(earlierIndex);
  });

  it('respects limit', () => {
    insertMeeting({ started_at: 100_000_050 });
    insertMeeting({ started_at: 100_000_060 });

    const result = listUncorrelatedMeetings({ limit: 1 });

    expect(result.meetings).toHaveLength(1);
  });

  it('excludes a meeting once it is correlated', () => {
    const id = insertMeeting({ started_at: 100_000_070, calendar_event_id: 'evt-1' });

    const result = listUncorrelatedMeetings();

    expect(result.meetings.map(m => m.id)).not.toContain(id);
  });
});
