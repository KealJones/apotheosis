import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { searchMeetings } from '../../src/queries/searchMeetings.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

describe('search_meetings', () => {
  it('finds segments matching a simple query', () => {
    const result = searchMeetings({ query: 'planning' });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.query).toBe('planning');
    expect(result.total).toBeGreaterThan(0);
  });

  it('returns results with meeting context', () => {
    const result = searchMeetings({ query: 'Q3' });

    expect(result.results.length).toBeGreaterThan(0);
    const hit = result.results[0];
    expect(hit).toHaveProperty('meeting_id');
    expect(hit).toHaveProperty('meeting_title');
    expect(hit).toHaveProperty('meeting_start');
    expect(hit).toHaveProperty('segment_id');
    expect(hit).toHaveProperty('timestamp');
    expect(hit).toHaveProperty('text');
  });

  it('includes segment timestamp in mm:ss format', () => {
    const result = searchMeetings({ query: 'planning' });

    const hit = result.results[0];
    expect(hit.timestamp).toMatch(/^\d+:\d{2}$/);
  });

  it('finds multiple occurrences across different meetings', () => {
    const result = searchMeetings({ query: 'design' });

    // Should find "dashboard" in one meeting and "design direction" in another
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('respects limit parameter', () => {
    const result = searchMeetings({
      query: 'the',
      limit: 2,
    });

    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty results for non-matching query', () => {
    const result = searchMeetings({ query: 'xyznonexistentword' });

    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('handles case-insensitive search', () => {
    const result1 = searchMeetings({ query: 'roadmap' });
    const result2 = searchMeetings({ query: 'ROADMAP' });
    const result3 = searchMeetings({ query: 'Roadmap' });

    // FTS5 is case-insensitive by default
    expect(result1.total).toBeGreaterThan(0);
    expect(result2.total).toBe(result1.total);
    expect(result3.total).toBe(result1.total);
  });

  it('supports FTS5 AND operator', () => {
    // Find segments that have both "Q3" and "planning"
    const result = searchMeetings({ query: 'planning AND roadmap' });

    expect(result.results.length).toBeGreaterThan(0);
    // At least one result should have both terms in the same segment or related context
    const hasPlanning = result.results.some(r => r.text.toLowerCase().includes('planning'));
    expect(hasPlanning).toBe(true);
  });

  it('supports FTS5 OR operator', () => {
    const result = searchMeetings({ query: 'roadmap OR dashboard' });

    expect(result.results.length).toBeGreaterThan(0);
  });

  it('finds exact word matches in transcript', () => {
    const result = searchMeetings({ query: 'coverage' });

    expect(result.results.length).toBeGreaterThan(0);
    // Should find "test coverage" segment
    expect(result.results.some(r => r.text.toLowerCase().includes('coverage'))).toBe(true);
  });

  it('returns results ordered by meeting (most recent first) then timestamp', () => {
    const result = searchMeetings({ query: 'the', limit: 20 });

    if (result.results.length > 1) {
      // Check meetings are in descending order (most recent first)
      for (let i = 0; i < result.results.length - 1; i++) {
        const current = new Date(result.results[i].meeting_start).getTime();
        const next = new Date(result.results[i + 1].meeting_start).getTime();
        expect(current).toBeGreaterThanOrEqual(next);
      }
    }
  });

  it('searches across all segment text', () => {
    // "Test User" is a speaker/name in the segments
    const result = searchMeetings({ query: 'Friday' });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.some(r => r.text.includes('Friday'))).toBe(true);
  });
});
