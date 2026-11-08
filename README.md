# Apotheosis

ADHD-friendly work tracker that runs silently in the background, captures what you're doing, and turns it into standups, timelines, and a portfolio of your impact — all local, all private.

## Read this first: safety, legality, and your responsibility

Apotheosis records what is on your screen and, if you turn them on, audio from your meetings and local AI summaries of your Slack conversations. Everything stays on your machine, but "local" does not make it automatically legal or allowed.

- **Check your employer's policies.** Many companies restrict screen capture, meeting recording, which AI tools and models you may use, and where work data may be stored. If this runs on a work machine, read those policies (or ask) first. If anything is unclear, don't enable it.
- **Meeting recording is off by default, and should usually stay off.** Recording or transcribing a conversation without the consent the law requires can be a crime and can expose you to civil liability. Some places require the consent of *everyone* on a call, and you usually can't know where every participant is. Many employers also only allow recording through approved meeting tools. Only turn on `meetings.enabled` if you are sure it is legal where you and every participant are *and* allowed by your employer. `/init` and `setup.sh` ask you to confirm both before enabling it.
- **Local AI features are off by default.** Local Slack digests (`slack.local_digest`) and the other local-model features run whatever Ollama model you configure (default `gemma4:e4b`). Make sure Ollama and that model are on your employer's approved list, or don't enable them.
- **Keep less.** Set `capture.retention_days` so raw captures age out instead of piling up forever.
- **You can always turn it off.** Use Pause in the menu bar, the capture schedule, or `/capture stop`.

### Disclaimer and assumption of risk

Apotheosis is provided "as is", without warranty of any kind, under the [MIT License](LICENSE). The authors and contributors are not liable for any claim, damages, or other liability arising from its use, including use that violates recording, wiretapping, eavesdropping, privacy, or data-protection laws, or an employer's policies.

**You are solely responsible for how you use this software.** By installing it or enabling any of its features, you agree that you have checked and will follow the laws and policies that apply to you and to everyone whose words, images, or messages it may capture, including obtaining any consent those laws require, and that you assume all risk of doing so. Nothing in this project is legal advice. If you are unsure whether a use is legal or allowed, don't do it, or ask a lawyer.

## Getting started

### Prerequisites

- macOS 14+ (capture daemon uses ScreenCaptureKit + Accessibility API); meeting recording and transcription need macOS 26+
- Node.js >= 24
- Swift toolchain (Xcode or `swift` CLI)
- GitHub CLI (`gh`) authenticated, for PR tracking
- [Ollama](https://ollama.com) (optional), only for the local-model features (meeting summaries, Slack digests and classification)
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
                          |    Menu bar app, 15s ticks    |
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
                          |   - meetings, slack_messages  |
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
                          |  Tools (33), including:       |
                          |  - standup_draft              |
                          |  - summarize_window           |
                          |  - recent_activity            |
                          |  - triage_samples             |
                          |  - delete_samples             |
                          |  - log_idea / list_ideas      |
                          |  - log_standup                |
                          |  - mentions / slack_search    |
                          |  - slack_digests              |
                          |  - todo_* / run_detectors     |
                          |  - meetings (list/get/search) |
                          |  - link_evidence              |
                          |  - create_project/get_project |
                          |  - code_time (git log)        |
                          |                               |
                          |  Integrations:                |
                          |  - GitHub (gh CLI)            |
                          |  - Google Calendar (planned)  |
                          |                               |
                          +-------------------------------+
                                          |
                                          v
                          +-------------------------------+
                          |   Claude Code Skills (10)      |
                          |   Slash commands that         |
                          |   orchestrate MCP tools       |
                          +-------------------------------+
                          |                               |
                          |  /standup    - daily standup   |
                          |  /today     - activity timeline|
                          |  /whats-next - next action    |
                          |  /follow-ups - mentions & PRs |
                          |  /log-idea  - capture ideas   |
                          |  /cleanup-samples             |
                          |  /capture   - daemon control  |
                          |  /evidence  - review evidence |
                          |  /init      - first-time setup|
                          |  /calendar-correlation        |
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

A Swift macOS menu bar app that captures your screen every 15 seconds by default (`capture.interval_seconds`).

| File | Purpose |
|------|---------|
| `App.swift` | Menu bar UI — camera icon, pause/resume, "What did I do today?" query |
| `CaptureLoop.swift` | Interval timer (15s default), coordinates the full capture pipeline |
| `CaptureSchedule.swift` | Reads the `capture.*` schedule (interval, days, hours, idle) from `user-config.json` |
| `ActiveContext.swift` | Rich context via Accessibility API: app bundle, window title, document path, selected text, focused element role/description, all visible window titles; browser URL via AppleScript |
| `SkipPatterns.swift` | Configurable skip list loaded from `skip-patterns.json` — bundle blocklist, bundle keywords, window title patterns |
| `IdleGate.swift` | Skips capture when user is idle > 5 minutes (no mouse/keyboard) |
| `OCR.swift` | Apple Vision framework OCR on background queue, deletes screenshot after extraction |
| `Redactor.swift` | Scrubs secrets from every text field before `Store` writes it |
| `Retention.swift` | Sweeps leftover screenshots; applies optional `capture.retention_days` |
| `Store.swift` | SQLite wrapper: inserts samples, updates OCR text, stores Slack messages and meetings |
| `SlackExtractor.swift` | Structured Slack message extraction from the accessibility tree |
| `Meeting*.swift`, `AudioSources.swift`, `EchoFilter.swift` | Opt-in meeting detection, consent prompt, and on-device transcription (macOS 26+) |

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

A Node.js MCP server that reads the SQLite database and exposes 33 tools to Claude Code.

| File | Purpose |
|------|---------|
| `server.ts` | MCP server setup, registers all tools with Zod schemas |
| `tools/*.ts` | One module per tool, each exporting its name, description, Zod schema and handler |

The shared core in `packages/core/src` holds the rest:

| File | Purpose |
|------|---------|
| `db.ts` | SQLite connection (`node:sqlite`), WAL mode, schema migrations |
| `summarize.ts` | Core data processing: groups samples into `WorkBlock`s (by app+window, 10min gap) and `Session`s (by app, 5min gap), extracts structured metadata (JIRA tickets, PR URLs, file paths) |

**Tools:**

| Tool | What it does |
|------|-------------|
| `standup_draft` | Assembles yesterday's work blocks, Slack threads (as local digests when available), Claude Code sessions, pending follow-ups, open PRs, recent ideas |
| `summarize_window` | Groups samples in a time range into work blocks |
| `recent_activity` | Returns raw samples with OCR excerpt and accessibility context for a time range |
| `context_timeline` | App switches, window focus/title changes and file modifications between samples |
| `triage_samples` | Scores untagged sample clusters as high/medium/low signal for cleanup |
| `delete_samples` | Deletes samples by ID (refuses evidence-tagged ones) |
| `log_idea` / `list_ideas` | Quick-capture and retrieve ideas |
| `log_standup` | Saves a standup to the database |
| `mentions` | Searches OCR text for @-mentions of your name |
| `slack_search` | Searches structured Slack messages (sender, channel, thread) extracted by the daemon |
| `slack_digests` | Local-model digests of active Slack conversations, most urgent first (needs `slack.local_digest`) |
| `get_inbox` | Mentions, PR review requests (`gh`), and open follow-ups in one call |
| `link_evidence` | Tags samples as evidence for a project |
| `create_project` / `get_project` | Manage portfolio project entries |
| `code_time` | Commits plus estimated active time for a git repo |
| `todo_list` / `todo_add` / `todo_resolve` / `todo_snooze` | Ranked commitments ledger: list, add manually, resolve (done / dismissed / not a thing), snooze |
| `run_detectors` | Forces a detector pass now: commitment detectors, Slack digest refresh (if enabled), then unloads the local model |
| `list_meetings` / `get_meeting` / `search_meetings` | Browse, fetch and full-text search meeting transcripts |
| `summarize_meeting` | Structured meeting summary via a local Ollama model |
| `delete_meeting` | Deletes a meeting, its segments and any leftover audio |
| `list_uncorrelated_meetings` / `link_meeting_calendar_event` | Match meetings to Google Calendar events |
| `evidence_report` | Compact evidence payload for reviews, promo packets and brag docs |
| `review_status` | Scores evidence against the configured leveling guide (local Ollama model) |
| `log_usage` / `usage_stats` | Track and report MCP tool and skill usage |

**Data processing pipeline (`summarize.ts`):**

```
Raw samples (one per capture tick)
    |
    v  groupIntoBlocks()
Work blocks
  - Grouped by exact app_bundle + window_title
  - Max 10-minute gap between consecutive samples
  - Contains: time range, top OCR words, OCR excerpt
    |
    v  groupIntoSessions()
Sessions
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
- `/timeline`: Scrollable timeline of today's activity, grouped into work sessions, with OCR text
- `/standups` — Log standups: browse past standups, generate a draft for any date, save new entries
- `/projects` — Portfolio of past projects with tagged evidence, related PRs, and time-spent sparklines
- `/meetings`: Meeting transcripts and summaries (macOS 26+ with `meetings.enabled = true`): list meetings, view transcript and action items, summarize with the local Ollama model
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

`/` and `/commitments` both read the `commitments` table directly and never call `gh` or Ollama themselves -- detection happens out of band, on a schedule, via `packages/core/scripts/run-detectors.mjs`. It calls `runScheduledPass()`, the same function the `run_detectors` MCP tool calls on demand. Each pass:

1. Runs the commitment detectors (GitHub, git, standups, ideas, meetings, and the Slack detectors that use the local model).
2. If `slack.local_digest` is on, refreshes the local Slack digests (below).
3. Unloads the local model so it doesn't stay in memory until the next pass.

Local-model work is skipped on a scheduled pass when the laptop is on battery or macOS reports memory pressure, and it is incremental: Slack classifications are cached per message and digests per conversation, so a pass with no new Slack activity makes no model calls and never loads the model. The `run_detectors` tool ignores the battery and memory guard because you asked for it explicitly.

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

The plist uses `StartInterval = 1200` (every 20 minutes): frequent enough that `/today` and the to-do list feel current within a workday, without running `gh` and the local model constantly. The schedule isn't installed by default; install it only if you want detection running continuously instead of triggering it by hand (`pnpm --filter @apotheosis/core run detect`, or the `run_detectors` MCP tool).

#### Local Slack digests (opt-in)

With `"slack": { "local_digest": true }` in `user-config.json` and the detector schedule installed, each pass has the local model write a short digest of every Slack conversation you're active in from the last few days (threads you posted in, plus DMs): a one or two sentence summary, urgency, your to-dos, and open items. A conversation is only re-digested when its messages change.

- `/today` shows them through the `slack_digests` MCP tool, most urgent first.
- `/standup` gets them through `standup_draft`: a thread with an up-to-date digest is sent as the digest instead of raw message text, which is fewer tokens and less Slack text handed to Claude. Any thread without one (feature off, model hasn't run, or new messages since its last run) falls back to the raw text, so standups never depend on the local model.
- The model is `APOTHEOSIS_OLLAMA_MODEL` (default `gemma4:e4b`). Digests are a local model's notes, so treat to-dos in them as hints to check, not facts.

`"slack": { "ignore_patterns": ["^Merging master into"] }` drops messages matching any of those case-insensitive regexes from every Slack feature, which is useful for bot posts sent under your name.

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
| `/standup` | Manual | Two-pass: calls `summarize_window` for timeline context, then `standup_draft` for structured data. Drafts Yesterday/Today/Blockers prose and offers to log it. |
| `/today` | Manual | Calls `summarize_window` for today, formats as a timeline with merged blocks |
| `/whats-next` | Manual | Checks PRs, mentions, ideas. Recommends one next action. |
| `/follow-ups` | Manual | Reviews pending @-mentions and PR review requests |
| `/log-idea` | Manual | Captures an idea, checks for duplicates |
| `/cleanup-samples` | Manual | Walks through sample clusters, lets you tag as evidence/keep/delete |
| `/evidence` | Manual | Drafts a brag doc, promo packet or self-assessment from standups, projects, AI usage and Slack recognition |
| `/init` | Manual | First-time setup |
| `/calendar-correlation` | Periodic | Matches captured meetings to Google Calendar events (run via `/loop` or a scheduled task) |
| `/capture` | Manual | Start, stop, or check status of the capture daemon |

### Hooks (`.claude/settings.json`)

- **UserPromptSubmit**: Checks if today's standup has been logged. If not, shows a reminder.

## One-time setup

### Prerequisites

- macOS 14+ (capture daemon uses ScreenCaptureKit + Accessibility API)
- Node.js >= 24
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
   This generates yesterday's standup and offers to log it.

3. **Check what needs attention:**
   ```
   /whats-next
   ```
   Run it anytime you want a single recommended next action.

## Daily workflow

| Command | When to use | What it does |
|---------|-------------|-------------|
| `/standup` | Each morning | Draft standup from yesterday's captures |
| `/today` | Anytime | Timeline of what you've done so far today |
| `/whats-next` | Anytime | Single recommended next action |
| `/log-idea <text>` | Anytime | Quick-capture an idea into the inbox |
| `/follow-ups` | When you have a moment | Review pending @mentions + PR reviews |
| `/cleanup-samples [date]` | Weekly-ish | Triage samples: evidence / keep / delete |
| `/capture` | When needed | Start, stop, or check capture daemon |

## Data

All data stays on your Mac. Nothing is sent anywhere.

| Location | Contents |
|----------|----------|
| `~/Library/Application Support/apotheosis/apotheosis.db` | SQLite database shared between capture daemon and MCP server |
| `~/Library/Application Support/apotheosis/screenshots/` | Screenshot JPEGs organized by date (deleted right after OCR, so normally empty) |
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
| `context_events` | App switches, window focus/title changes and file modifications between samples |
| `slack_messages` | Structured Slack messages extracted from the accessibility tree. `sender_explicit` is 1 when the sender came from the message's own name header, 0 when it was inherited from the message above (Slack only shows the name on the first message of a run) or is unknown |
| `meetings` / `meeting_segments` | Opt-in meeting records, transcripts, summaries and action items |

## Privacy and security

- **All local.** No data leaves your machine. The MCP server communicates with Claude Code over stdio — your captured data goes to the LLM only when you explicitly run a skill.
- **Sensitive app skipping.** The capture daemon skips 1Password, banking apps, and other sensitive bundles. Window-title patterns (`.env`, `credentials`, `.pem`, `.key`, SSH keys) also trigger skips. Customize in `skip-patterns.json`.
- **Secret redaction.** Every text field the daemon stores (OCR, window titles, URLs, selected text, Slack messages, meeting titles and transcripts) passes through `Redactor.swift`. Known token formats (AWS, Bearer, GitHub, Slack, npm, `sk-` keys, JWTs, private key blocks) and credential URL parameters (`?token=`, `&code=`, ...) are replaced everywhere. Free text also loses long hex/base64 strings and long `KEY=value` lines; those rules skip URLs and titles so links keep working.
- **Sensitive files.** File-change tracking drops paths matching the `skip-patterns.json` window title patterns (`.pem`, `credentials`, `id_rsa`, ...).
- **Screenshots deleted after OCR.** Screenshot files are removed from disk immediately after OCR text extraction. Leftovers from interrupted OCR runs are swept after a day. Only the text and metadata persist.
- **Retention.** Optional `capture.retention_days` deletes old raw captures (see above).
- **Logs** go to `~/Library/Logs/apotheosis/`, not world-readable `/tmp`.
- **Evidence protection.** Samples tagged as evidence (via `/cleanup-samples`) cannot be deleted by `delete_samples` and are skipped by `capture.retention_days`.
- **Recording other people is on you, not the tool.** Meeting recording is opt-in, gated by consent controls (see above), and only ever captures your own machine's mic + system audio — but you are responsible for disclosing that a meeting is being recorded, and some jurisdictions require *all-party* consent to record a conversation, not just your own. Know the law where you (and everyone else on the call) are before turning `meetings.enabled` on.
