import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { listMeetings } from '../../src/queries/listMeetings.js';
import { DAY_START_ISO, DAY_END_ISO, TEST_DAY } from '../fixtures/seed-test-db.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('list_meetings', () => {
  it('returns meetings in the test day range', () => {
    const result = listMeetings({
      since: DAY_START_ISO,
      until: DAY_END_ISO,
    });

    expect(result.meetings).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('includes meeting summary, title, platform, and duration', () => {
    const result = listMeetings({
      since: DAY_START_ISO,
      until: DAY_END_ISO,
    });

    // Find the Q3 Planning meeting (started earlier, appears second due to DESC ordering)
    const meeting = result.meetings.find(m => m.title === 'Q3 Planning & Roadmap');
    expect(meeting).toBeDefined();
    expect(meeting).toHaveProperty('title', 'Q3 Planning & Roadmap');
    expect(meeting).toHaveProperty('start');
    expect(meeting).toHaveProperty('platform', 'zoom');
    expect(meeting).toHaveProperty('duration_seconds');
    expect(meeting).toHaveProperty('has_summary', true);
    expect(meeting).toHaveProperty('segment_count', 6); // From our fixtures
  });

  it('reflects summary existence correctly', () => {
    const result = listMeetings({
      since: DAY_START_ISO,
      until: DAY_END_ISO,
    });

    // Find meetings by title
    const q3Meeting = result.meetings.find(m => m.title === 'Q3 Planning & Roadmap');
    const designMeeting = result.meetings.find(m => m.title === 'Weekly Design Sync');

    expect(q3Meeting?.has_summary).toBe(true);
    expect(designMeeting?.has_summary).toBe(false);
  });

  it('counts transcript segments per meeting', () => {
    const result = listMeetings({
      since: DAY_START_ISO,
      until: DAY_END_ISO,
    });

    // Find meetings by title
    const q3Meeting = result.meetings.find(m => m.title === 'Q3 Planning & Roadmap');
    const designMeeting = result.meetings.find(m => m.title === 'Weekly Design Sync');

    expect(q3Meeting?.segment_count).toBe(6);
    expect(designMeeting?.segment_count).toBe(3);
  });

  it('filters by platform', () => {
    const result = listMeetings({
      since: DAY_START_ISO,
      until: DAY_END_ISO,
      platform: 'zoom',
    });

    expect(result.meetings).toHaveLength(1);
    expect(result.meetings[0].platform).toBe('zoom');
  });

  it('respects limit parameter', () => {
    const result = listMeetings({
      since: DAY_START_ISO,
      until: DAY_END_ISO,
      limit: 1,
    });

    expect(result.meetings).toHaveLength(1);
  });

  it('returns empty list outside date range', () => {
    const result = listMeetings({
      since: '2020-01-01',
      until: '2020-01-02',
    });

    expect(result.meetings).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
