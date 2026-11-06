import { getDb, transaction, type Db } from '../db.js';
import { detectors as registeredDetectors } from './detectors/index.js';
import {
  COMMITMENT_SOURCES,
  type Commitment,
  type CommitmentCandidate,
  type CommitmentSource,
  type Detector,
  type DetectorCache,
  type DetectorContext,
  type ReadonlyDb,
  type Resolution,
} from './types.js';

const DAY = 86_400;
/** Open this long with no supporting activity and a commitment is auto-dismissed. */
export const EXPIRY_SECONDS = 30 * DAY;
/** Default `ctx.since` = now minus this. */
export const DEFAULT_LOOKBACK_SECONDS = 7 * DAY;
/** `detector_cache` entries not read or written in this long are pruned. */
export const CACHE_TTL_SECONDS = 60 * DAY;
/** User-entered items have no detector to refresh them, so they never time out. */
const EXPIRY_EXEMPT_SOURCES: readonly CommitmentSource[] = ['manual'];

export interface DetectorRunReport {
  id: string;
  /** Valid candidates returned by detect(). */
  detected: number;
  /** Of those, how many created a new row. */
  inserted: number;
  /** Resolutions applied. */
  resolved: number;
  /** detect/reconcile throws and rejected candidates/resolutions. Never fatal to the run. */
  errors: string[];
}

export interface RunReport {
  now: number;
  /** Snoozed commitments whose snoozed_until passed and went back to open. */
  woken: number;
  detectors: DetectorRunReport[];
  /** Commitments auto-dismissed by the 30-day expiry. */
  expired: number;
}

export interface RunOptions {
  /** Defaults to the registry. Tests inject their own. */
  detectors?: Detector[];
  /** Unix seconds. Defaults to the wall clock. */
  now?: number;
  lookbackSeconds?: number;
}

/**
 * The only code that writes detector output to `commitments`. Sequence:
 *   1. wake snoozed items whose time has come
 *   2. per detector, in registry order: detect -> upsert -> reconcile -> apply resolutions
 *   3. auto-expire stale open items
 * Status, resolved_*, and snoozed_until are never touched by the upsert.
 */
export async function runDetectors(opts: RunOptions = {}): Promise<RunReport> {
  const dets = opts.detectors ?? registeredDetectors;
  validateRegistry(dets);

  const db = getDb();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const ctx: DetectorContext = {
    now,
    since: now - (opts.lookbackSeconds ?? DEFAULT_LOOKBACK_SECONDS),
    db: readonlyView(db),
    cache: detectorCache(db, now),
  };

  const woken = wakeSnoozed(db, now);

  const reports: DetectorRunReport[] = [];
  const detectFailedSources: CommitmentSource[] = [];
  for (const det of dets) {
    const report: DetectorRunReport = { id: det.id, detected: 0, inserted: 0, resolved: 0, errors: [] };
    reports.push(report);

    let candidates: CommitmentCandidate[] = [];
    try {
      candidates = await det.detect(ctx);
    } catch (e) {
      report.errors.push(`detect: ${errorMessage(e)}`);
      detectFailedSources.push(...det.sources);
    }
    upsertCandidates(db, det, candidates, now, report);

    const open = loadOpen(db, det.sources);
    if (open.length === 0) continue;
    try {
      const resolutions = await det.reconcile(open, ctx);
      applyResolutions(db, open, resolutions, now, report);
    } catch (e) {
      report.errors.push(`reconcile: ${errorMessage(e)}`);
    }
  }

  const expired = expireStale(db, now, detectFailedSources);
  return { now, woken, detectors: reports, expired };
}

/** Throws on programmer error: duplicate ids, unknown sources, or a source owned twice. */
export function validateRegistry(dets: Detector[]): void {
  const ids = new Set<string>();
  const owner = new Map<CommitmentSource, string>();
  for (const det of dets) {
    if (ids.has(det.id)) throw new Error(`Duplicate detector id "${det.id}"`);
    ids.add(det.id);
    if (det.sources.length === 0) throw new Error(`Detector "${det.id}" owns no sources`);
    for (const src of det.sources) {
      if (!COMMITMENT_SOURCES.includes(src)) throw new Error(`Detector "${det.id}" claims unknown source "${src}"`);
      const prev = owner.get(src);
      if (prev) throw new Error(`Source "${src}" is owned by both "${prev}" and "${det.id}"`);
      owner.set(src, det.id);
    }
  }
}

function wakeSnoozed(db: Db, now: number): number {
  // The snooze end counts as activity, so an item woken after a long snooze isn't
  // expired in the same run.
  const res = db.prepare(`
    UPDATE commitments
    SET status = 'open',
        last_activity_at = MAX(COALESCE(last_activity_at, detected_at), snoozed_until),
        snoozed_until = NULL
    WHERE status = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ?
  `).run(now);
  return Number(res.changes);
}

function candidateError(det: Detector, c: CommitmentCandidate): string | null {
  if (!det.sources.includes(c.source)) return `source "${c.source}" not owned by this detector`;
  if (!c.source_ref) return 'empty source_ref';
  if (!c.title?.trim()) return 'empty title';
  if (!(c.confidence >= 0 && c.confidence <= 1)) return `confidence ${c.confidence} outside 0..1`;
  return null;
}

function upsertCandidates(db: Db, det: Detector, candidates: CommitmentCandidate[], now: number, report: DetectorRunReport): void {
  const exists = db.prepare('SELECT 1 FROM commitments WHERE source = ? AND source_ref = ?');
  // Detection fields only. Optional fields COALESCE so a sparser re-detection never erases
  // what an earlier run found. last_activity_at only moves forward.
  const upsert = db.prepare(`
    INSERT INTO commitments
      (detected_at, committed_at, source, source_ref, title, detail, counterparty, due_hint, confidence, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, source_ref) DO UPDATE SET
      title = excluded.title,
      confidence = excluded.confidence,
      committed_at = COALESCE(excluded.committed_at, committed_at),
      detail = COALESCE(excluded.detail, detail),
      counterparty = COALESCE(excluded.counterparty, counterparty),
      due_hint = COALESCE(excluded.due_hint, due_hint),
      last_activity_at = MAX(COALESCE(last_activity_at, detected_at), excluded.last_activity_at)
  `);

  transaction(db, () => {
    for (const c of candidates) {
      const err = candidateError(det, c);
      if (err) {
        report.errors.push(`candidate ${c.source}:${c.source_ref}: ${err}`);
        continue;
      }
      if (!exists.get(c.source, c.source_ref)) report.inserted++;
      upsert.run(
        now,
        c.committed_at ?? null,
        c.source,
        c.source_ref,
        c.title.trim(),
        c.detail ?? null,
        c.counterparty ?? null,
        c.due_hint ?? null,
        c.confidence,
        c.last_activity_at ?? now,
      );
      report.detected++;
    }
  });
}

function loadOpen(db: Db, sources: readonly CommitmentSource[]): Commitment[] {
  const placeholders = sources.map(() => '?').join(', ');
  return db.prepare(`
    SELECT * FROM commitments
    WHERE status IN ('open', 'snoozed') AND source IN (${placeholders})
    ORDER BY id
  `).all(...sources) as Commitment[];
}

function applyResolutions(
  db: Db,
  open: Commitment[],
  resolutions: Resolution[],
  now: number,
  report: DetectorRunReport,
): void {
  const allowed = new Set(open.map((c) => c.id));
  // The status guard re-checks at write time: a user may have resolved it while
  // reconcile() was awaiting the network.
  const apply = db.prepare(`
    UPDATE commitments
    SET status = ?, resolved_at = ?, resolved_by = 'auto', resolution_note = ?, snoozed_until = NULL
    WHERE id = ? AND status IN ('open', 'snoozed')
  `);
  transaction(db, () => {
    for (const r of resolutions) {
      if (!allowed.has(r.id)) {
        report.errors.push(`resolution #${r.id}: not one of the commitments passed to reconcile()`);
        continue;
      }
      if (r.status !== 'done' && r.status !== 'dismissed') {
        report.errors.push(`resolution #${r.id}: status must be done|dismissed, got "${r.status}"`);
        continue;
      }
      if (!r.note?.trim()) {
        report.errors.push(`resolution #${r.id}: note is required`);
        continue;
      }
      report.resolved += Number(apply.run(r.status, now, r.note.trim(), r.id).changes);
    }
  });
}

function expireStale(db: Db, now: number, skipSources: CommitmentSource[]): number {
  // Sources whose detect() failed this run are skipped: their activity couldn't be
  // refreshed, so "no activity" would be a lie.
  const skip = [...EXPIRY_EXEMPT_SOURCES, ...skipSources];
  const placeholders = skip.map(() => '?').join(', ');
  const res = db.prepare(`
    UPDATE commitments
    SET status = 'dismissed', resolved_at = ?, resolved_by = 'auto',
        resolution_note = 'Auto-expired: no supporting activity for 30 days (last activity '
          || date(COALESCE(last_activity_at, detected_at), 'unixepoch') || ')'
    WHERE status = 'open'
      AND COALESCE(last_activity_at, detected_at) < ?
      AND source NOT IN (${placeholders})
  `).run(now, now - EXPIRY_SECONDS, ...skip);
  return Number(res.changes);
}

/**
 * Backs `ctx.cache` with the `detector_cache` table. Prunes entries not touched within
 * CACHE_TTL_SECONDS first (anything that old is outside every detector's lookback anyway).
 * A hit refreshes `touched_at`, so entries a detector keeps reading stay alive.
 */
function detectorCache(db: Db, now: number): DetectorCache {
  db.prepare('DELETE FROM detector_cache WHERE touched_at < ?').run(now - CACHE_TTL_SECONDS);
  const read = db.prepare('SELECT value FROM detector_cache WHERE key = ?');
  const touch = db.prepare('UPDATE detector_cache SET touched_at = ? WHERE key = ?');
  const write = db.prepare(`
    INSERT INTO detector_cache (key, value, touched_at) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, touched_at = excluded.touched_at
  `);
  return {
    get(key) {
      const row = read.get(key) as { value: string } | undefined;
      if (row) touch.run(now, key);
      return row?.value;
    },
    set(key, value) {
      write.run(key, value, now);
    },
  };
}

/** Guard-rail, not a sandbox: rejects anything that isn't a SELECT/WITH and hides run(). */
function readonlyView(db: Db): ReadonlyDb {
  return {
    prepare(sql) {
      if (!/^\s*(SELECT|WITH)\b/i.test(sql)) {
        throw new Error(`Detectors get a read-only DB; refusing: ${sql.trim().slice(0, 60)}`);
      }
      const stmt = db.prepare(sql);
      return { all: (...p) => stmt.all(...p), get: (...p) => stmt.get(...p) };
    },
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
