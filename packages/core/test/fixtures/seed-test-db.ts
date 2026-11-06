/**
 * Creates and seeds an in-memory SQLite database with a synthetic workday
 * for deterministic MCP tool testing.
 *
 * The synthetic day: 2026-05-18 (a Sunday — matches real data patterns)
 * Workday: ~13:00–18:00 local (UTC-5, so 18:00–23:00 UTC)
 */
import { DatabaseSync } from 'node:sqlite';

// ── Constants ──────────────────────────────────────────────────────────────
// All timestamps are Unix seconds (UTC)
// 2026-05-18T18:00:00Z = 2026-05-18 13:00 CDT (start of synthetic workday)
const DAY_START_UTC = Math.floor(new Date('2026-05-18T18:00:00Z').getTime() / 1000);
const SAMPLE_INTERVAL = 15; // seconds between samples

export const TEST_DAY = '2026-05-18';
export const TEST_STANDUP_DATE = '2026-05-19'; // standup_draft uses "today" to look at "yesterday"
export const DAY_START_ISO = '2026-05-18T18:00:00Z';
export const DAY_END_ISO = '2026-05-18T23:59:59Z';

// ── Analytics fixtures (B3) ─────────────────────────────────────────────────
// A few extra days spread across two ISO weeks, plus tool_usage and meetings
// rows — none of which the original single-day fixture above had any of.
// Kept well clear of the dates other suites touch (2026-05-19 in
// usage.test.ts/summarize.test.ts are just string literals there, not rows —
// see comments at each insertion site below).
export const ANALYTICS_RANGE_START_ISO = '2026-05-16T00:00:00Z';
export const ANALYTICS_RANGE_END_ISO = '2026-06-08T23:59:59Z';
export const WEEKEND_DAY_ISO = '2026-05-16T20:00:00Z'; // Saturday
export const WEEKDAY_DAY_ISO = '2026-06-02T09:00:00Z'; // Monday, 2 weeks after DAY_START
export const MEETING_WEEK1_ISO = '2026-05-18T14:00:00Z'; // same week as the main fixture day
export const MEETING_WEEK2_START_ISO = '2026-06-02T10:00:00Z';
export const MEETING_WEEK2_MID_ISO = '2026-06-03T15:00:00Z';

// ── Schema (mirrors db.ts runMigrations) ───────────────────────────────────
function runSchema(db: DatabaseSync): void {
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
      is_evidence INTEGER DEFAULT 0,
      vision_summary TEXT,
      document_path TEXT,
      selected_text TEXT,
      focused_element TEXT,
      visible_windows TEXT
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
      committed_at INTEGER,
      source TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      counterparty TEXT,
      due_hint TEXT,
      confidence REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      snoozed_until INTEGER,
      resolved_at INTEGER,
      resolved_by TEXT,
      resolution_note TEXT,
      last_activity_at INTEGER,
      UNIQUE (source, source_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status, detected_at);

    CREATE TABLE IF NOT EXISTS detector_cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      touched_at INTEGER NOT NULL
    );

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
    CREATE INDEX IF NOT EXISTS idx_context_events_type_taken_at ON context_events(event_type, taken_at);

    CREATE TABLE IF NOT EXISTS tool_usage (
      id INTEGER PRIMARY KEY,
      called_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      args_summary TEXT,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tool_usage_called_at ON tool_usage(called_at);
    CREATE INDEX IF NOT EXISTS idx_tool_usage_name ON tool_usage(name);
    CREATE INDEX IF NOT EXISTS idx_tool_usage_kind_called_at ON tool_usage(kind, called_at);

    CREATE TABLE IF NOT EXISTS slack_messages (
      id INTEGER PRIMARY KEY,
      captured_at INTEGER NOT NULL,
      channel TEXT,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      date_bucket TEXT,
      time_label TEXT,
      permalink TEXT,
      reactions TEXT,
      reply_count INTEGER,
      dedupe_hash TEXT UNIQUE NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_slack_messages_captured_at ON slack_messages(captured_at);
    CREATE INDEX IF NOT EXISTS idx_slack_messages_channel ON slack_messages(channel);

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

    CREATE TABLE IF NOT EXISTS standup_items (
      id INTEGER PRIMARY KEY,
      standup_id INTEGER NOT NULL REFERENCES standups(id) ON DELETE CASCADE,
      section TEXT NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      commitment_id INTEGER REFERENCES commitments(id)
    );
    CREATE INDEX IF NOT EXISTS idx_standup_items_standup ON standup_items(standup_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_standup_items_unique ON standup_items(standup_id, section, position);
  `);
}

// ── Sample generators ──────────────────────────────────────────────────────

interface SampleDef {
  app_bundle: string;
  app_name: string;
  window_title: string;
  url?: string;
  ocr_text: string;
  document_path?: string;
  selected_text?: string;
  focused_element?: string;
  is_evidence?: number;
}

function insertSamples(
  db: DatabaseSync,
  startOffset: number,   // seconds from DAY_START_UTC
  count: number,
  def: SampleDef,
): void {
  const stmt = db.prepare(`
    INSERT INTO samples (taken_at, app_bundle, app_name, window_title, url,
      screenshot_path, ocr_text, active_seconds, is_evidence, vision_summary,
      document_path, selected_text, focused_element, visible_windows)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, NULL)
  `);
  for (let i = 0; i < count; i++) {
    const takenAt = DAY_START_UTC + startOffset + i * SAMPLE_INTERVAL;
    stmt.run(
      takenAt,
      def.app_bundle,
      def.app_name,
      def.window_title,
      def.url ?? null,
      `/tmp/test-screenshots/${takenAt}.jpg`,
      def.ocr_text,
      def.is_evidence ?? 0,
      def.document_path ?? null,
      def.selected_text ?? null,
      def.focused_element ?? null,
    );
  }
}

function insertEvent(
  db: DatabaseSync,
  offsetSec: number,
  type: string,
  bundle: string,
  appName: string,
  windowTitle: string,
  extra?: { url?: string; documentPath?: string; previousBundle?: string; detail?: string },
): void {
  db.prepare(`
    INSERT INTO context_events (taken_at, event_type, app_bundle, app_name, window_title,
      url, document_path, previous_app_bundle, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    DAY_START_UTC + offsetSec,
    type,
    bundle,
    appName,
    windowTitle,
    extra?.url ?? null,
    extra?.documentPath ?? null,
    extra?.previousBundle ?? null,
    extra?.detail ?? null,
  );
}

// ── Seed data ──────────────────────────────────────────────────────────────

export function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  runSchema(db);
  seedSamples(db);
  seedContextEvents(db);
  seedOtherTables(db);
  seedAnalyticsFixtures(db);
  return db;
}

function seedSamples(db: DatabaseSync): void {
  // ── Session 1: JIRA board + PR review (Chrome, ~5 min at T+0) ───────────
  insertSamples(db, 0, 20, {
    app_bundle: 'com.google.Chrome',
    app_name: 'Google Chrome',
    window_title: '[WID-4582] Investigate unit testing strategies for Code Connect output - JIRA - Google Chrome',
    url: 'https://acme.atlassian.net/browse/WID-4582',
    ocr_text: 'WID-4582 Investigate unit testing strategies for Code Connect output\nAssignee: Test User\nStatus: In Progress\nPriority: Medium\nSprint: FED Sprint 42\nDescription: We need to establish a testing strategy for validating Code Connect output files.',
    document_path: 'https://acme.atlassian.net/browse/WID-4582',
  });

  // ── Session 2: PR #2350 on GitHub (Chrome, ~3 min at T+6min) ────────────
  insertSamples(db, 360, 12, {
    app_bundle: 'com.google.Chrome',
    app_name: 'Google Chrome',
    window_title: 'WID-4582: code connect unit test by testuser · Pull Request #2350 · acme/widgets - Google Chrome',
    url: 'https://github.com/acme/widgets/pull/2350',
    ocr_text: 'WID-4582: code connect unit test #2350\ntestuser wants to merge 3 commits into master\nFiles changed (12)\nChecks: CI running\nhttps://github.com/acme/widgets/pull/2350',
  });

  // ── Session 3: Figma Code Connect research (Chrome, ~4 min at T+12min) ──
  insertSamples(db, 720, 16, {
    app_bundle: 'com.google.Chrome',
    app_name: 'Google Chrome',
    window_title: 'code-connect/cli/src/react/parser.ts at 9c3c523 · figma/code-connect - Google Chrome',
    url: 'https://github.com/figma/code-connect/blob/main/cli/src/react/parser.ts',
    ocr_text: 'export function parseCodeConnect(sourceFile: ts.SourceFile) {\n  const components: CodeConnectConfig[] = [];\n  // Walk AST looking for figma.connect() calls\n  ts.forEachChild(sourceFile, node => {\n    if (ts.isCallExpression(node)) {',
  });

  // ── Session 4: VS Code editing figmaTestUtils.ts (~8 min at T+20min) ────
  insertSamples(db, 1200, 32, {
    app_bundle: 'com.microsoft.VSCode',
    app_name: 'Code',
    window_title: 'figmaTestUtils.ts — widgets',
    document_path: '/Users/testuser/projects/widgets/packages/ui/test/utils/figmaTestUtils.ts',
    selected_text: 'export function createMockFigmaConnect',
    focused_element: 'text area: Code Editor',
    ocr_text: 'import { describe, it, expect } from "vitest";\nimport { WID-4582 } from "./constants";\nexport function createMockFigmaConnect(overrides: Partial<FigmaConnectConfig>) {\n  return { componentKey: "test-key", ...overrides };\n}\n// Utility for testing Code Connect template output',
  });

  // ── Session 5: VS Code editing Button.figma.ts (~6 min at T+32min) ──────
  insertSamples(db, 1920, 24, {
    app_bundle: 'com.microsoft.VSCode',
    app_name: 'Code',
    window_title: 'Button.figma.ts — widgets',
    document_path: '/Users/testuser/projects/widgets/packages/ui/src/components/Button/Button.figma.ts',
    ocr_text: 'figma.connect(Button, "https://figma.com/file/abc123", {\n  props: {\n    variant: figma.enum("Variant", { Primary: "primary", Secondary: "secondary" }),\n    disabled: figma.boolean("Disabled"),\n  },\n  example: (props) => <Button variant={props.variant} disabled={props.disabled} />,\n});',
  });

  // ── Session 6: VS Code editing ADR (~10 min at T+42min) ─────────────────
  insertSamples(db, 2520, 40, {
    app_bundle: 'com.microsoft.VSCode',
    app_name: 'Code',
    window_title: '0011-figma-code-connect-unit-testing.md — widgets',
    document_path: '/Users/testuser/projects/widgets/doc/architecture/decisions/0011-figma-code-connect-unit-testing.md',
    ocr_text: '# ADR 0011: Figma Code Connect Unit Testing\n\n## Status\nProposed\n\n## Context\nWe need to validate that our Code Connect configuration files produce correct template output.\nCurrently there is no automated testing for Code Connect files.\n\n## Decision\nWe will use vitest with a custom figma stub to unit test Code Connect configurations.',
  });

  // ── Session 7: Slack DM with Morgan Lee (~3 min at T+58min) ────────
  insertSamples(db, 3480, 12, {
    app_bundle: 'com.tinyspeck.slackmacgap',
    app_name: 'Slack',
    window_title: 'Morgan Lee (He/Him) (DM) - Acme Corp - Slack',
    ocr_text: 'Morgan Lee: Hey @testuser, can you take a look at the design system PRs when you get a chance?\nTest User: Sure, I\'ll check them out after I finish the Code Connect testing work\nMorgan Lee: Thanks! The colors page one is the most important\n@testuser mentioned in #frontend',
  });

  // ── Session 8: Glancing at design-docs PR (~1 min at T+62min) ─────
  insertSamples(db, 3720, 4, {
    app_bundle: 'com.google.Chrome',
    app_name: 'Google Chrome',
    window_title: 'WID-4618 Update token copy button, MoreVert icon, and add Code tab to colors page by morganlee · Pull Request #2035 · acme/design-docs - Google Chrome',
    url: 'https://github.com/acme/design-docs/pull/2035',
    ocr_text: 'WID-4618 Update token copy button\nmorganlee wants to merge 5 commits\nFiles changed (8)\nApproved by jordankim-wk',
  });

  // ── Session 9: Personal browsing (should be filtered by skills) ─────────
  insertSamples(db, 3900, 6, {
    app_bundle: 'com.google.Chrome',
    app_name: 'Google Chrome',
    window_title: 'weekend hiking trails - Google Search - Google Chrome',
    url: 'https://google.com/search?q=weekend+hiking+trails',
    ocr_text: 'weekend hiking trails 2026\nSummer camp registration open\nAges 6-12\nDates: June 15-19\nCost: $200',
  });

  // ── Session 10: Finder/new tab blips (low signal) ──────────────────────
  insertSamples(db, 4080, 3, {
    app_bundle: 'com.apple.finder',
    app_name: 'Finder',
    window_title: 'Downloads',
    ocr_text: 'Name  Date Modified  Size  Kind\nscreenshot-2026.png  Today  1.2 MB  PNG',
  });

  insertSamples(db, 4125, 2, {
    app_bundle: 'com.google.Chrome',
    app_name: 'Google Chrome',
    window_title: 'Panda New Tab - Google Chrome',
    ocr_text: 'Good afternoon! The weather is sunny.',
  });

  // ── Session 11: VS Code CI debugging (~5 min at T+72min) ───────────────
  insertSamples(db, 4320, 20, {
    app_bundle: 'com.microsoft.VSCode',
    app_name: 'Code',
    window_title: 'figma_code_connect.yaml — widgets',
    document_path: '/Users/testuser/projects/widgets/.github/workflows/figma_code_connect.yaml',
    ocr_text: 'name: Figma Code Connect CI\non:\n  pull_request:\n    paths:\n      - "packages/ui/src/**/*.figma.ts"\njobs:\n  validate:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pnpm install\n      - run: pnpm vitest run --project figma',
  });

  // ── Session 12: Evidence-tagged sample (should be excluded from triage) ──
  insertSamples(db, 4620, 2, {
    app_bundle: 'com.microsoft.VSCode',
    app_name: 'Code',
    window_title: 'Button.figma.test.ts — widgets',
    document_path: '/Users/testuser/projects/widgets/packages/ui/src/components/Button/Button.figma.test.ts',
    ocr_text: 'describe("Button.figma", () => {\n  it("produces correct template for primary variant", () => {\n    const result = renderFigmaConnect(ButtonFigma);\n    expect(result).toContain("<Button variant=\\"primary\\"");\n  });\n});',
    is_evidence: 1,
  });
}

function seedContextEvents(db: DatabaseSync): void {
  // App switches
  insertEvent(db, 0, 'app_switch', 'com.google.Chrome', 'Google Chrome',
    '[WID-4582] Investigate unit testing strategies', { previousBundle: 'com.apple.finder' });
  insertEvent(db, 1200, 'app_switch', 'com.microsoft.VSCode', 'Code',
    'figmaTestUtils.ts — widgets', { previousBundle: 'com.google.Chrome' });
  insertEvent(db, 1920, 'app_switch', 'com.microsoft.VSCode', 'Code',
    'Button.figma.ts — widgets', { previousBundle: 'com.microsoft.VSCode' });
  insertEvent(db, 2520, 'app_switch', 'com.microsoft.VSCode', 'Code',
    '0011-figma-code-connect-unit-testing.md — widgets', { previousBundle: 'com.microsoft.VSCode' });
  insertEvent(db, 3480, 'app_switch', 'com.tinyspeck.slackmacgap', 'Slack',
    'Morgan Lee (He/Him) (DM)', { previousBundle: 'com.microsoft.VSCode' });
  insertEvent(db, 3720, 'app_switch', 'com.google.Chrome', 'Google Chrome',
    'WID-4618 Update token copy button', { previousBundle: 'com.tinyspeck.slackmacgap' });

  // Window focus changes
  insertEvent(db, 360, 'window_focus', 'com.google.Chrome', 'Google Chrome',
    'WID-4582: code connect unit test by testuser · Pull Request #2350');
  insertEvent(db, 720, 'window_focus', 'com.google.Chrome', 'Google Chrome',
    'code-connect/cli/src/react/parser.ts');

  // Title changes
  insertEvent(db, 1500, 'title_change', 'com.microsoft.VSCode', 'Code',
    'figmaTestUtils.ts — widgets');
  insertEvent(db, 2000, 'title_change', 'com.microsoft.VSCode', 'Code',
    'Button.figma.ts — widgets');

  // File modifications
  insertEvent(db, 1300, 'file_modified', 'com.microsoft.VSCode', 'Code',
    'figmaTestUtils.ts — widgets', {
      documentPath: '/Users/testuser/projects/widgets/packages/ui/test/utils/figmaTestUtils.ts',
      detail: '{"content_type": "public.typescript", "size_bytes": 4200}',
    });
  insertEvent(db, 2100, 'file_modified', 'com.microsoft.VSCode', 'Code',
    'Button.figma.ts — widgets', {
      documentPath: '/Users/testuser/projects/widgets/packages/ui/src/components/Button/Button.figma.ts',
      detail: '{"content_type": "public.typescript", "size_bytes": 2800}',
    });
  insertEvent(db, 2700, 'file_modified', 'com.microsoft.VSCode', 'Code',
    '0011-figma-code-connect-unit-testing.md — widgets', {
      documentPath: '/Users/testuser/projects/widgets/doc/architecture/decisions/0011-figma-code-connect-unit-testing.md',
      detail: '{"content_type": "net.daringfireball.markdown", "size_bytes": 6100}',
    });
  insertEvent(db, 4400, 'file_modified', 'com.microsoft.VSCode', 'Code',
    'figma_code_connect.yaml — widgets', {
      documentPath: '/Users/testuser/projects/widgets/.github/workflows/figma_code_connect.yaml',
      detail: '{"content_type": "public.yaml", "size_bytes": 1500}',
    });
}

function seedOtherTables(db: DatabaseSync): void {
  // Meetings attended during the test day
  const meetingStart = DAY_START_UTC + 3600; // 1 hour into the day
  const meetingEnd = meetingStart + 1800; // 30 minutes long
  const meeting2Start = DAY_START_UTC + 14400; // 4 hours into the day
  const meeting2End = meeting2Start + 2400; // 40 minutes long

  const insertMeeting = db.prepare(`
    INSERT INTO meetings (started_at, ended_at, platform, title, transcript_status, summary, action_items, participants)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // First meeting (with summary and action items)
  const meeting1Summary = JSON.stringify({
    content: 'Discussed Q3 planning and resource allocation',
    decisions: [
      'Move sprint planning to Thursday mornings',
      'Increase test coverage target to 80%'
    ],
    action_items: [
      { task: 'Review Q3 roadmap PRs', assignee: 'Test User' },
      { task: 'Schedule resource planning meeting', assignee: null }
    ],
  });
  insertMeeting.run(
    meetingStart,
    meetingEnd,
    'zoom',
    'Q3 Planning & Roadmap',
    'completed',
    meeting1Summary,
    JSON.stringify([
      { task: 'Review Q3 roadmap PRs', assignee: 'Test User' },
      { task: 'Schedule resource planning meeting', assignee: null }
    ]),
    JSON.stringify(['Test User', 'Alice Smith', 'Bob Johnson'])
  );

  // Second meeting (no summary yet, pending)
  insertMeeting.run(
    meeting2Start,
    meeting2End,
    'teams',
    'Weekly Design Sync',
    'pending',
    null,
    null,
    JSON.stringify(['Test User', 'Design Team'])
  );

  // Add transcript segments for the first meeting
  const insertSegment = db.prepare(`
    INSERT INTO meeting_segments (meeting_id, started_ms, ended_ms, channel, speaker, text)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertSegment.run(1, 0, 15000, 'them', 'Alice Smith', 'Let\'s talk about Q3 planning. We need to align on the roadmap.');
  insertSegment.run(1, 15000, 30000, 'me', null, 'Sounds good. I\'ve been thinking about the sprint structure.');
  insertSegment.run(1, 30000, 45000, 'them', 'Bob Johnson', 'We should move to Thursday mornings to avoid the Monday chaos.');
  insertSegment.run(1, 45000, 60000, 'me', null, 'I agree. Also, we need better test coverage for the new features.');
  insertSegment.run(1, 60000, 75000, 'them', 'Alice Smith', 'Right, let\'s target 80% coverage across the board.');
  insertSegment.run(1, 75000, 90000, 'me', null, 'I can review the roadmap PRs and report back by Friday.');

  // Add transcript segments for the second meeting
  insertSegment.run(2, 0, 20000, 'them', 'Designer', 'Here\'s the latest design direction for the dashboard.');
  insertSegment.run(2, 20000, 40000, 'me', null, 'This looks great. The color palette really pops.');
  insertSegment.run(2, 40000, 60000, 'them', 'Designer', 'Thanks! We focused on accessibility this time.');

  // An idea from 12 hours ago
  db.prepare(`
    INSERT INTO ideas (body, source, created_at)
    VALUES (?, ?, ?)
  `).run(
    'Add compact mode to MCP tools to reduce response sizes for skills',
    'standup debugging session',
    DAY_START_UTC - 12 * 3600,
  );

  // An open commitment (unresolved, unacknowledged)
  db.prepare(`
    INSERT INTO commitments (detected_at, source, source_ref, title, detail, confidence, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    DAY_START_UTC + 3500,
    'mention',
    'slack://Morgan Lee DM',
    'Review Morgan\'s design-docs PR',
    'Morgan asked for PR review on design-docs',
    0.9,
    'open',
  );

  // A standup from the prior day
  db.prepare(`
    INSERT INTO standups (date, yesterday, today, blockers, generated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    '2026-05-18',
    '- Continued work on WID-4582 Code Connect testing infrastructure',
    '- Finish figmaTestUtils and write first Button.figma.test.ts',
    'None',
    DAY_START_UTC - 86400,
  );

  // A project
  db.prepare(`
    INSERT INTO projects (slug, name, description, status, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'wid-4582',
    'WID-4582: Figma Code Connect Unit Testing',
    'Investigate and implement unit testing strategies for Code Connect output.',
    'active',
    DAY_START_UTC - 7 * 86400,
  );

  // Structured Slack messages (as extracted by the capture daemon's SlackExtractor)
  const insertSlack = db.prepare(`
    INSERT INTO slack_messages (captured_at, channel, sender, text, date_bucket, time_label, permalink, dedupe_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertSlack.run(
    DAY_START_UTC + 600,
    'design-system-help',
    'Sam Patel',
    '@supportsquad I am creating components that I want consumers to override the colors for. How should I type the API?',
    'Today',
    '1:10 PM',
    'https://acme.slack.com/archives/C04TEST1/p1000000001',
    'hash-slack-1',
  );
  insertSlack.run(
    DAY_START_UTC + 700,
    'design-system-help',
    'Test User',
    'You can use the TokenName type from getToken directly, it is exported now.',
    'Today',
    '1:11 PM',
    'https://acme.slack.com/archives/C04TEST1/p1000000002',
    'hash-slack-2',
  );
  insertSlack.run(
    DAY_START_UTC + 4000,
    'Morgan Lee (He/Him) (DM)',
    'Morgan Lee',
    'Hey, could you take a look at my design-docs PR when you get a chance?',
    'Today',
    '2:06 PM',
    'https://acme.slack.com/archives/D04TEST2/p1000000003',
    'hash-slack-3',
  );
  insertSlack.run(
    DAY_START_UTC - 86400,
    'frontend',
    'Jordan Kim',
    'Reminder: roadmap review moved to Thursday this week.',
    'Yesterday',
    null,
    null,
    'hash-slack-4',
  );
}

// ── Analytics fixtures (B3): extra days, tool_usage, meetings, 2nd project ──
// Added for packages/core/src/queries/analytics.ts, which needs data across
// more than one day/week to exercise weekday/weekend, per-day, and per-week
// grouping. Kept on dates the rest of the suite doesn't touch.
function seedAnalyticsFixtures(db: DatabaseSync): void {
  const weekendOffset = Math.floor(new Date(WEEKEND_DAY_ISO).getTime() / 1000) - DAY_START_UTC;
  const weekdayOffset = Math.floor(new Date(WEEKDAY_DAY_ISO).getTime() / 1000) - DAY_START_UTC;

  // ── Saturday 2026-05-16: weekend browsing session (no project, no coding) ──
  insertSamples(db, weekendOffset, 12, {
    app_bundle: 'com.google.Chrome',
    app_name: 'Google Chrome',
    window_title: 'Weekend reading list - Google Chrome',
    url: 'https://example.com/reading-list',
    ocr_text: 'Some weekend reading, nothing project-related.',
  });

  // ── Monday 2026-06-02: weekday mix (coding + Slack + unrelated browsing) ──
  // Session A: coding on the apotheosis web app (~5 min)
  insertSamples(db, weekdayOffset, 20, {
    app_bundle: 'com.microsoft.VSCode',
    app_name: 'Code',
    window_title: 'page.tsx — apotheosis',
    document_path: '/Users/testuser/projects/apotheosis/apps/web/app/page.tsx',
    ocr_text: 'export default function TodayPage() { /* apotheosis dashboard */ }',
  });
  // Session B: Slack channel chatter (~2.5 min)
  insertSamples(db, weekdayOffset + 600, 10, {
    app_bundle: 'com.tinyspeck.slackmacgap',
    app_name: 'Slack',
    window_title: '#general (Channel) - Acme Corp - Slack',
    ocr_text: 'Standup thread for today.',
  });
  // Session C: unrelated browsing — no project match, not coding, not Slack (~2 min)
  insertSamples(db, weekdayOffset + 1200, 8, {
    app_bundle: 'com.google.Chrome',
    app_name: 'Google Chrome',
    window_title: 'Random article - Google Chrome',
    url: 'https://example.com/article',
    ocr_text: 'An article with no project keywords.',
  });

  // context_events: app switches across two different hour buckets on 06-02
  insertEvent(db, weekdayOffset, 'app_switch', 'com.microsoft.VSCode', 'Code',
    'page.tsx — apotheosis', { previousBundle: 'com.apple.finder' });
  insertEvent(db, weekdayOffset + 600, 'app_switch', 'com.tinyspeck.slackmacgap', 'Slack',
    '#general (Channel)', { previousBundle: 'com.microsoft.VSCode' });
  insertEvent(db, weekdayOffset + 1200, 'app_switch', 'com.google.Chrome', 'Google Chrome',
    'Random article', { previousBundle: 'com.tinyspeck.slackmacgap' });
  insertEvent(db, weekdayOffset + 3600 + 300, 'app_switch', 'com.microsoft.VSCode', 'Code',
    'page.tsx — apotheosis', { previousBundle: 'com.google.Chrome' });

  // ── A second project, matched by name/slug against window_title/document_path ──
  db.prepare(`
    INSERT INTO projects (slug, name, description, status, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'apotheosis',
    'Apotheosis dashboard',
    'The analytics + capture dashboard itself.',
    'active',
    DAY_START_UTC * 1000 - 3 * 86400 * 1000,
  );

  // ── tool_usage: spread across the three fixture days for per-day/top-N tests ──
  const insertUsage = db.prepare(`
    INSERT INTO tool_usage (called_at, kind, name, args_summary, duration_ms)
    VALUES (?, ?, ?, ?, ?)
  `);
  const weekendEpoch = DAY_START_UTC + weekendOffset;
  const mainDayEpoch = DAY_START_UTC + 5000;
  const weekdayEpoch = DAY_START_UTC + weekdayOffset;
  insertUsage.run(weekendEpoch, 'tool', 'mcp__apotheosis__recent_activity', 'since:"2026-05-16"', 120);
  insertUsage.run(weekendEpoch + 60, 'tool', 'mcp__apotheosis__recent_activity', 'since:"2026-05-16"', 95);
  insertUsage.run(weekendEpoch + 120, 'skill', 'daily-standup', null, null);
  insertUsage.run(mainDayEpoch, 'tool', 'mcp__apotheosis__standup_draft', 'compact:true', 80);
  insertUsage.run(mainDayEpoch + 60, 'skill', 'daily-standup', null, null);
  insertUsage.run(weekdayEpoch, 'tool', 'mcp__apotheosis__recent_activity', 'since:"2026-06-02"', 110);
  insertUsage.run(weekdayEpoch + 60, 'tool', 'mcp__apotheosis__recent_activity', 'since:"2026-06-02"', 100);
  insertUsage.run(weekdayEpoch + 120, 'tool', 'mcp__apotheosis__recent_activity', 'since:"2026-06-02"', 90);
  insertUsage.run(weekdayEpoch + 180, 'tool', 'mcp__apotheosis__usage_stats', '{}', 60);
  insertUsage.run(weekdayEpoch + 240, 'skill', 'follow-ups', null, null);

  // ── meetings: one in the main fixture's week, two in a later week ──
  const insertMeeting = db.prepare(`
    INSERT INTO meetings (started_at, ended_at, platform, external_id, title, transcript_status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);
  const week1Start = Math.floor(new Date(MEETING_WEEK1_ISO).getTime() / 1000);
  insertMeeting.run(week1Start, week1Start + 3600, 'zoom', 'meeting-1', 'Sprint planning');

  const week2Start = Math.floor(new Date(MEETING_WEEK2_START_ISO).getTime() / 1000);
  insertMeeting.run(week2Start, week2Start + 1800, 'zoom', 'meeting-2', 'Standup');

  const week2Mid = Math.floor(new Date(MEETING_WEEK2_MID_ISO).getTime() / 1000);
  insertMeeting.run(week2Mid, week2Mid + 3600, 'meet', 'meeting-3', '1:1');
}

/**
 * Total fixture inventory:
 * - 193 samples across 12 sessions (various apps, durations, signals)
 * - 13 context_events (6 app_switch, 2 window_focus, 2 title_change, 4 file_modified — one is duplicate naming)
 * - 1 idea, 1 commitment, 1 standup, 1 project
 * - 4 slack_messages (2 support channel, 1 DM, 1 prior-day team channel)
 *
 * Key test assertions this enables:
 * - JIRA: WID-4582 should be extracted (appears in OCR and window titles)
 * - PR: widgets#2350 should be extracted (appears in window title and OCR URL)
 * - Mentions: "@testuser" appears in Slack session OCR
 * - Triage signals: work sessions = high, personal browsing = should be filtered, blips = low
 * - Evidence: 2 samples are pre-tagged (is_evidence=1), should be excluded from triage
 * - Personal: "weekend hiking trails" should NOT appear in standup output
 */
