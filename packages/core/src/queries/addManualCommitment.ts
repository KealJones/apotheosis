import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import type { Commitment } from '../commitments/types.js';

export interface AddManualCommitmentArgs {
  title: string;
  detail?: string;
  counterparty?: string;
  due_hint?: string;
  /** Unix seconds. Defaults to the wall clock. */
  now?: number;
}

/**
 * `todo_add`'s write path — for anything the automated detectors miss. This bypasses the
 * detector framework entirely (it's not a `Detector.detect()` candidate the runner upserts;
 * it writes straight to `commitments`), so unlike every other source there's no natural
 * upstream identity to build `source_ref` from.
 *
 * `source_ref` is a fresh UUID (`manual:<uuid>`) rather than a hash of title+timestamp: a
 * hash of user-typed text can collide (two manual entries with the same title in the same
 * second), and because `UNIQUE (source, source_ref)` is the whole idempotency mechanism, a
 * collision would silently upsert into an existing row instead of creating a second one. A
 * UUID can't collide in practice, so no "what if the title repeats" analysis is needed.
 *
 * `confidence` is fixed at 1.0: a manual entry is the user's own direct assertion, not a
 * detector's probabilistic read, so there's no signal to attenuate — it always lands in the
 * main ranked list, never the "maybe?" tray (see MAYBE_CONFIDENCE_THRESHOLD).
 */
export function addManualCommitment(args: AddManualCommitmentArgs): Commitment {
  const title = args.title?.trim();
  if (!title) throw new Error('title is required');

  const db = getDb();
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const sourceRef = `manual:${randomUUID()}`;

  db.prepare(`
    INSERT INTO commitments
      (detected_at, committed_at, source, source_ref, title, detail, counterparty, due_hint, confidence, last_activity_at)
    VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, 1.0, ?)
  `).run(
    now,
    now,
    sourceRef,
    title,
    args.detail?.trim() || null,
    args.counterparty?.trim() || null,
    args.due_hint?.trim() || null,
    now,
  );

  return db.prepare('SELECT * FROM commitments WHERE source_ref = ?').get(sourceRef) as Commitment;
}
