import type { CommitmentCandidate, Detector, Resolution } from '../types.js';
import { isFuzzyMatch } from './textSimilarity.js';

const TITLE_MAX = 120;

interface ItemRow {
  standup_id: number;
  date: string;
  section: 'yesterday' | 'today' | 'blockers';
  position: number;
  text: string;
}

interface SourceRefParts {
  standupId: number;
  section: 'today' | 'blockers';
  position: number;
}

function parseSourceRef(ref: string): SourceRefParts | null {
  const m = ref.match(/^standup:(\d+)#(today|blockers)#(\d+)$/);
  if (!m) return null;
  return { standupId: Number(m[1]), section: m[2] as 'today' | 'blockers', position: Number(m[3]) };
}

function dateToUnix(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

function truncate(text: string): string {
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

/** All standup_items joined with their standup's date, oldest first. */
function loadAllItems(db: import('../types.js').ReadonlyDb): ItemRow[] {
  return db.prepare(`
    SELECT si.standup_id, s.date, si.section, si.position, si.text
    FROM standup_items si
    JOIN standups s ON s.id = si.standup_id
    ORDER BY s.date ASC, si.section, si.position
  `).all() as ItemRow[];
}

interface Chain {
  /** First occurrence — the stable identity this candidate's source_ref is built from. */
  origin: ItemRow;
  lastActivityDate: string;
  resolved: boolean;
}

/**
 * An item in standup N's "today" or "blockers" that never fuzzy-matches any later
 * standup's "yesterday" is an unfinished commitment to yourself. This is a state-style
 * detector — it needs the full standup_items history, not just ctx.since's lookback
 * window, to know whether a later standup ever confirmed the work — so it ignores
 * ctx.since (like git_local ignores it for its own reasons).
 */
export const standupCarryover: Detector = {
  id: 'standup_carryover',
  sources: ['standup'],

  async detect(ctx) {
    const items = loadAllItems(ctx.db);
    const byDate = new Map<string, ItemRow[]>();
    for (const item of items) {
      if (!byDate.has(item.date)) byDate.set(item.date, []);
      byDate.get(item.date)!.push(item);
    }
    const dates = [...byDate.keys()].sort();

    // One chain per distinct unfinished item. Re-listing the same unfinished thing in a
    // later standup's today/blockers (very common — you didn't finish it, so it's still
    // on the list) extends the existing chain's last-activity date instead of spawning a
    // second commitment for the same real-world task; source_ref is pinned to the first
    // occurrence so it stays a stable identity across the whole run.
    const openChains: Chain[] = [];
    for (const date of dates) {
      const dayItems = byDate.get(date)!;
      const yesterdayItems = dayItems.filter((i) => i.section === 'yesterday');
      const pendingItems = dayItems.filter((i) => i.section === 'today' || i.section === 'blockers');

      for (const chain of openChains) {
        if (!chain.resolved && yesterdayItems.some((y) => isFuzzyMatch(y.text, chain.origin.text))) {
          chain.resolved = true;
        }
      }

      for (const item of pendingItems) {
        const chain = openChains.find((c) => !c.resolved && isFuzzyMatch(c.origin.text, item.text));
        if (chain) {
          // Recurrence is real evidence it's still open (see CommitmentCandidate.last_activity_at docs) —
          // not just "detected again this run", since the recurrence itself is a fresh mention by the user.
          chain.lastActivityDate = date;
        } else {
          openChains.push({ origin: item, lastActivityDate: date, resolved: false });
        }
      }
    }

    return openChains
      .filter((c) => !c.resolved)
      .map((c): CommitmentCandidate => ({
        source: 'standup',
        source_ref: `standup:${c.origin.standup_id}#${c.origin.section}#${c.origin.position}`,
        title: truncate(c.origin.text),
        detail: `From standup on ${c.origin.date} (${c.origin.section}), never confirmed done in a later "yesterday"`,
        confidence: 0.55,
        last_activity_at: dateToUnix(c.lastActivityDate),
      }));
  },

  async reconcile(open, ctx) {
    const resolutions: Resolution[] = [];
    for (const c of open) {
      const parts = parseSourceRef(c.source_ref);
      if (!parts) continue;

      const origin = ctx.db.prepare(`
        SELECT si.text, s.date
        FROM standup_items si JOIN standups s ON s.id = si.standup_id
        WHERE si.standup_id = ? AND si.section = ? AND si.position = ?
      `).get(parts.standupId, parts.section, parts.position) as { text: string; date: string } | undefined;
      if (!origin) continue; // item row gone somehow — leave it open rather than guess

      const laterYesterday = ctx.db.prepare(`
        SELECT si.text
        FROM standup_items si JOIN standups s ON s.id = si.standup_id
        WHERE si.section = 'yesterday' AND s.date > ?
      `).all(origin.date) as { text: string }[];

      const match = laterYesterday.find((y) => isFuzzyMatch(y.text, origin.text));
      if (match) {
        resolutions.push({
          id: c.id,
          status: 'done',
          note: `Matched a later standup's "yesterday": "${truncate(match.text)}"`,
        });
      }
    }
    return resolutions;
  },
};

/** Exported for tests. */
export const __test = { dateToUnix };
