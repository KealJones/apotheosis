import { getRankedCommitments, resolveCommitmentSource, TOP_CAP, type RankedCommitment } from './rankedCommitments.js';
import type { CommitmentSource } from '../commitments/types.js';

export interface TodoListArgs {
  /** Max items in the main ranked list. Defaults to TOP_CAP (7), matching the C6 "show at most 7" rule. */
  limit?: number;
  /** Include the low-confidence "maybe?" tray. Defaults to false. */
  include_maybe?: boolean;
  /** Filter to one CommitmentSource. Applied after ranking, so it never changes relative order. */
  source?: CommitmentSource;
  /** Unix seconds. Defaults to the wall clock. */
  now?: number;
}

export interface TodoItem {
  id: number;
  source: CommitmentSource;
  title: string;
  detail: string | null;
  counterparty: string | null;
  due_hint: string | null;
  confidence: number;
  score: number;
  status: string;
  detected_at: string;
  /** Convenience for prose ("open N days") — floor((now - detected_at) / 86400). */
  age_days: number;
  /** Best-effort link to the underlying source (PR, Slack permalink, meeting, etc.); see resolveCommitmentSource. */
  source_url: string | null;
}

export interface TodoListResult {
  todos: TodoItem[];
  maybe: TodoItem[];
  /** Count of open/snoozed commitments across every source, before the `limit` cap or `source` filter. */
  total_open: number;
}

function toItem(c: RankedCommitment, now: number): TodoItem {
  return {
    id: c.id,
    source: c.source,
    title: c.title,
    detail: c.detail,
    counterparty: c.counterparty,
    due_hint: c.due_hint,
    confidence: c.confidence,
    score: Math.round(c.score * 1000) / 1000,
    status: c.status,
    detected_at: new Date(c.detected_at * 1000).toISOString(),
    age_days: Math.floor((now - c.detected_at) / 86_400),
    source_url: resolveCommitmentSource(c),
  };
}

/**
 * `todo_list`'s data layer — a thin wrapper over `getRankedCommitments` (C6) adding the
 * `limit`/`include_maybe`/`source` args the MCP tool exposes. Ranks the *entire* open set
 * first (`all: true`) before filtering by `source`, so a source filter never drops items
 * that would've been ranked but pushed out by TOP_CAP before the filter got a chance to run.
 */
export function getTodoList(args: TodoListArgs = {}): TodoListResult {
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const full = getRankedCommitments({ now, all: true });

  const bySource = (list: RankedCommitment[]) => (args.source ? list.filter((c) => c.source === args.source) : list);

  const ranked = bySource(full.ranked);
  const maybe = args.include_maybe ? bySource(full.maybe) : [];
  const limit = args.limit ?? TOP_CAP;

  return {
    todos: ranked.slice(0, limit).map((c) => toItem(c, now)),
    maybe: maybe.map((c) => toItem(c, now)),
    total_open: full.total_open,
  };
}
