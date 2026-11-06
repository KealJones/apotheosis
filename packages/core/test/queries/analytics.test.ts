import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import {
  getActiveHoursByDay,
  getTimeByApp,
  getTimeByProject,
  getContextSwitchRate,
  getTimeBreakdown,
  getAiLeverage,
  getMeetingLoad,
} from '../../src/queries/analytics.js';
import {
  ANALYTICS_RANGE_START_ISO,
  ANALYTICS_RANGE_END_ISO,
  DAY_START_ISO,
  DAY_END_ISO,
} from '../fixtures/seed-test-db.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('getActiveHoursByDay', () => {
  it('buckets samples by localtime day across the full fixture range', () => {
    const data = getActiveHoursByDay({ since: ANALYTICS_RANGE_START_ISO, until: ANALYTICS_RANGE_END_ISO });
    // Main fixture day (2026-05-18, Sunday), the added Saturday, and the added Monday.
    expect(data.days.length).toBeGreaterThanOrEqual(3);
    expect(data.days.every((d) => d.hours > 0)).toBe(true);
  });

  it('flags weekend vs weekday days correctly', () => {
    const data = getActiveHoursByDay({ since: ANALYTICS_RANGE_START_ISO, until: ANALYTICS_RANGE_END_ISO });
    // 2026-05-18 and 2026-06-02 are both weekdays (Mon/Tue); 2026-05-16 is the
    // Saturday two days before the main fixture day.
    const mainDay = data.days.find((d) => d.day === '2026-05-18');
    const saturday = data.days.find((d) => d.day === '2026-05-16');
    const weekday2 = data.days.find((d) => d.day === '2026-06-02');
    expect(mainDay?.isWeekend).toBe(false);
    expect(saturday?.isWeekend).toBe(true);
    expect(weekday2?.isWeekend).toBe(false);
  });

  it('returns empty for an out-of-range window', () => {
    const data = getActiveHoursByDay({ since: '2020-01-01T00:00:00Z', until: '2020-01-02T00:00:00Z' });
    expect(data.days).toEqual([]);
  });
});

describe('getTimeByApp', () => {
  it('ranks apps by sample count and reports hours', () => {
    const data = getTimeByApp({ since: DAY_START_ISO, until: DAY_END_ISO });
    expect(data.apps.length).toBeGreaterThan(0);
    // VS Code has the most samples in the main fixture day (118 across 5 sessions,
    // vs. 60 for Chrome).
    expect(data.apps[0].app).toBe('Code');
    expect(data.apps[0].hours).toBeGreaterThan(0);
  });

  it('folds apps past the limit into otherHours', () => {
    const data = getTimeByApp({ since: DAY_START_ISO, until: DAY_END_ISO, limit: 1 });
    expect(data.apps.length).toBe(1);
    expect(data.otherHours).toBeGreaterThan(0);
  });
});

describe('getTimeByProject', () => {
  it('assigns matching samples to the wid-4582 project and leaves the rest unassigned', () => {
    const data = getTimeByProject({ since: DAY_START_ISO, until: DAY_END_ISO });
    const fed = data.projects.find((p) => p.project.includes('WID-4582'));
    expect(fed).toBeDefined();
    expect(fed!.hours).toBeGreaterThan(0);
    // Slack DM / personal browsing / Finder sessions in the main fixture day
    // don't mention WID-4582 or widgets, so they land in unassignedHours.
    expect(data.unassignedHours).toBeGreaterThan(0);
  });

  it('assigns the weekday coding session to the apotheosis project', () => {
    const data = getTimeByProject({ since: ANALYTICS_RANGE_START_ISO, until: ANALYTICS_RANGE_END_ISO });
    const apotheosis = data.projects.find((p) => p.project === 'Apotheosis dashboard');
    expect(apotheosis).toBeDefined();
    expect(apotheosis!.hours).toBeGreaterThan(0);
  });
});

describe('getContextSwitchRate', () => {
  it('buckets app_switch events into hours', () => {
    const data = getContextSwitchRate({ since: DAY_START_ISO, until: DAY_END_ISO });
    expect(data.hours.length).toBeGreaterThan(0);
    const total = data.hours.reduce((sum, h) => sum + h.switches, 0);
    expect(total).toBe(6); // fixture has 6 app_switch events on the main day
  });

  it('spans two distinct hour buckets on the added weekday', () => {
    const data = getContextSwitchRate({ since: '2026-06-02T00:00:00Z', until: '2026-06-02T23:59:59Z' });
    const distinctHours = new Set(data.hours.map((h) => h.hour));
    expect(distinctHours.size).toBeGreaterThanOrEqual(2);
  });
});

describe('getTimeBreakdown', () => {
  it('splits coding, meeting, Slack, and other time per day', () => {
    const data = getTimeBreakdown({ since: ANALYTICS_RANGE_START_ISO, until: ANALYTICS_RANGE_END_ISO });
    const monday = data.days.find((d) => d.day === '2026-06-02');
    expect(monday).toBeDefined();
    expect(monday!.codingHours).toBeGreaterThan(0); // VS Code session
    expect(monday!.slackHours).toBeGreaterThan(0); // Slack session
    expect(monday!.otherHours).toBeGreaterThan(0); // unrelated browsing

    const sunday = data.days.find((d) => d.day === '2026-05-18');
    expect(sunday).toBeDefined();
    expect(sunday!.meetingHours).toBeGreaterThan(0); // week-1 meeting fixture
  });
});

describe('getAiLeverage', () => {
  it('counts tool_usage calls per day and ranks top tools/skills', () => {
    const data = getAiLeverage({ since: ANALYTICS_RANGE_START_ISO, until: ANALYTICS_RANGE_END_ISO });
    expect(data.perDay.length).toBeGreaterThan(0);
    expect(data.topTools[0].name).toBe('mcp__apotheosis__recent_activity');
    expect(data.topTools[0].calls).toBe(5);
    expect(data.skillsInvoked.find((s) => s.name === 'daily-standup')).toBeDefined();
  });
});

describe('getMeetingLoad', () => {
  it('groups meetings by week with count and average length', () => {
    const data = getMeetingLoad({ since: ANALYTICS_RANGE_START_ISO, until: ANALYTICS_RANGE_END_ISO });
    expect(data.weeks.length).toBeGreaterThanOrEqual(2);
    const totalCount = data.weeks.reduce((sum, w) => sum + w.count, 0);
    // 1 (this suite's own week-1 fixture) + 2 (week 2) + 2 (A5's meeting-tools fixture,
    // seeded on the main fixture day, which falls in the same week as week 1) = 5.
    expect(totalCount).toBe(5);
    const busyWeek = data.weeks.find((w) => w.count === 2);
    expect(busyWeek).toBeDefined();
    expect(busyWeek!.hours).toBeCloseTo(1.5, 1);
    expect(busyWeek!.avgMinutes).toBe(45);
  });

  it('returns nothing for a range with no meetings', () => {
    const data = getMeetingLoad({ since: '2020-01-01T00:00:00Z', until: '2020-01-02T00:00:00Z' });
    expect(data.weeks).toEqual([]);
  });
});
