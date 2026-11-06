# Apotheosis

ADHD-friendly work tracker that runs silently in the background, captures what you're doing, and turns it into standups, timelines, and a portfolio of your impact — all local, all private.

## Getting started

### Prerequisites

- macOS 14+ (capture daemon uses ScreenCaptureKit + Accessibility API)
- Node.js >= 22
- Swift toolchain (Xcode or `swift` CLI)
- GitHub CLI (`gh`) authenticated, for PR tracking
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed

### Quick setup

Clone the repo, open it in Claude Code, and run:

```
/init
```

This walks you through setup interactively: creates the data directory, configures your identity for mention detection, and builds everything.

Alternatively, use the shell script:

```bash
./setup.sh
```

After setup, the capture daemon is installed as a Launch Agent and will auto-start on login. You'll need to grant it a few macOS permissions before it can capture anything.

### macOS permissions

The capture daemon needs four permissions. All are configured in **System Settings > Privacy & Security**.

1. **Screen Recording** -- required for taking screenshots of your windows, and for capturing system audio (the other side of a call) during meetings.
   - System Settings > Privacy & Security > Screen Recording
   - Toggle on the **Capture** app (it may appear as the terminal or binary that launched it)
   - You may need to restart the daemon after granting this (`/capture restart`)

2. **Accessibility** -- required for reading window titles, focused elements, selected text, and document paths via the Accessibility API.
   - System Settings > Privacy & Security > Accessibility
   - Toggle on the **Capture** app

3. **Automation** (Apple Events) -- required for reading browser URLs from Safari and Chrome via AppleScript.
   - macOS will prompt you automatically the first time the daemon tries to read a browser URL
   - Click "Allow" when prompted

4. **Microphone** -- required for recording your side of meetings (macOS 26+). Transcription runs on-device with Apple's `SpeechAnalyzer`; the first meeting downloads the English speech model (a few seconds).
   - macOS will prompt the first time a meeting starts; click "Allow"
   - If denied, meetings are still detected but end up `transcript_status = 'failed'` with any captured audio kept. Re-enable under System Settings > Privacy & Security > Microphone

Meeting audio is written to `~/Library/Application Support/apotheosis/meetings/<meeting_id>/{me,them}.caf` while recording. It is deleted once the transcript is `done`, unless `"meetings": {"keep_audio": true}` is set in `user-config.json` (the older top-level `keep_meeting_audio` key still works as a fallback). Meetings that `failed` or are still `transcribing` (transcription fell more than 60s behind) keep their audio so they can be retried.

**Meeting recording is opt-in and consent-gated.** It is off by default (`meetings.enabled = false`). Once enabled, `meetings.mode` controls how: `"ask"` (default) shows a floating Record / Skip / Always-for-this-room prompt before capturing any audio (skips on its own after 20 seconds), `"auto"` records without prompting, and `"off"` behaves like disabled. `meetings.blocklist` (case-insensitive title substrings, e.g. `"1:1"`, `"therapy"`) and `meetings.domain_allowlist` (restrict to specific meeting domains) apply on top of that. See `user-config.json` and `MeetingConfig.swift` for the full schema.

Capture timing is configurable under `capture` in `user-config.json` (all keys optional; defaults shown). Edits apply on the next tick, no restart needed:

```json
"capture": {
  "interval_seconds": 15,
  "days": ["mon", "tue", "wed", "thu", "fri"],
  "start_time": "00:00",
  "end_time": "24:00",
  "idle_after_seconds": 300
}
```

`interval_seconds` is clamped to 5-3600. The time window is local time; an `end_time` before `start_time` wraps past midnight. Outside the schedule the menu offers "Capture Now (until midnight)". The schedule (and Pause) gates screenshots, app/window/file events and the start of new meetings.

Add `"retention_days": 90` to the same block to delete raw captures older than that: samples, context events, Slack messages, meeting transcripts and audio. Evidence-tagged samples, meeting rows with their summaries, and everything derived (standups, to-dos, projects) are kept. Off by default.

If the daemon is running but `/today` shows no data, check these permissions first. The daemon logs to `~/Library/Logs/apotheosis/capture.log` which can help diagnose permission issues.

Then open Claude Code in this directory and try:

```
/capture    # check daemon status
/today      # see today's activity timeline
/standup    # generate yesterday's standup
```

## How it works

Apotheosis has three main components: a **capture daemon** (Swift menu bar app) that records your screen activity, an **MCP server** (Node.js) that gives Claude Code access to that data through tools, and **skills**.

```
                                  You, working normally
                                          |
                                          v
                          +-------------------------------+
                          |    Capture Daemon (Swift)     |
                          |    Menu bar app, 30s ticks    |
                          +-------------------------------+
                                    |         |
                          Screenshot taken    Active app/window
                          (all displays,      context captured
                           stitched)          via Accessibility API
                                    |         |
                                    v         v
                          +-------------------------------+
                          |       Processing Pipeline     |
                          +-------------------------------+
                          |                               |
                          |  1. Skip check                |
                          |     - Bundle blocklist        |
                          |     - Window title patterns   |
                          |     (configurable JSON)       |
                          |                               |
                          |  2. Screenshot -> disk        |
                          |     ~/Library/App Support/    |
                          |     apotheosis/screenshots/     |
                          |                               |
                          |  3. Store metadata -> SQLite  |
                          |     app, window, URL, time    |
                          |                               |
                          |  4. OCR (Apple Vision)        |
                          |     Extract text from image   |
                          |     -> redact secrets         |
                          |     -> store in DB            |
                          |     -> delete screenshot      |
                          |                               |
                          +-------------------------------+
                                          |
                                          v
                          +-------------------------------+
                          |   SQLite Database             |
                          |   ~/Library/App Support/      |
                          |   apotheosis/apotheosis.db        |
                          |                               |
                          |   Tables:                     |
                          |   - samples (screen captures) |
                          |   - projects (portfolio)       |
                          |   - ideas (quick captures)    |
                          |   - standups (logged)         |
                          |   - commitments (mentions/PRs)|
                          +-------------------------------+
                                          |
                               Shared via WAL mode
                                          |
                                          v
                          +-------------------------------+
                          |   MCP Server (Node.js)        |
                          |   Connects to Claude Code     |
                          |   via stdio transport         |
                          +-------------------------------+
                          |                               |
                          |  Tools (14):                  |
                          |  - standup_draft              |
                          |  - summarize_window           |
                          |  - recent_activity            |
                          |  - triage_samples             |
                          |  - delete_samples             |
                          |  - log_idea / list_ideas      |
                          |  - log_standup                |
                          |  - mentions                   |
                          |  - link_evidence              |
                          |  - create_project/get_project |
                          |  - code_time (git log)        |
                          |  - ollama_status              |
                          |                               |
                          |  Integrations:                |
                          |  - GitHub (gh CLI)            |
                          |  - Google Calendar (planned)  |
                          |                               |
                          +-------------------------------+
                                          |
                                          v
                          +-------------------------------+
                          |   Claude Code Skills (7)      |
                          |   Slash commands that         |
                          |   orchestrate MCP tools       |
                          +-------------------------------+
                          |                               |
                          |  /standup    - daily standup   |
                          |  /today     - activity timeline|
                          |  /whats-next - next action    |
                          |  /follow-ups - mentions & PRs |
                          |  /log-idea  - capture ideas   |
                          |  /cleanup-screenshots         |
                          |  /capture   - daemon control  |
                          |                               |
                          +-------------------------------+
                                          |
                                          v
                                  Standup in Slack,
                                  portfolio of impact,
                                  "what was I doing?"
```

## Architecture

### Capture daemon (`apps/capture/`)

A Swift macOS menu bar app that captures your screen every 30 seconds.

| File | Purpose |
|------|---------|
| `App.swift` | Menu bar UI — camera icon, pause/resume, "What did I do today?" query |
| `CaptureLoop.swift` | 30-second timer, coordinates the full capture pipeline |
| `ActiveContext.swift` | Rich context via Accessibility API: app bundle, window title, document path, selected text, focused element role/description, all visible window titles; browser URL via AppleScript |
| `SkipPatterns.swift` | Configurable skip list loaded from `skip-patterns.json` — bundle blocklist, bundle keywords, window title patterns |
| `IdleGate.swift` | Skips capture when user is idle > 5 minutes (no mouse/keyboard) |
| `OCR.swift` | Apple Vision framework OCR on background queue, deletes screenshot after extraction |
| `Redactor.swift` | Scrubs secrets from every text field before `Store` writes it |
| `Retention.swift` | Sweeps leftover screenshots; applies optional `capture.retention_days` |
| `Store.swift` | SQLite wrapper — inserts samples, updates OCR text and vision summaries |
| `VisionSummarizer.swift` | Ollama vision integration (currently disabled) — sends screenshots to a local LLM for richer summaries |
| `OllamaConfig.swift` | Ollama endpoint, model, prompt, timeout configuration |

**Capture flow per tick:**
1. Check if paused, outside the `capture.*` schedule, or idle -> skip if so
2. Get active app context via Accessibility API:
   - App bundle ID and name (`NSWorkspace`)
   - Window title (`kAXTitleAttribute`)
   - Document path (`kAXDocumentAttribute` — exact file path from VS Code, Xcode, etc.)
   - Selected text (`kAXSelectedTextAttribute` — whatever you have highlighted)
   - Focused element role + description (`kAXFocusedUIElementAttribute`)
   - All visible window titles across apps (`CGWindowListCopyWindowInfo`)
   - Browser URL (AppleScript for Safari/Chrome)
3. Check skip patterns (sensitive apps/windows) -> skip if matched
4. Capture screenshot of all displays, stitch side-by-side
5. Write JPEG to `~/Library/Application Support/apotheosis/screenshots/yyyy-mm-dd/`
6. Insert metadata + accessibility context row into SQLite
7. Enqueue OCR: extract text -> redact secrets -> store in DB -> delete screenshot file

### MCP server (`apps/mcp/`)

A Node.js MCP server that reads the SQLite database and exposes 14 tools to Claude Code.

| File | Purpose |
|------|---------|
| `server.ts` | MCP server setup, registers all tools with Zod schemas |
| `db.ts` | SQLite connection (better-sqlite3), WAL mode, schema migrations |
| `summarize.ts` | Core data processing: groups samples into `WorkBlock`s (by app+window, 10min gap) and `Session`s (by app, 5min gap), extracts structured metadata (JIRA tickets, PR URLs, file paths) |

**Tools:**

| Tool | What it does |
|------|-------------|
| `standup_draft` | Assembles yesterday's sessions + blocks, pending follow-ups, open PRs, recent ideas |
| `summarize_window` | Groups samples in a time range into work blocks |
| `recent_activity` | Returns raw samples with all fields for a time range |
| `triage_samples` | Scores sample clusters as high/medium/low signal for cleanup |
| `delete_samples` | Deletes samples by ID (refuses evidence-tagged ones) |
| `log_idea` / `list_ideas` | Quick-capture and retrieve ideas |
| `log_standup` | Saves a standup to the database |
| `mentions` | Searches OCR text for @-mentions of your name |
| `get_inbox` | Mentions, PR review requests (`gh`), and top ranked to-dos in one call |
| `link_evidence` | Tags samples as evidence for a project |
| `create_project` / `get_project` | Manage portfolio project entries |
| `code_time` | Analyzes git log for time-on-code metrics |
| `ollama_status` | Checks/starts Ollama (for vision pipeline) |

**Data processing pipeline (`summarize.ts`):**

```
Raw samples (one per 30s capture, ~2880/day)
    |
    v  groupIntoBlocks()
Work blocks (~268/day)
  - Grouped by exact app_bundle + window_title
  - Max 10-minute gap between consecutive samples
  - Contains: time range, top OCR words, OCR excerpt
    |
    v  groupIntoSessions()
Sessions (~20-30/day)
  - Grouped by app_bundle only (ignores window title)
  - Max 5-minute gap between consecutive blocks
  - Contains: distinct window titles, URLs, JIRA tickets,
    PR URLs, file paths, re-computed top words
```

### Web dashboard (`apps/web/`)

A Next.js (App Router, React 19) dashboard for browsing captured activity — meetings, standups, projects, analytics, and raw DB access — as an alternative to the Claude Code skills above. Built on Tailwind, shadcn/ui, and Recharts.

Server components and route handlers read from `@apotheosis/core` through `apps/web/lib/data.ts`, a `server-only`-guarded re-export, so the database layer can never be pulled into a client bundle.

**Starting the dashboard:**

From the menu bar, click "Open Dashboard". This checks if the web server is running on port 4317; if not, it starts it and opens your browser to `http://127.0.0.1:4317`.

Alternatively, start it manually:

```bash
pnpm --filter @apotheosis/web dev    # development (fast rebuilds, verbose output)
pnpm --filter @apotheosis/web start   # production (built dist, minimal logging)
```

Both bind to `127.0.0.1:4317` (localhost only — this is a personal local tool with no auth layer or API key validation). Every route reads real data straight from `~/Library/Application Support/apotheosis/apotheosis.db`; there is no demo or seed mode. The server refuses to start if the `HOST` environment variable is set to anything routable.

**Dashboard pages:**

- `/` — Today at a glance: sample count, top apps, current project, active hours, an editable standup panel, and Today's To-Do (the ranked open commitments list)
- `/commitments` - Full commitment ledger: filter by source and status, one-click Done / Snooze / Not a thing / Open source on open or snoozed rows, and a dismissed-history view that distinguishes a tagged "not a thing" from a plain dismiss
- `/timeline` — Scrollable timeline of today's activity, grouped into work sessions, with screenshots and OCR text
- `/standups` — Log standups: browse past standups, generate a draft for any date, save new entries
- `/projects` — Portfolio of past projects with tagged evidence, related PRs, and time-spent sparklines
- `/meetings` — Meeting transcripts and summaries (macOS 26+ with `meetings.enabled = true`): list meetings, view transcript and action items, summarize with Ollama
- `/analytics` — Charts: active hours per day, time by app/project, context-switch rate, coding/meeting/Slack time, AI tool usage
- `/review` — Year-to-date leveling rubric, evidence scoring, and promo packet drafting. Ships with a generic example rubric in `config/`; drop your company's `promo-packet.yaml` and ladder into `~/Library/Application Support/apotheosis/config/` to use your own (it wins over the example and stays out of git). `scripts/gen-leveling-yaml.mjs` converts a CSV ladder export.
- `/db` — Raw SQL sandbox (SELECT only, read-only connection, LIMIT 1000 enforced)
- `/chat` — Embedded Claude chat via the Agent SDK, with all Apotheosis tools available, write-path tools gated by confirmation

**To auto-start the dashboard on login** (optional):

```bash
mkdir -p ~/Library/Logs/apotheosis
sed -e "s|__REPO_ROOT__|$(pwd)|g" -e "s|__LOG_DIR__|$HOME/Library/Logs/apotheosis|g" \
  apps/web/com.kealjones.apotheosis.web.plist \
  > ~/Library/LaunchAgents/com.kealjones.apotheosis.web.plist

launchctl load ~/Library/LaunchAgents/com.kealjones.apotheosis.web.plist
```

To disable it later:

```bash
launchctl unload ~/Library/LaunchAgents/com.kealjones.apotheosis.web.plist
```

The dashboard is disabled by default (`RunAtLoad = false` in the plist) — enable it only if you want the server running constantly.

#### Commitments (`/commitments`) and the scheduled detector runner

`/` and `/commitments` both read the `commitments` table directly and never call `gh` or Ollama themselves -- detection happens out of band, on a schedule, via `packages/core/scripts/run-detectors.mjs` (a thin wrapper around `runDetectors()`, the same function the `run_detectors` MCP tool calls on demand).

Run it manually any time:

```bash
pnpm --filter @apotheosis/core build   # only needed after core source changes
pnpm --filter @apotheosis/core run detect
```

**To run it on a schedule** (optional, disabled by default):

```bash
mkdir -p ~/Library/Logs/apotheosis
sed -e "s|__REPO_ROOT__|$(pwd)|g" -e "s|__LOG_DIR__|$HOME/Library/Logs/apotheosis|g" \
  packages/core/com.kealjones.apotheosis.detectors.plist \
  > ~/Library/LaunchAgents/com.kealjones.apotheosis.detectors.plist

launchctl load ~/Library/LaunchAgents/com.kealjones.apotheosis.detectors.plist
```

To disable it later:

```bash
launchctl unload ~/Library/LaunchAgents/com.kealjones.apotheosis.detectors.plist
```

The plist uses `StartInterval = 1200` (every 20 minutes) rather than a tight loop: the Slack detectors call a local Ollama model per candidate message and the GitHub detectors shell out to `gh`, so running much more often than that buys little freshness for real added load. It's still frequent enough that Today's To-Do feels current within a workday. Like the web server's LaunchAgent, this one is disabled by default (`RunAtLoad = false`) -- enable it only if you want detection running continuously instead of triggering it by hand (`pnpm --filter @apotheosis/core run detect`, or the `run_detectors` MCP tool from a Claude Code session).

#### Chat (`/chat`)

An embedded Claude chat with every Apotheosis MCP tool attached. It runs the Claude Agent SDK server-side (`apps/web/app/api/chat/route.ts`), driving your installed `claude` CLI, so it uses your existing Claude Code login (no API key) and draws on your Claude subscription limits. Nothing runs until you hit Send.

- Every tool call renders as a card showing the tool, its arguments, and its result.
- Read-only tools run automatically. Anything that writes or deletes (`delete_samples`, `log_standup`, `create_project`, `log_idea`, `link_evidence`, `todo_resolve`, `log_usage`, `summarize_meeting`, and any tool not on the read-only allowlist in `apps/web/lib/chat/protocol.ts`) pauses for Allow/Deny in the chat.
- "Ask Claude about this page" (every page header) opens the chat with the page's route and date range prefilled.
- "Open in Claude Code" opens Terminal in the repo running `claude` with your prompt.
- `GET /api/chat/health` reports whether the CLI is found and logged in. If it says you're logged out, run `claude` and log in again.

Prerequisites: `pnpm install` at the repo root and `pnpm --filter apotheosis-mcp build` (the chat spawns `apps/mcp/dist/server.js`). If `claude` isn't on the server's PATH, set `APOTHEOSIS_CLAUDE_PATH`.

### Claude Code skills (`.claude/skills/`)

Skills are slash commands that orchestrate MCP tools into workflows.

| Skill | Trigger | What it does |
|-------|---------|-------------|
| `/standup` | Manual | Two-pass: calls `summarize_window` for timeline context, then `standup_draft` for structured data. Drafts Yesterday/Today/Blockers prose. Offers to log and clean up. |
| `/today` | Manual | Calls `summarize_window` for today, formats as a timeline with merged blocks |
| `/whats-next` | Auto (SessionStart) | Checks PRs, mentions, ideas. Recommends one next action. |
| `/follow-ups` | Manual | Reviews pending @-mentions and PR review requests |
| `/log-idea` | Manual | Captures an idea, checks for duplicates |
| `/cleanup-screenshots` | Manual | Walks through sample clusters, lets you tag as evidence/keep/delete |
| `/capture` | Manual | Start, stop, or check status of the capture daemon |

### Hooks (`.claude/settings.json`)

- **UserPromptSubmit**: Checks if today's standup has been logged. If not, shows a reminder.

## One-time setup

### Prerequisites

- macOS (capture daemon uses ScreenCaptureKit + Accessibility API)
- Node.js >= 22
- Swift toolchain (Xcode or swift CLI)
- GitHub CLI (`gh`) — for PR review tracking
- Screen Recording permission granted to the capture app

### 1. MCP server

```bash
pnpm install
pnpm --filter @apotheosis/core build
pnpm --filter apotheosis-mcp build
```

The MCP server is already registered in `.mcp.json` — Claude Code picks it up automatically when you open this directory.

Verify:
```bash
claude mcp list   # should show "apotheosis"
```

### 2. Capture daemon

Build, codesign, and install the Launch Agent:

```bash
cd apps/capture && ./build.sh && cd ../..

# Install the Launch Agent (auto-starts on login)
BINARY_PATH="$(pwd)/apps/capture/.build/arm64-apple-macosx/debug/Capture"
mkdir -p ~/Library/Logs/apotheosis
sed -e "s|__BINARY_PATH__|${BINARY_PATH}|g" -e "s|__LOG_DIR__|$HOME/Library/Logs/apotheosis|g" \
  apps/capture/com.kealjones.apotheosis.capture.plist \
  > ~/Library/LaunchAgents/com.kealjones.apotheosis.capture.plist

# Start it now
launchctl load ~/Library/LaunchAgents/com.kealjones.apotheosis.capture.plist
```

A camera icon appears in the menu bar. Grant Screen Recording permission when macOS prompts.

Always use `./build.sh` for builds — it codesigns the binary with a stable identity (`com.kealjones.apotheosis.capture`) so macOS preserves Screen Recording permission across rebuilds.

### 3. Verify everything works

```bash
# Check capture daemon is running
pgrep -f '.build/debug/Capture'

# Check MCP server is registered
claude mcp list

# Open Claude Code in this directory and run:
# /today
# /capture
```

## Each morning

1. **The capture daemon auto-starts on login** via the Launch Agent. Verify with `/capture` or:
   ```bash
   pgrep -f 'debug/Capture'
   ```

2. **Run your standup:**
   ```
   /standup
   ```
   This generates yesterday's standup, offers to log it, and optionally cleans up old screenshots.

3. **Check what needs attention:**
   ```
   /whats-next
   ```
   This runs automatically when you open Claude Code in this directory (via the SessionStart hook), but you can run it anytime.

## Daily workflow

| Command | When to use | What it does |
|---------|-------------|-------------|
| `/standup` | Each morning | Draft standup from yesterday's captures |
| `/today` | Anytime | Timeline of what you've done so far today |
| `/whats-next` | Auto on session start | Single recommended next action |
| `/log-idea <text>` | Anytime | Quick-capture an idea into the inbox |
| `/follow-ups` | When you have a moment | Review pending @mentions + PR reviews |
| `/cleanup-screenshots [date]` | Weekly-ish | Triage screenshots: evidence / keep / delete |
| `/capture` | When needed | Start, stop, or check capture daemon |

## Data

All data stays on your Mac. Nothing is sent anywhere.

| Location | Contents |
|----------|----------|
| `~/Library/Application Support/apotheosis/apotheosis.db` | SQLite database shared between capture daemon and MCP server |
| `~/Library/Application Support/apotheosis/screenshots/` | Screenshot JPEGs organized by date (deleted after OCR by default) |
| `~/Library/Application Support/apotheosis/skip-patterns.json` | Configurable skip patterns for sensitive apps/windows |

### Database tables

| Table | Purpose |
|-------|---------|
| `samples` | Screen captures: timestamp, app, window, URL, OCR text, document path, selected text, focused element, visible windows, evidence flag |
| `projects` | Portfolio project entries with slug, name, description |
| `project_links` | Links between projects and external references |
| `ideas` | Quick-captured ideas with body, source, optional clustering |
| `standups` | Logged standups with yesterday/today/blockers sections |
| `commitments` | Detected follow-up-worthy items (mentions, PR reviews, promises, etc.) with status tracking |

## Privacy and security

- **All local.** No data leaves your machine. The MCP server communicates with Claude Code over stdio — your captured data goes to the LLM only when you explicitly run a skill.
- **Sensitive app skipping.** The capture daemon skips 1Password, banking apps, and other sensitive bundles. Window-title patterns (`.env`, `credentials`, `.pem`, `.key`, SSH keys) also trigger skips. Customize in `skip-patterns.json`.
- **Secret redaction.** Every text field the daemon stores (OCR, window titles, URLs, selected text, Slack messages, meeting titles and transcripts) passes through `Redactor.swift`. Known token formats (AWS, Bearer, GitHub, Slack, npm, `sk-` keys, JWTs, private key blocks) and credential URL parameters (`?token=`, `&code=`, ...) are replaced everywhere. Free text also loses long hex/base64 strings and long `KEY=value` lines; those rules skip URLs and titles so links keep working.
- **Sensitive files.** File-change tracking drops paths matching the `skip-patterns.json` window title patterns (`.pem`, `credentials`, `id_rsa`, ...).
- **Screenshots deleted after OCR.** Screenshot files are removed from disk immediately after OCR text extraction. Leftovers from interrupted OCR runs are swept after a day (evidence-tagged ones excepted). Only the text and metadata persist.
- **Retention.** Optional `capture.retention_days` deletes old raw captures (see above).
- **Logs** go to `~/Library/Logs/apotheosis/`, not world-readable `/tmp`.
- **Evidence protection.** Samples tagged as evidence (via `/cleanup-screenshots`) cannot be deleted by `delete_samples`.
- **Recording other people is on you, not the tool.** Meeting recording is opt-in, gated by consent controls (see above), and only ever captures your own machine's mic + system audio — but you are responsible for disclosing that a meeting is being recorded, and some jurisdictions require *all-party* consent to record a conversation, not just your own. Know the law where you (and everyone else on the call) are before turning `meetings.enabled` on.
