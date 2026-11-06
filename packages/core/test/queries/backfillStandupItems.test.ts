import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDb, _resetDb, type Db } from '../../src/db.js';
import { backfillStandupItems } from '../../src/queries/backfillStandupItems.js';

let dataDir: string;
let originalDataDir: string | undefined;
let db: Db;

beforeEach(() => {
  originalDataDir = process.env.DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-backfill-'));
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

/** Simulates a pre-existing standup row from before standup_items existed: written with
 * raw SQL, bypassing logStandup() entirely, so no items exist for it yet. */
function insertLegacyStandup(date: string, yesterday: string, today: string, blockers: string): void {
  db.prepare(`
    INSERT INTO standups (date, yesterday, today, blockers, generated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(date, yesterday, today, blockers, Math.floor(Date.now() / 1000));
}

describe('backfillStandupItems', () => {
  it('splits legacy standups that predate standup_items', () => {
    insertLegacyStandup('2026-01-01', '- Did A\n- Did B', '- Do C', 'None');

    const report = backfillStandupItems(db);

    // "None" blockers is a placeholder, not an item — see PLACEHOLDER_RE in logStandup.ts.
    expect(report).toEqual({ standupsProcessed: 1, itemsInserted: 3 });
    const items = db.prepare('SELECT section, text FROM standup_items ORDER BY section, position').all();
    expect(items).toEqual([
      { section: 'today', text: 'Do C' },
      { section: 'yesterday', text: 'Did A' },
      { section: 'yesterday', text: 'Did B' },
    ]);
  });

  it('is idempotent: running it twice does not duplicate items', () => {
    insertLegacyStandup('2026-01-02', '- Did A', '- Do B', 'None');

    backfillStandupItems(db);
    const secondRun = backfillStandupItems(db);

    expect(secondRun).toEqual({ standupsProcessed: 0, itemsInserted: 0 });
    const count = db.prepare('SELECT COUNT(*) as n FROM standup_items').get() as { n: number };
    expect(count.n).toBe(2);
  });

  it('skips standups that already have items (e.g. logged via logStandup after the migration)', () => {
    insertLegacyStandup('2026-01-03', '- Legacy item', 'None', 'None');
    // Simulate a standup already split (as logStandup would do going forward).
    const standup = db.prepare('SELECT id FROM standups WHERE date = ?').get('2026-01-03') as { id: number };
    db.prepare('INSERT INTO standup_items (standup_id, section, position, text) VALUES (?, ?, ?, ?)')
      .run(standup.id, 'yesterday', 0, 'Legacy item');

    const report = backfillStandupItems(db);

    expect(report).toEqual({ standupsProcessed: 0, itemsInserted: 0 });
  });
});
