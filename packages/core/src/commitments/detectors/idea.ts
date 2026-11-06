import type { CommitmentCandidate, Detector, Resolution } from '../types.js';

const DAYS_14 = 14 * 86_400; // 14 days in seconds

interface IdeaRow {
  id: number;
  body: string;
  created_at: number;
  promoted_to_project_id: number | null;
}

/**
 * Detects old unpromoted ideas. An idea is a candidate if:
 * - created_at > 14 days ago
 * - promoted_to_project_id IS NULL (not yet promoted to a project)
 *
 * This is explicitly a LOW-CONFIDENCE detector (0.3): these are "maybe?" ideas that
 * may never ship, were tried and abandoned, or are simply not a priority right now.
 * They belong in a separate "low-confidence" tray that downstream ranking can filter
 * on, not in the main commitment list.
 *
 * Reconciliation strategy: a real signal for "this idea is done" would be promotion
 * to a project. We check for that here and mark done if it happened. As a fallback,
 * auto-expiry after 30 days on the open list is acceptable (these are low-priority).
 */
export const idea: Detector = {
  id: 'idea',
  sources: ['idea'],

  async detect(ctx) {
    const candidates: CommitmentCandidate[] = [];

    const threshold = ctx.now - DAYS_14;
    const rows = ctx.db.prepare(`
      SELECT id, body, created_at, promoted_to_project_id
      FROM ideas
      WHERE created_at <= ?
        AND promoted_to_project_id IS NULL
    `).all(threshold) as IdeaRow[];

    for (const row of rows) {
      // Truncate long bodies for the title; use the full body as detail.
      const title = row.body.length > 80 ? row.body.slice(0, 77) + '...' : row.body;

      candidates.push({
        source: 'idea',
        source_ref: `idea:${row.id}`,
        title,
        detail: row.body,
        confidence: 0.3, // Low: these are potential ideas, not confirmed commitments
        last_activity_at: row.created_at, // Use creation time; no "last referenced" column
      });
    }

    return candidates;
  },

  async reconcile(open, ctx) {
    const resolutions: Resolution[] = [];

    for (const c of open) {
      const m = c.source_ref.match(/^idea:(\d+)$/);
      if (!m) continue;

      const [, idStr] = m;
      const ideaId = Number(idStr);

      // Check if this idea was promoted to a project
      const idea = ctx.db.prepare(`
        SELECT promoted_to_project_id
        FROM ideas
        WHERE id = ?
      `).get(ideaId) as { promoted_to_project_id: number | null } | undefined;

      if (!idea) {
        // Idea was deleted; mark as dismissed
        resolutions.push({ id: c.id, status: 'dismissed', note: 'Idea was deleted' });
        continue;
      }

      if (idea.promoted_to_project_id !== null) {
        // Idea was promoted to a project — resolve as done
        resolutions.push({
          id: c.id,
          status: 'done',
          note: `Promoted to project ${idea.promoted_to_project_id}`,
        });
      }
    }

    return resolutions;
  },
};
