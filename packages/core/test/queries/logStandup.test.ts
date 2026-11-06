import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { logStandup } from '../../src/queries/logStandup.js';
import type { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;

beforeEach(() => { db = setupTestDb(); });
afterEach(() => { teardownTestDb(); });

describe('log_standup', () => {
  it('inserts a new standup', () => {
    logStandup({
      date: '2026-05-20',
      yesterday: '- Did testing',
      today: '- More testing',
      blockers: 'None',
    });

    const row = db.prepare(
      'SELECT * FROM standups WHERE date = ?'
    ).get('2026-05-20') as any;
    expect(row.yesterday).toBe('- Did testing');
    expect(row.today).toBe('- More testing');
    expect(row.blockers).toBe('None');
  });

  it('upserts (replaces) standup for same date', () => {
    // Fixture already has a standup for 2026-05-18
    logStandup({
      date: '2026-05-18',
      yesterday: '- Updated standup',
    });

    const row = db.prepare(
      'SELECT * FROM standups WHERE date = ?'
    ).get('2026-05-18') as any;
    expect(row.yesterday).toBe('- Updated standup');
  });

  it('handles optional fields as null', () => {
    logStandup({
      date: '2026-05-21',
      yesterday: '- Required field',
    });

    const row = db.prepare(
      'SELECT * FROM standups WHERE date = ?'
    ).get('2026-05-21') as any;
    expect(row.today).toBeNull();
    expect(row.blockers).toBeNull();
  });

  it('splits each section into standup_items, one per bullet line', () => {
    logStandup({
      date: '2026-05-22',
      yesterday: '- Did testing\n- Reviewed PR #42',
      today: '- More testing',
      blockers: 'None',
    });

    const standup = db.prepare('SELECT id FROM standups WHERE date = ?').get('2026-05-22') as { id: number };
    const items = db.prepare(
      'SELECT section, position, text FROM standup_items WHERE standup_id = ? ORDER BY section, position'
    ).all(standup.id) as { section: string; position: number; text: string }[];

    // "None" is a placeholder meaning "no blockers", not an item — see PLACEHOLDER_RE.
    expect(items).toEqual([
      { section: 'today', position: 0, text: 'More testing' },
      { section: 'yesterday', position: 0, text: 'Did testing' },
      { section: 'yesterday', position: 1, text: 'Reviewed PR #42' },
    ]);
  });

  it('does not create an item for a placeholder "None"/"N/A" blockers section', () => {
    logStandup({ date: '2026-05-24', yesterday: '- Did something', blockers: 'None.' });

    const standup = db.prepare('SELECT id FROM standups WHERE date = ?').get('2026-05-24') as { id: number };
    const items = db.prepare(
      "SELECT text FROM standup_items WHERE standup_id = ? AND section = 'blockers'"
    ).all(standup.id);

    expect(items).toEqual([]);
  });

  it('treats "None" followed by an unrelated aside as a placeholder too (real-world phrasing)', () => {
    logStandup({
      date: '2026-05-25',
      yesterday: '- Did something',
      blockers: 'None - #91 approved by Jamie Fox this morning',
    });

    const standup = db.prepare('SELECT id FROM standups WHERE date = ?').get('2026-05-25') as { id: number };
    const items = db.prepare(
      "SELECT text FROM standup_items WHERE standup_id = ? AND section = 'blockers'"
    ).all(standup.id);

    expect(items).toEqual([]);
  });

  it('re-splits idempotently when a standup for the same date is logged again', () => {
    logStandup({ date: '2026-05-23', yesterday: '- First\n- Second' });
    logStandup({ date: '2026-05-23', yesterday: '- Only one now' });

    const standup = db.prepare('SELECT id FROM standups WHERE date = ?').get('2026-05-23') as { id: number };
    const items = db.prepare(
      'SELECT text FROM standup_items WHERE standup_id = ?'
    ).all(standup.id) as { text: string }[];

    expect(items).toEqual([{ text: 'Only one now' }]);
  });

  /** commitment_id is FK-enforced (PRAGMA foreign_keys = ON), so tests need a real row to point at. */
  function insertCommitment(sourceRef: string): number {
    const result = db.prepare(`
      INSERT INTO commitments (detected_at, source, source_ref, title, confidence, status)
      VALUES (?, 'slack_promise', ?, 'Review PR #42', 0.8, 'open')
    `).run(Math.floor(Date.now() / 1000), sourceRef);
    return Number(result.lastInsertRowid);
  }

  it('links today items to commitment ids via todayCommitmentIds (C7 standup_items.commitment_id)', () => {
    const commitmentId = insertCommitment('logstandup-test-1');
    logStandup({
      date: '2026-05-26',
      yesterday: '- Did something',
      today: '- Review PR #42\n- Freehand task',
      todayCommitmentIds: [commitmentId, null],
    });

    const standup = db.prepare('SELECT id FROM standups WHERE date = ?').get('2026-05-26') as { id: number };
    const items = db.prepare(
      "SELECT position, text, commitment_id FROM standup_items WHERE standup_id = ? AND section = 'today' ORDER BY position"
    ).all(standup.id) as { position: number; text: string; commitment_id: number | null }[];

    expect(items).toEqual([
      { position: 0, text: 'Review PR #42', commitment_id: commitmentId },
      { position: 1, text: 'Freehand task', commitment_id: null },
    ]);
  });

  it('never sets commitment_id on yesterday/blockers items, even if todayCommitmentIds is passed', () => {
    const commitmentId = insertCommitment('logstandup-test-2');
    logStandup({
      date: '2026-05-27',
      yesterday: '- Old item',
      today: '- New item',
      blockers: '- Blocked thing',
      todayCommitmentIds: [commitmentId],
    });

    const standup = db.prepare('SELECT id FROM standups WHERE date = ?').get('2026-05-27') as { id: number };
    const nonToday = db.prepare(
      "SELECT commitment_id FROM standup_items WHERE standup_id = ? AND section != 'today'"
    ).all(standup.id) as { commitment_id: number | null }[];

    expect(nonToday.every((r) => r.commitment_id === null)).toBe(true);
  });

  it('omitting todayCommitmentIds leaves every commitment_id null (backward compatible)', () => {
    logStandup({ date: '2026-05-28', yesterday: '- x', today: '- y' });

    const standup = db.prepare('SELECT id FROM standups WHERE date = ?').get('2026-05-28') as { id: number };
    const items = db.prepare(
      'SELECT commitment_id FROM standup_items WHERE standup_id = ?'
    ).all(standup.id) as { commitment_id: number | null }[];

    expect(items.every((r) => r.commitment_id === null)).toBe(true);
  });
});
