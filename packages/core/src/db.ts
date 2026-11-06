import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Thin facade over node:sqlite. Its `all()`/`get()` return `unknown` rather
 * than `node:sqlite`'s concrete `Record<string, SQLOutputValue>`, so the
 * `as RowType` casts the tools already use compile cleanly (casting from
 * `unknown` is allowed). `DatabaseSync` is structurally assignable to this.
 */
interface Statement {
  all(...params: SQLInputValue[]): unknown[];
  get(...params: SQLInputValue[]): unknown;
  run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
}

export function getDataDir(): string {
  if (process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'apotheosis');
}

/** Path to the sqlite file `getDb()` opens. Shared with `getReadOnlyDb()` (see readonlyDb.ts). */
export function getDbPath(): string {
  return path.join(getDataDir(), 'apotheosis.db');
}

let _db: Db | null = null;

/** @internal — Test-only: inject a pre-configured database instance. */
export function _setDbForTesting(db: Db): void {
  _db = db;
}

/**
 * Run `fn` inside a transaction. Mirrors better-sqlite3's `db.transaction()`
 * wrapper, which `node:sqlite` does not provide. Rolls back on throw.
 *
 * Uses BEGIN IMMEDIATE: a deferred BEGIN that reads then writes fails instantly with
 * SQLITE_BUSY_SNAPSHOT ("database is locked", busy_timeout ignored) whenever the capture
 * daemon commits an insert in between.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** @internal — Test-only: reset the singleton so getDb() creates a fresh one. */
export function _resetDb(): void {
  _db = null;
}

export function getDb(): Db {
  if (_db) return _db;

  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  const screenshotsDir = path.join(dataDir, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const db = new DatabaseSync(getDbPath());

  // Enable WAL mode for better concurrency
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Wait out brief writer locks from the capture daemon instead of failing DDL instantly
  db.exec('PRAGMA busy_timeout = 5000');

  runMigrations(db);

  _db = db;
  return _db;
}

/**
 * Cached per-criterion review scores (packages/core/src/review/score.ts). The
 * key already encodes config version, levels, range, model, and an evidence
 * fingerprint, so stale rows are simply never looked up again. Exported so the
 * scorer can ensure it on databases that were not opened through getDb().
 */
export function ensureReviewScoreCache(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_score_cache (
      cache_key TEXT PRIMARY KEY,
      criterion_id TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

function runMigrations(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY,
      taken_at INTEGER NOT NULL,
      app_bundle TEXT,
      app_name TEXT,
      window_title TEXT,
      url TEXT,
      screenshot_path TEXT NOT NULL,
      ocr_text TEXT,
      active_seconds INTEGER,
      is_evidence INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_samples_taken_at ON samples(taken_at);
    CREATE INDEX IF NOT EXISTS idx_samples_app ON samples(app_bundle);

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_links (
      project_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      external_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, kind, external_id)
    );

    CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY,
      body TEXT NOT NULL,
      source TEXT,
      created_at INTEGER NOT NULL,
      cluster_id INTEGER,
      promoted_to_project_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS standups (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      yesterday TEXT,
      today TEXT,
      blockers TEXT,
      generated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commitments (
      id INTEGER PRIMARY KEY,
      detected_at INTEGER NOT NULL,
      committed_at INTEGER,           -- when the promise was actually made
      source TEXT NOT NULL,           -- standup|slack_ask|slack_promise|slack_unanswered|
                                       -- github_review_requested|github_unaddressed|github_stale|
                                       -- github_ci_failing|meeting|idea|mention|git_local|manual
                                       -- (canonical list: CommitmentSource in commitments/types.ts)
      source_ref TEXT NOT NULL,       -- stable: PR url, slack dedupe_hash, 'standup:2026-09-18#2'
      title TEXT NOT NULL,            -- short, imperative
      detail TEXT,
      counterparty TEXT,              -- who it is owed to, when known
      due_hint TEXT,                  -- parsed "by Friday", null if none
      confidence REAL NOT NULL,       -- 0..1 from the detector
      status TEXT NOT NULL DEFAULT 'open',  -- open|snoozed|done|dismissed
      snoozed_until INTEGER,
      resolved_at INTEGER,
      resolved_by TEXT,               -- 'auto' | 'user'
      resolution_note TEXT,
      last_activity_at INTEGER,       -- latest evidence it is still live; drives auto-expiry
      UNIQUE (source, source_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status, detected_at);
  `);

  // Runner-owned memo behind DetectorContext.cache (LLM classifications, mostly). Detectors
  // only get a read-only DB, so this is the sanctioned way for them to persist work.
  db.exec(`
    CREATE TABLE IF NOT EXISTS detector_cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      touched_at INTEGER NOT NULL
    );
  `);

  // Migration: last_activity_at was added by the C1 detector framework. Before it, the
  // only timestamp was detected_at, which can't serve both "first seen" and "last seen".
  try {
    db.exec(`ALTER TABLE commitments ADD COLUMN last_activity_at INTEGER;`);
  } catch {
    // Column already exists — ignore
  }

  // Context events table for event-driven capture (app switches, AX events, file modifications)
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_events (
      id INTEGER PRIMARY KEY,
      taken_at INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      app_bundle TEXT,
      app_name TEXT,
      window_title TEXT,
      url TEXT,
      document_path TEXT,
      previous_app_bundle TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_context_events_taken_at ON context_events(taken_at);
    CREATE INDEX IF NOT EXISTS idx_context_events_type ON context_events(event_type);
    -- Serves getContextSwitchRate (analytics.ts), which filters event_type ='app_switch'
    -- AND a taken_at range together — over an ~800MB samples/events table a wide
    -- date range would otherwise force a scan of every event_type before the
    -- range narrows it.
    CREATE INDEX IF NOT EXISTS idx_context_events_type_taken_at ON context_events(event_type, taken_at);
  `);

  // Structured Slack messages extracted by the capture daemon's SlackExtractor
  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_messages (
      id INTEGER PRIMARY KEY,
      captured_at INTEGER NOT NULL,
      channel TEXT,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      date_bucket TEXT,
      time_label TEXT,
      permalink TEXT,
      dedupe_hash TEXT UNIQUE NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_slack_messages_captured_at ON slack_messages(captured_at);
    CREATE INDEX IF NOT EXISTS idx_slack_messages_channel ON slack_messages(channel);
  `);

  // Migrations: add columns introduced after the table first shipped
  for (const col of ['time_label TEXT', 'permalink TEXT', 'reactions TEXT', 'reply_count INTEGER']) {
    try {
      db.exec(`ALTER TABLE slack_messages ADD COLUMN ${col};`);
    } catch {
      // Column already exists — ignore
    }
  }

  // Usage tracking for MCP tool calls and skill invocations
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_usage (
      id INTEGER PRIMARY KEY,
      called_at INTEGER NOT NULL,
      kind TEXT NOT NULL,            -- 'tool' or 'skill'
      name TEXT NOT NULL,            -- tool name or skill name
      args_summary TEXT,             -- optional: compact summary of args (no sensitive data)
      duration_ms INTEGER            -- optional: how long the call took
    );
    CREATE INDEX IF NOT EXISTS idx_tool_usage_called_at ON tool_usage(called_at);
    CREATE INDEX IF NOT EXISTS idx_tool_usage_name ON tool_usage(name);
    -- Serves getAiLeverage's topTools/skillsInvoked (analytics.ts): filters
    -- kind + a called_at range together.
    CREATE INDEX IF NOT EXISTS idx_tool_usage_kind_called_at ON tool_usage(kind, called_at);
  `);

  // Migration: add vision_summary column for existing databases
  try {
    db.exec(`ALTER TABLE samples ADD COLUMN vision_summary TEXT;`);
  } catch {
    // Column already exists — ignore
  }

  // Migration: add accessibility context columns
  const axColumns = ['document_path', 'selected_text', 'focused_element', 'visible_windows'];
  for (const col of axColumns) {
    try {
      db.exec(`ALTER TABLE samples ADD COLUMN ${col} TEXT;`);
    } catch {
      // Column already exists — ignore
    }
  }

  // Meeting detection (capture daemon's MeetingDetector) and transcript segments.
  // Detection-only for now — audio_path/summary/participants are filled in by later tasks.
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      platform TEXT,
      external_id TEXT,
      title TEXT,
      url TEXT,
      calendar_event_id TEXT,
      audio_path TEXT,
      transcript_status TEXT NOT NULL DEFAULT 'pending',
      summary TEXT,
      summary_model TEXT,
      summary_generated_at INTEGER,
      action_items TEXT,
      participants TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meetings_started_at ON meetings(started_at);

    CREATE TABLE IF NOT EXISTS meeting_segments (
      id INTEGER PRIMARY KEY,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      started_ms INTEGER NOT NULL,
      ended_ms INTEGER NOT NULL,
      channel TEXT NOT NULL,
      speaker TEXT,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_segments_meeting ON meeting_segments(meeting_id, started_ms);

    -- FTS5 virtual table for full-text search across meeting transcripts
    CREATE VIRTUAL TABLE IF NOT EXISTS meeting_segments_fts USING fts5(
      text,
      content=meeting_segments,
      content_rowid=id
    );

    -- Triggers to keep FTS index in sync with meeting_segments
    CREATE TRIGGER IF NOT EXISTS meeting_segments_ai AFTER INSERT ON meeting_segments BEGIN
      INSERT INTO meeting_segments_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS meeting_segments_ad AFTER DELETE ON meeting_segments BEGIN
      INSERT INTO meeting_segments_fts(meeting_segments_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS meeting_segments_au AFTER UPDATE ON meeting_segments BEGIN
      INSERT INTO meeting_segments_fts(meeting_segments_fts, rowid, text) VALUES('delete', old.id, old.text);
      INSERT INTO meeting_segments_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);

  // Per-line items within a standup's yesterday/today/blockers sections (C3 standup
  // carryover detector). Populated by logStandup() going forward; backfillStandupItems()
  // fills in standups written before this table existed. commitment_id is reserved for a
  // future write step that links an item to the commitment it produced — detect()/reconcile()
  // only get a read-only DB (see ReadonlyDb in commitments/types.ts), so nothing in the
  // detector framework itself can populate it yet.
  db.exec(`
    CREATE TABLE IF NOT EXISTS standup_items (
      id INTEGER PRIMARY KEY,
      standup_id INTEGER NOT NULL REFERENCES standups(id) ON DELETE CASCADE,
      section TEXT NOT NULL,        -- 'yesterday' | 'today' | 'blockers'
      position INTEGER NOT NULL,    -- 0-based order within (standup_id, section)
      text TEXT NOT NULL,
      commitment_id INTEGER REFERENCES commitments(id)
    );
    CREATE INDEX IF NOT EXISTS idx_standup_items_standup ON standup_items(standup_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_standup_items_unique ON standup_items(standup_id, section, position);
  `);

  ensureReviewScoreCache(db);
}
