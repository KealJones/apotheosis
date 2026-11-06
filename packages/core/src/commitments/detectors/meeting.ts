import { createHash } from 'crypto';
import type { CommitmentCandidate, Detector, Resolution } from '../types.js';

interface ActionItem {
  text: string;
  owner: 'me' | 'them' | 'unknown';
}

interface MeetingRow {
  id: number;
  title: string | null;
  url: string | null;
  action_items: string | null;
  summary_generated_at: number | null;
}

/**
 * Detects action items from meeting summaries. Emits a commitment for each action
 * item owned by 'me'. Uses stable refs based on a hash of the item text to survive
 * re-summarization (which might reorder or slightly change item count).
 *
 * Note: last_activity_at is set to summary_generated_at, the time when the action
 * items were extracted (not the meeting end time), since that's when the commitment
 * became "real evidence".
 *
 * Reconciliation: defers to auto-expiry. Without a deterministic signal for "was this
 * actually done" (manual checklist, another detector, etc.), allowing the 30-day
 * auto-expiry is an acceptable backstop.
 */
export const meeting: Detector = {
  id: 'meeting',
  sources: ['meeting'],

  async detect(ctx) {
    const candidates: CommitmentCandidate[] = [];

    const rows = ctx.db.prepare(`
      SELECT id, title, url, action_items, summary_generated_at
      FROM meetings
      WHERE action_items IS NOT NULL
        AND summary_generated_at IS NOT NULL
    `).all() as MeetingRow[];

    for (const row of rows) {
      if (!row.action_items) continue; // Should not happen due to WHERE clause, but be safe

      let items: ActionItem[] = [];
      try {
        items = JSON.parse(row.action_items);
        if (!Array.isArray(items)) {
          console.warn(`Meeting ${row.id}: action_items is not an array, skipping`);
          continue;
        }
      } catch (e) {
        console.warn(`Meeting ${row.id}: failed to parse action_items JSON: ${e}`);
        continue;
      }

      for (const item of items) {
        if (item.owner !== 'me') continue;

        // Hash the item text to create a stable ref that survives re-summarization.
        // If the exact same action item is re-detected in a re-summarization, the hash
        // will match and the existing row will be updated; if the item text changes
        // slightly, a new hash = new ref = potential duplicate. This is a reasonable
        // tradeoff: identical re-detection is common, slight rephrasing is rare.
        const hash = createHash('sha256').update(item.text).digest('hex').slice(0, 16);
        const sourceRef = `meeting:${row.id}:${hash}`;

        candidates.push({
          source: 'meeting',
          source_ref: sourceRef,
          title: `${item.text.slice(0, 60)}${item.text.length > 60 ? '...' : ''}`,
          detail: `From: ${row.title || 'Untitled meeting'}${row.url ? ` (${row.url})` : ''}`,
          confidence: 0.9, // High confidence: came from AI-summarized meeting action items
          last_activity_at: row.summary_generated_at ?? undefined,
        });
      }
    }

    return candidates;
  },

  async reconcile(open, ctx) {
    // Defers to auto-expiry. A future detector (manual checklist, cross-reference with
    // completed tasks, etc.) might close these, but for now there's no deterministic
    // signal of actual completion.
    return [];
  },
};
