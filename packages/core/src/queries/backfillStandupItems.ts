import { getDb, transaction, type Db } from '../db.js';
import { splitStandupSection, STANDUP_SECTIONS } from './logStandup.js';

export interface BackfillStandupItemsReport {
  standupsProcessed: number;
  itemsInserted: number;
}

interface StandupRow {
  id: number;
  yesterday: string | null;
  today: string | null;
  blockers: string | null;
}

/**
 * One-time backfill: populates `standup_items` for standups written before that table
 * existed. Idempotent by construction — it only looks at standups with zero rows in
 * standup_items, so re-running it after logStandup() (or a prior backfill run) has
 * already populated a standup is a no-op for that row. Safe to run twice.
 *
 * Uses the same line-based heuristic as logStandup() (see splitStandupSection — chosen
 * after inspecting the real standup history directly). No LLM is wired up in this
 * codebase yet; Ollama support is planned separately (task A6). Once that lands, an
 * LLM-based splitter could replace this for messier historical entries that don't
 * follow the one-bullet-per-line convention, but line-based splitting matched the real
 * data closely enough in spot checks to not need one for this backfill.
 */
export function backfillStandupItems(db: Db = getDb()): BackfillStandupItemsReport {
  const pending = db.prepare(`
    SELECT s.id, s.yesterday, s.today, s.blockers
    FROM standups s
    WHERE NOT EXISTS (SELECT 1 FROM standup_items si WHERE si.standup_id = s.id)
  `).all() as StandupRow[];

  let itemsInserted = 0;
  transaction(db, () => {
    const insertItem = db.prepare(`
      INSERT INTO standup_items (standup_id, section, position, text)
      VALUES (?, ?, ?, ?)
    `);
    for (const standup of pending) {
      const sectionText: Record<(typeof STANDUP_SECTIONS)[number], string | null> = {
        yesterday: standup.yesterday,
        today: standup.today,
        blockers: standup.blockers,
      };
      for (const section of STANDUP_SECTIONS) {
        splitStandupSection(sectionText[section]).forEach((itemText, position) => {
          insertItem.run(standup.id, section, position, itemText);
          itemsInserted++;
        });
      }
    }
  });

  return { standupsProcessed: pending.length, itemsInserted };
}
