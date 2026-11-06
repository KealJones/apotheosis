# Apotheosis — AI Context

This file gives an AI assistant everything it needs to understand, navigate, and work on this codebase. Read this before making changes.

## What this project is

Apotheosis is a personal productivity system for an engineer with ADHD. It silently captures screen activity on a configurable schedule (default every 15 seconds on weekdays), extracts text via OCR, and makes that data available to Claude Code through an MCP server. The end goal is: daily standups written from real data, a timeline of what you did today, and a portfolio of your impact that you can reference in performance reviews, career conversations, or just to answer "what did I actually work on this quarter?"

It is a single-user, local-only macOS app. No servers, no accounts, no cloud storage.

## Project structure

```
apotheosis/
  apps/
    capture/                    # Swift macOS menu bar app
      Sources/Capture/
        App.swift               # Menu bar UI, app lifecycle
        CaptureLoop.swift       # Capture timer + shared skip gate (pause, schedule, idle)
        CaptureSchedule.swift   # capture.* config (interval, days, hours, idle) + user-config.json access
        ActiveContext.swift      # Gets frontmost app, window title, URL
        SkipPatterns.swift       # Config-driven skip list from JSON file
        IdleGate.swift          # Detects no mouse/keyboard input for N seconds
        OCR.swift               # Apple Vision OCR, screenshot deletion
        Redactor.swift          # Secret scrubbing for every stored text field
        Retention.swift         # Leftover screenshot sweep, optional capture.retention_days
        Store.swift             # SQLite read/write (samples, OCR)
      Package.swift             # Swift package manifest
      Capture.entitlements      # Screen Recording entitlement
      Info.plist                # App metadata

    mcp/                        # Node.js MCP server
      src/
        server.ts               # MCP server, registers every tools/ module in a loop
        db.ts                   # SQLite connection (better-sqlite3), WAL, migrations
        summarize.ts            # CORE: block grouping, session merging, metadata extraction
        integrations/
          github.ts             # gh CLI wrapper for pending PR reviews
        tools/
          standup_draft.ts      # Assembles yesterday's sessions, blocks, follow-ups, PRs, ideas
          summarize_window.ts   # Groups samples in a time range into work blocks
          recent_activity.ts    # Raw samples with all fields for a time range
          triage_samples.ts     # Scores clusters by evidence signal strength
          delete_samples.ts     # Deletes samples by ID (refuses evidence-tagged)
          log_idea.ts           # Save an idea to the inbox
          list_ideas.ts         # Retrieve ideas with optional search/date filter
          log_standup.ts        # Save a standup entry
          mentions.ts           # Search OCR text for @-mentions
          link_evidence.ts      # Tag samples as evidence for a project
          create_project.ts     # Create a portfolio project entry
          get_project.ts        # Retrieve project details + linked evidence
          code_time.ts          # Git log analysis for time-on-code metrics
          context_timeline.ts   # Chronological event timeline with context switching stats
          get_inbox.ts          # Consolidated inbox: mentions + pending PRs + follow-ups
          log_usage.ts            # Log skill invocations for usage tracking
          usage_stats.ts          # Query usage data (totals, per-tool breakdown, daily trends)
        usage.ts                  # Usage tracking middleware: tracked() wrapper, logUsage()
      package.json
      tsconfig.json

  .claude/
    settings.json               # Claude Code permissions, hooks, skill definitions
    settings.local.json         # Local overrides (gitignored)
    skills/
      standup/SKILL.md          # /standup — two-pass standup generation
      today/SKILL.md            # /today — activity timeline
      whats-next/SKILL.md       # /whats-next — next action recommendation
      follow-ups/SKILL.md       # /follow-ups — mentions & PR reviews
      log-idea/SKILL.md         # /log-idea — quick idea capture
      cleanup-samples/SKILL.md      # /cleanup-samples — triage & delete
      capture/SKILL.md          # /capture — daemon control

  .mcp.json                     # MCP server registration for Claude Code
  CLAUDE.md                     # Rules for AI behavior in this project
```

## Data model

Everything lives in `~/Library/Application Support/apotheosis/apotheosis.db` (SQLite, WAL mode).

### samples table (the core)
```sql
id INTEGER PRIMARY KEY,
taken_at INTEGER NOT NULL,        -- Unix timestamp
app_bundle TEXT,                   -- e.g. "com.microsoft.VSCode"
app_name TEXT,                     -- e.g. "Visual Studio Code"
window_title TEXT,                 -- e.g. "summarize.ts — apotheosis"
url TEXT,                          -- Browser URL (Safari/Chrome only)
screenshot_path TEXT NOT NULL,     -- Path to JPEG (deleted after OCR)
ocr_text TEXT,                     -- Extracted text (secrets redacted)
vision_summary TEXT,               -- UNUSED (Ollama removed, column preserved)
active_seconds INTEGER,            -- UNUSED (never populated by daemon)
is_evidence INTEGER DEFAULT 0,     -- 1 = protected from deletion
document_path TEXT,                -- AX: file path from document-based apps
selected_text TEXT,                -- AX: currently highlighted/selected text
focused_element TEXT,              -- AX: role + description of focused UI element
visible_windows TEXT               -- UNUSED (written by daemon, not read by tools)
```

### Other tables
- **projects**: `slug`, `name`, `description`, `status` — portfolio project entries
- **project_links**: many-to-many between projects and external IDs
- **ideas**: `body`, `source`, `created_at`, optional `cluster_id` and `promoted_to_project_id`
- **standups**: `date` (unique), `yesterday`, `today`, `blockers`, `generated_at`
- **commitments**: `source`, `source_ref` (unique together), `title`, `detail`, `detected_at`, `confidence`, `status` ('open'|'snoozed'|'done'|'dismissed'), `resolved_at`, `resolved_by`
- **tool_usage**: `called_at`, `kind` ('tool'|'skill'), `name`, `args_summary`, `duration_ms` — automatic tracking of all MCP tool calls and skill invocations

## Key data processing (summarize.ts)

This is the most important file for understanding how raw data becomes useful.

### Three levels of aggregation

1. **Samples** — One per 15-second capture tick. ~5,760 per full workday.
2. **WorkBlocks** — `groupIntoBlocks(samples, options?)` groups consecutive samples by exact `app_bundle` + `window_title` with a max 10-minute gap. Produces ~200-300 blocks/day. Each block has `top_words` (frequency analysis of OCR text), `ocr_excerpt` (first 300 chars), `metadata` (JIRA/PR extraction). Accepts `BlockOptions { compact?, min_duration_min? }` — compact mode omits `ocr_excerpt`, `selected_texts`, `focused_elements`.
3. **Sessions** — `groupIntoSessions(blocks, gapMinutes?)` merges blocks from the same `app_bundle` within a configurable gap (default 5 minutes, ignoring window title). Produces ~20-30 sessions/day. Each session has `window_titles[]` (distinct), `urls[]`, `metadata` (JIRA tickets, PR URLs, file paths extracted via regex).

### Shared regex patterns (also in summarize.ts)
```typescript
JIRA_PATTERN = /[A-Z]+-\d+/           // Jira ticket IDs
PR_URL_PATTERN = /github.com/.../pull/\d+/  // GitHub PR URLs
REPO_PATH_PATTERN = /\/(home|Users|...)\//  // Local file paths
```

These are exported for use by `triage_samples.ts` and `extractMetadata()`.

## Capture pipeline details

### What gets captured
- Screenshot of the focused window only (falls back to full primary display if no window found) — deleted after OCR
- App bundle ID and name (from `NSWorkspace`)
- Window title (from Accessibility API / `AXUIElement`)
- Browser URL (AppleScript for Safari and Chrome only)
- OCR text (Apple Vision framework, with secret redaction)

### What gets skipped
Configured in `~/Library/Application Support/apotheosis/skip-patterns.json`:
- **Bundle blocklist**: 1Password, loginwindow, FaceTime, ScreenSaverEngine
- **Bundle keywords**: "bank", "password"
- **Window title patterns**: ".env", "credentials", ".pem", ".key", "id_rsa", "id_ed25519"

Also skipped:
- Outside the `capture.*` schedule (days/hours), or idle longer than `capture.idle_after_seconds` (default 300)
- No frontmost app / null bundle ID

File-change events also drop paths matching the window title patterns.

### Secret redaction (Redactor.swift)
`Store` runs every captured text field through `Redactor` on write, so no caller can skip it.
- `Redactor.field` (window titles, URLs, meeting titles, focused element, event detail): known token formats only: AWS keys, Bearer, GitHub (`ghp_`, `github_pat_`, ...), Slack (`xox*-`), npm, `sk-` keys, JWTs, PEM private keys, and credential URL params (`token`, `code`, `api_key`, `sig`, ...).
- `Redactor.freeText` (OCR, selected text, Slack messages, transcripts): the above plus long hex (32+), mixed-case base64 (40+, no `/` so paths survive) and long `KEY=value` lines.

### Retention (Retention.swift)
Runs a minute after launch and every 6 hours. Always sweeps screenshot files older than a day (OCR deletes them normally; leftovers mean OCR never ran), keeping evidence-tagged ones. With `capture.retention_days` set, also deletes older samples (non-evidence), context_events, slack_messages and meeting_segments, and clears meeting audio. Meeting rows and derived tables stay.

## MCP server

Registered in `.mcp.json`, started automatically by Claude Code. Communicates over stdio.

### Important tools for standups

The standup pipeline uses compact mode for all calls:
1. `summarize_window` with `compact: true, merge_gap_min: 5, min_duration_min: 2` — returns pre-merged sessions for yesterday (timeline context)
2. `standup_draft` with `compact: true` — returns sessions, follow-ups, open PRs, and recent ideas (omits raw blocks)
3. `get_inbox` — consolidated mentions, pending PRs, and open follow-ups in one call

All responses fit within LLM context windows — no disk saves or `jq` extraction needed.

### Tool interaction patterns
- `triage_samples` -> user decides -> `delete_samples` or `link_evidence`
- `log_idea` -> later `list_ideas` -> optionally promote to project
- `create_project` -> `link_evidence` (tag samples as evidence for it)
- `get_inbox` — one call for skills: OCR mentions, PR review requests (`gh`), and the top ranked open to-dos (same ranking as `todo_list`)
- `todo_resolve` — close a to-do as done, dismissed, or not_a_thing, with a one-line note
- `log_usage` — called by skills as step 0 to record invocations; `usage_stats` — query usage data with per-name breakdown and 14-day daily trends
- `get_inbox` and `standup_draft` call `gh` for review requests — requires the `gh` CLI to be authenticated
- `mentions` searches OCR text for name patterns configured in `user-config.json`; shared `scanAndGroupMentions()` function is reused by `get_inbox`

### Compact mode
Key tools (`summarize_window`, `standup_draft`, `triage_samples`, `mentions`) support a `compact` parameter. When `true`:
- `ocr_excerpt`, `selected_texts`, `focused_elements` are omitted from blocks
- `metadata` (JIRA tickets, PR URLs) is always preserved
- `top_words`, `sample_ids`, `document_paths` are always preserved
- Response sizes drop 70-98% vs default mode

## Claude Code integration

### Skills
Skills are defined in `.claude/skills/*/SKILL.md` and registered in `.claude/settings.json`. They are slash commands that give Claude step-by-step instructions for orchestrating MCP tools.

The `/standup` skill is the most complex — it does a three-pass approach:
1. Calls `summarize_window` with `compact: true, merge_gap_min: 5, min_duration_min: 2` for yesterday's timeline
2. Calls `standup_draft` with `compact: true` for structured data (sessions, follow-ups, PRs)
3. Calls GitHub MCP for PR review verification (accurate "reviewed" vs "looked at" language)
4. Calls `get_inbox` for mentions and follow-ups
5. Uses all sources to draft Yesterday/Today/Blockers prose

### Hooks
- `UserPromptSubmit`: Checks if today's standup has been logged and shows a reminder if not.

### MCP registration
`.mcp.json` points to `apps/mcp/dist/server.js` with `DATA_DIR` set to the Application Support directory. The server must be built first (`cd apps/mcp && npm run build`).

## Removed: Vision/Ollama pipeline

The Ollama vision pipeline was removed after testing showed pre-digested context (timelines, session merging) drives standup quality better than per-screenshot vision summaries. Deleted files: `VisionSummarizer.swift`, `OllamaConfig.swift`, `ollama_status.ts`. The `vision_summary` column remains in the DB schema but is never written to or read by any tool.

## Building and running

### MCP server
```bash
cd apps/mcp
npm install
npm run build     # Compiles TypeScript to dist/
npm run dev       # Watch mode for development
```

### Capture daemon
```bash
cd apps/capture
./build.sh        # Build + codesign (preserves Screen Recording permission)
```

Start/stop via Launch Agent:
```bash
launchctl load ~/Library/LaunchAgents/com.kealjones.apotheosis.capture.plist
launchctl unload ~/Library/LaunchAgents/com.kealjones.apotheosis.capture.plist
```

Or in Claude Code: `/capture start`, `/capture stop`

The daemon auto-starts on login via the Launch Agent. The plist template is at `apps/capture/com.kealjones.apotheosis.capture.plist` — `/init` or `setup.sh` installs it with the correct binary path.

## Common modification patterns

### Adding a new MCP tool
1. Create `apps/mcp/src/tools/my_tool.ts` — export `name`, `description`, `inputSchema` (a zod shape: `{ arg: z.string().describe(...) }`), and `handler`
2. Import it in `apps/mcp/src/server.ts` and add it to the `tools` array; it is wrapped with `tracked()` automatically (export `trackUsage = false` to opt out)
3. Run `pnpm --filter apotheosis-mcp build`

### Adding a new skill
1. Create `.claude/skills/my-skill/SKILL.md` with steps
2. Register in `.claude/settings.json` under `skills`

### Modifying skip patterns
Edit `~/Library/Application Support/apotheosis/skip-patterns.json` — no rebuild needed, but the capture daemon loads it on startup (restart daemon to pick up changes).

### Modifying secret redaction
Edit the rule lists in `apps/capture/Sources/Capture/Redactor.swift`, then rebuild with `apps/capture/build.sh` and restart the daemon.
