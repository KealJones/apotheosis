import { getDb, transaction } from '../db.js';

export interface LogStandupArgs {
  date: string;
  yesterday: string;
  today?: string;
  blockers?: string;
  /**
   * Optional, parallel to `today`'s split items (see splitStandupSection): the i-th entry
   * is the commitment id (from `todo_list`) that produced the i-th "today" line, or
   * null/undefined if that line was written freehand rather than proposed from the ranked
   * list. This is how `standup_items.commitment_id` finally gets populated (C3 reserved the
   * column; nothing wrote it until now) — linking today's items to their commitment lets
   * tomorrow's standup-carryover reconcile() close them directly instead of re-deriving the
   * match through fuzzy text comparison. Existing callers that omit this get the prior
   * behavior exactly: every commitment_id stays null.
   */
  todayCommitmentIds?: (number | null | undefined)[];
}

export const STANDUP_SECTIONS = ['yesterday', 'today', 'blockers'] as const;
export type StandupSection = (typeof STANDUP_SECTIONS)[number];

/**
 * A line that means "nothing here" rather than describing an actual item — most commonly
 * a "None"/"N/A" blockers section. Inspecting the real standup history showed both the
 * bare form ("None.") and a "None" that goes on to add unrelated context in the same
 * breath ("None. (No PRs are currently awaiting my review...)", "None - #91 approved by
 * Jamie Fox this morning") — in every real example, that trailing context was an aside,
 * not a second item, so this matches on the leading word/phrase alone (word-boundary
 * anchored, so it doesn't also eat a real item like "Nonetheld" or "N/Ashish").
 */
const PLACEHOLDER_RE = /^(none|n\/?a|nothing|no blockers?|no update)\b/i;

/**
 * Splits a standup section's free text into individual items, one per line.
 *
 * Heuristic and why: inspecting the real standup history directly (`standups` table)
 * showed every multi-item section written as one markdown bullet ("- ...") per line,
 * and single-item sections (e.g. a bare "None." blocker) as one unbulleted sentence.
 * Bullets never wrap mid-sentence in that data, so splitting on newlines reproduces the
 * author's own item boundaries exactly, with no heuristic guessing about sentence
 * boundaries inside a line. Leading "-", "*", "•", or "1."/"1)" markers are stripped so
 * the item text is comparable regardless of bullet style.
 */
export function splitStandupSection(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
    .filter((line) => line.length > 0 && !PLACEHOLDER_RE.test(line));
}

/**
 * Replaces standup_items for one standup with a fresh split of its current section text.
 * `todayCommitmentIds[i]` (if given) links the i-th "today" item to the commitment it came
 * from; every other section's commitment_id is always null (nothing proposes "yesterday" or
 * "blockers" items from the ledger).
 */
function writeStandupItems(
  db: ReturnType<typeof getDb>,
  standupId: number,
  sections: Record<StandupSection, string | null | undefined>,
  todayCommitmentIds?: (number | null | undefined)[],
): void {
  db.prepare('DELETE FROM standup_items WHERE standup_id = ?').run(standupId);
  const insertItem = db.prepare(`
    INSERT INTO standup_items (standup_id, section, position, text, commitment_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const section of STANDUP_SECTIONS) {
    splitStandupSection(sections[section]).forEach((itemText, position) => {
      const commitmentId = section === 'today' ? (todayCommitmentIds?.[position] ?? null) : null;
      insertItem.run(standupId, section, position, itemText, commitmentId);
    });
  }
}

export function logStandup(args: LogStandupArgs): void {
  const db = getDb();

  transaction(db, () => {
    db.prepare(`
      INSERT INTO standups (date, yesterday, today, blockers, generated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        yesterday = excluded.yesterday,
        today = excluded.today,
        blockers = excluded.blockers,
        generated_at = excluded.generated_at
    `).run(
      args.date,
      args.yesterday,
      args.today ?? null,
      args.blockers ?? null,
      Math.floor(Date.now() / 1000),
    );

    const standup = db.prepare('SELECT id FROM standups WHERE date = ?').get(args.date) as { id: number };
    // Re-splitting on every write (rather than only on insert) keeps standup_items in sync
    // if a standup is ever re-logged for the same date with edited text. Trade-off: this
    // drops any previously-written commitment_id if the standup is re-logged without passing
    // todayCommitmentIds again — acceptable since a re-log means the text changed, and the
    // caller (the /standup skill) always has the ids on hand to pass again.
    writeStandupItems(
      db,
      standup.id,
      { yesterday: args.yesterday, today: args.today, blockers: args.blockers },
      args.todayCommitmentIds,
    );
  });
}
