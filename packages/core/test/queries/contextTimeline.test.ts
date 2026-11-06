import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { getContextTimeline } from '../../src/queries/contextTimeline.js';
import { DAY_START_ISO, DAY_END_ISO } from '../fixtures/seed-test-db.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('context_timeline', () => {
  it('returns events and counts', () => {
    const data = getContextTimeline({ since: DAY_START_ISO, until: DAY_END_ISO });
    expect(data).toHaveProperty('events');
    expect(data).toHaveProperty('counts');
    expect(data.events.length).toBeGreaterThan(0);
  });

  it('events have expected fields', () => {
    const data = getContextTimeline({ since: DAY_START_ISO, until: DAY_END_ISO });
    const event = data.events[0];
    expect(event).toHaveProperty('id');
    expect(event).toHaveProperty('time');
    expect(event).toHaveProperty('event_type');
    expect(event).toHaveProperty('app_name');
    expect(event).toHaveProperty('window_title');
  });

  it('counts include all event types from fixtures', () => {
    const data = getContextTimeline({ since: DAY_START_ISO, until: DAY_END_ISO });
    expect(data.counts).toHaveProperty('app_switch');
    expect(data.counts).toHaveProperty('window_focus');
    expect(data.counts).toHaveProperty('title_change');
    expect(data.counts).toHaveProperty('file_modified');
  });

  it('filters by event_type', () => {
    const data = getContextTimeline({
      since: DAY_START_ISO, until: DAY_END_ISO, event_type: 'app_switch',
    });
    expect(data.events.every((e) => e.event_type === 'app_switch')).toBe(true);
    expect(data.events.length).toBe(6); // fixture has 6 app_switch events
  });

  it('returns empty for out-of-range query', () => {
    const data = getContextTimeline({ since: '2020-01-01T00:00:00Z', until: '2020-01-01T01:00:00Z' });
    expect(data.events).toEqual([]);
  });
});
