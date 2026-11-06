import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { linkMeetingCalendarEvent } from '../../src/queries/linkMeetingCalendarEvent.js';
import type { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;

beforeEach(() => { db = setupTestDb(); });
afterEach(() => { teardownTestDb(); });

function insertMeeting(overrides: {
  started_at: number;
  title?: string | null;
  calendar_event_id?: string | null;
  participants?: string | null;
}): number {
  const result = db.prepare(
    `INSERT INTO meetings (started_at, platform, title, transcript_status, calendar_event_id, participants)
     VALUES (?, 'zoom', ?, 'done', ?, ?)`
  ).run(
    overrides.started_at,
    overrides.title ?? null,
    overrides.calendar_event_id ?? null,
    overrides.participants ?? null
  );
  return Number(result.lastInsertRowid);
}

describe('link_meeting_calendar_event', () => {
  it('links a meeting with no prior correlation', () => {
    const meetingId = insertMeeting({ started_at: 1000, title: null });

    const result = linkMeetingCalendarEvent({
      meeting_id: meetingId,
      calendar_event_id: 'evt-abc',
      title: 'Q3 Planning',
      participants: ['Alice', 'Bob'],
    });

    expect(result).toEqual({ status: 'linked', meeting_id: meetingId, calendar_event_id: 'evt-abc' });

    const row = db.prepare(
      'SELECT calendar_event_id, title, participants FROM meetings WHERE id = ?'
    ).get(meetingId) as { calendar_event_id: string; title: string; participants: string };

    expect(row.calendar_event_id).toBe('evt-abc');
    expect(row.title).toBe('Q3 Planning');
    expect(JSON.parse(row.participants)).toEqual(['Alice', 'Bob']);
  });

  it('preserves an existing title when none is passed', () => {
    const meetingId = insertMeeting({ started_at: 1000, title: 'Existing title' });

    linkMeetingCalendarEvent({ meeting_id: meetingId, calendar_event_id: 'evt-xyz' });

    const row = db.prepare('SELECT title FROM meetings WHERE id = ?').get(meetingId) as { title: string };
    expect(row.title).toBe('Existing title');
  });

  it('is idempotent: a second call does not overwrite or duplicate the correlation', () => {
    const meetingId = insertMeeting({ started_at: 1000, title: null });

    const first = linkMeetingCalendarEvent({
      meeting_id: meetingId,
      calendar_event_id: 'evt-first',
      title: 'First match',
      participants: ['Alice'],
    });
    expect(first.status).toBe('linked');

    const second = linkMeetingCalendarEvent({
      meeting_id: meetingId,
      calendar_event_id: 'evt-second',
      title: 'Different title',
      participants: ['Someone Else'],
    });

    expect(second).toEqual({ status: 'already_linked', meeting_id: meetingId, calendar_event_id: 'evt-first' });

    // Row must still reflect the first (only) correlation, untouched by the second call.
    const row = db.prepare(
      'SELECT calendar_event_id, title, participants FROM meetings WHERE id = ?'
    ).get(meetingId) as { calendar_event_id: string; title: string; participants: string };

    expect(row.calendar_event_id).toBe('evt-first');
    expect(row.title).toBe('First match');
    expect(JSON.parse(row.participants)).toEqual(['Alice']);
  });

  it('reports already_linked (rather than erroring) when the meeting was correlated by something else first', () => {
    const meetingId = insertMeeting({ started_at: 1000, calendar_event_id: 'evt-pre-existing' });

    const result = linkMeetingCalendarEvent({ meeting_id: meetingId, calendar_event_id: 'evt-new' });

    expect(result).toEqual({
      status: 'already_linked',
      meeting_id: meetingId,
      calendar_event_id: 'evt-pre-existing',
    });
  });

  it('returns an error for a non-existent meeting', () => {
    const result = linkMeetingCalendarEvent({ meeting_id: 999999, calendar_event_id: 'evt-1' });
    expect(result).toEqual({ error: 'Meeting 999999 not found.' });
  });

  it('does not touch unrelated meeting fields', () => {
    const meetingId = insertMeeting({ started_at: 1000, title: null });
    db.prepare(`UPDATE meetings SET transcript_status = 'done', summary = 'existing summary' WHERE id = ?`).run(meetingId);

    linkMeetingCalendarEvent({ meeting_id: meetingId, calendar_event_id: 'evt-1', title: 'New title' });

    const row = db.prepare(
      'SELECT transcript_status, summary FROM meetings WHERE id = ?'
    ).get(meetingId) as { transcript_status: string; summary: string };

    expect(row.transcript_status).toBe('done');
    expect(row.summary).toBe('existing summary');
  });
});
