# Apotheosis Agent Instructions

Apotheosis is a local-first work tracker, idea memory, standup assistant, and impact portfolio system. It passively captures screen activity, extracts OCR text, and exposes that data through an MCP server so AI agents can draft standups, build timelines, tag impact evidence for end-of-year self-reviews and performance reviews, and reduce ADHD memory load.

Single-user, local-only, macOS. No servers, no accounts, no cloud.

## ⚠️ Critical: Keep Documentation Current

**Any time changes are made to this project — new tools, schema changes, modified behavior, new skills, renamed files, updated workflows — ALL documentation and agent context files must be updated to reflect the current state before the change is considered complete.** Stale docs are actively harmful: they cause agents to use wrong tool names, reference missing files, follow outdated patterns, or generate incorrect outputs.

Files that must stay in sync with code changes:
- `AGENTS.md` (this file) — architecture, tool list, skills, schema, workflows
- `AI_CONTEXT.md` — deep technical reference, data model, capture pipeline
- `CLAUDE.md` — project rules and entry-point behavior
- `README.md` — user-facing setup and feature description
- Any skill `SKILL.md` files in `.claude/skills/` affected by the change

If you make a change and are unsure whether docs need updating, assume they do.

## Read First

- `AI_CONTEXT.md` — Deep technical reference: data model, capture pipeline, summarization logic, secret redaction, modification patterns.
- `CLAUDE.md` — Project rules (no fabrication, use real tools, treat data as sensitive).
- `README.md` — User-facing description and setup.

## Architecture

```
apps/
  capture/        Swift macOS menu bar daemon
  mcp/            TypeScript MCP server (19 tools)
.claude/skills/   7 slash-command skills
data/             Symlink to ~/Library/Application Support/apotheosis
```

### Capture Daemon (Swift, `apps/capture/Sources/Capture/`)

Menu bar app capturing the focused window on a configurable schedule (default every 15 seconds, weekdays; see `capture.*` in `user-config.json`) at 0.75 JPEG quality. Processing per tick:

1. `SkipPatterns` — blocklist check (bundle, keyword, window title)
2. `CaptureLoop.skipReason()` — skip if paused, outside the `CaptureSchedule`, or idle (`capture.idle_after_seconds`, default 300)
3. `CaptureLoop` — ScreenCaptureKit window-only screenshot (falls back to full display)
4. `ActiveContext` — extract app bundle, window title, browser URL (AppleScript), document path
5. `OCR` — Apple Vision text extraction, screenshot deletion after OCR. `Store` redacts secrets from every text field on write (`Redactor`); `Retention` sweeps leftovers and applies `capture.retention_days`
6. `Store` — SQLite insert

Event-driven monitors run alongside the timer:
- `AppSwitchMonitor` — NSWorkspace app-switch notifications
- `AXMonitor` — window focus + title changes (2s debounce)
- `FileMonitor` — NSMetadataQuery / Spotlight for modified files

### MCP Server (TypeScript, `apps/mcp/src/`)

32 tools, one module each in `tools/` (each exports `name`, `description`, a zod `inputSchema`, and `handler`); `server.ts` registers them in a loop. Uses `@modelcontextprotocol/sdk` + `node:sqlite`. Reads the shared SQLite database. All tool calls are automatically tracked via `tracked()` middleware for usage analytics.

**Data tools**: `recent_activity`, `summarize_window`, `standup_draft`, `context_timeline`, `code_time`
**Portfolio tools**: `create_project`, `get_project`, `link_evidence`, `triage_samples`, `delete_samples`
**Inbox tools**: `get_inbox` (mentions + PR review requests + top ranked to-dos), `mentions`
**To-do tools**: `todo_list`, `todo_add`, `todo_resolve`, `todo_snooze`, `run_detectors`
**Logging tools**: `log_standup`, `log_idea`, `list_ideas`
**Usage tools**: `log_usage`, `usage_stats`

Key tools support a `compact` parameter that omits large fields (ocr_excerpt, selected_texts, focused_elements) for responses that fit within LLM context windows. `summarize_window` also supports `merge_gap_min` (returns sessions instead of blocks) and `min_duration_min` (filters short blocks).

Key module: `summarize.ts` — three-level aggregation (Samples -> WorkBlocks -> Sessions) with JIRA ticket, PR URL, and file path extraction via regex. Supports `BlockOptions { compact?, min_duration_min? }` for server-side filtering.

### Database Schema (SQLite, WAL mode)

- **`samples`** — ~5,700/day at 15s interval. Fields: app_bundle, app_name, window_title, url, screenshot_path, ocr_text, active_seconds, is_evidence, document_path, selected_text, focused_element, visible_windows. Note: `active_seconds` and `visible_windows` are schema-present but unused by tools; `vision_summary` column exists but is no longer written to or read.
- **`context_events`** — event_type (app_switch, window_focus, title_change, file_modified), timestamp, app/window context
- **`projects`** — slug, name, description, status
- **`project_links`** — many-to-many between projects and external refs
- **`ideas`** — body, source, created_at
- **`standups`** — date (unique), yesterday/today/blockers
- **`commitments`** — source, source_ref (unique together), title, detail, detected_at, status ('open'|'snoozed'|'done'|'dismissed'), resolved_at/resolved_by
- **`tool_usage`** — called_at, kind ('tool'|'skill'), name, args_summary, duration_ms — tracks every MCP tool call and skill invocation for usage analytics

### Skills (`.claude/skills/`)

| Skill | Purpose |
|-------|---------|
| `/standup` | Draft Yesterday/Today/Blockers from captured data + GitHub activity |
| `/today` | Timeline of today's activity so far |
| `/cleanup-samples` | Triage samples: tag as evidence, keep, or delete |
| `/whats-next` | Recommend next action (stale PRs > mentions > ideas) |
| `/follow-ups` | Review @-mentions and PR review requests |
| `/log-idea` | Quick-capture idea with duplicate checking |
| `/capture` | Start/stop/check daemon status |

## Core Principles

- **Local-first and privacy-first.** No cloud sync, remote analytics, or external API transmission of captured data.
- **Never fabricate or approximate results.** Use real MCP tools, database, GitHub CLI, and capture pipeline. If a tool exists for a task, call it.
- **Treat captured data as sensitive.** Raw screenshots, OCR text, URLs, window titles, document paths — summarize and sanitize before exporting.
- **Destructive actions require explicit confirmation.** Never auto-delete. Evidence-tagged samples cannot be deleted.
- **Small, testable improvements over broad rewrites.**

## Public Repo: Private Data Lives Only in Local Config

This repo is public. Anything specific to the user, their employer, or their coworkers must never be committed: names, emails, usernames, company or org names, internal domains and URLs, repo names, Slack channels, ticket keys, internal documents (leveling guides, rubrics, values), registry URLs, local paths, or anything read from the user's captured data.

- **Code reads specifics from local config, never hardcodes them.** Per-user settings go in `user-config.json` in the data dir (`~/Library/Application Support/apotheosis/`, written by `setup.sh` / `/init`). Larger private files go next to it, e.g. the review rubric in `<data dir>/config/`. If a feature needs a company-specific value (a domain, an org, a document), add a config field with a generic default; do not put the real value in source.
- **Committed defaults and examples are generic.** Ship a working placeholder (like `config/promo-packet.yaml` and `config/leveling-example.yaml`) so the feature runs out of the box, and document where the user's own version goes.
- **Tests and fixtures use made-up data.** Match the real format (a Slack window title, a PR URL, a ticket key shape) but invent the details: `acme/widgets`, `acme.slack.com`, `WID-4582`, `Jane Doe`, `/Users/testuser/...`, `@example.com`. Never paste real captured rows, real names, or real channels into a test, even "just as an example". If a test needs the real value, the code should be reading it from config instead.
- **Comments and docs follow the same rule.** Examples in doc comments, skills, and prompts use placeholder names too.
- **Leak check.** `packages/core/test/privacy.test.ts` fails if any tracked file contains a term from `<data dir>/private-terms.txt` (one case-insensitive term per line, `#` for comments, never committed). Keep that file filled with your employer, org, internal hosts, and coworker names; the test skips when it is missing.

## Impact Evidence Priorities

Favor features that help turn real daily work into clear impact evidence for end-of-year self-reviews and performance reviews:

- Evidence tagging by growth area and review rubric
- Impact narrative generation from linked samples, PRs, Jira tickets, ideas, and projects
- Review-period exports for self-review narratives
- GitHub/Jira correlation for projects, epics, PRs, and cross-team work
- Async communication reminders and follow-up tracking
- Manager commitment tracking after 1:1s
- Sanitized Markdown exports for self-review narratives

When an existing open-source tool solves a gap better than Apotheosis, recommend it honestly.

## Safe Editing Guidance

**TypeScript MCP layer** — preferred for autonomous improvements:
- `apps/mcp/src/db.ts` — schema and migrations
- `apps/mcp/src/summarize.ts` — grouping, metadata extraction, evidence heuristics
- `apps/mcp/src/tools/*.ts` — individual tool implementations
- `apps/mcp/src/server.ts` — tool registration

**Swift capture app** — be cautious (OS permissions, screenshots, OCR, sensitive data):
- `apps/capture/Sources/Capture/CaptureLoop.swift` — capture interval, quality, window targeting
- `apps/capture/Sources/Capture/Store.swift` — schema DDL, insertSample/insertEvent
- Add or update tests before nontrivial capture refactors

## Build and Verification

```bash
# MCP server
pnpm --filter @apotheosis/core build && pnpm --filter apotheosis-mcp build

# Swift capture daemon
cd apps/capture && ./build.sh
```

**Always build the capture daemon with `apps/capture/build.sh`. Never run `swift build` directly.** `swift build` writes an ad-hoc-signed binary to `.build/arm64-apple-macosx/debug/Capture`, the same path launchd runs. Ad-hoc signatures change on every build, which invalidates the macOS TCC grants (Screen Recording, Accessibility, file access, microphone) and makes the permission dialogs reappear. `build.sh` re-signs with the stable "Apotheosis Capture Signing" identity so grants survive rebuilds. If it prints "falling back to ad-hoc signing", the cert is missing: stop and tell the user.

`build.sh` signs a copy and `mv`s it over the binary (fresh inode). Do not re-sign the binary in place with `codesign --force`: the kernel's cached signature goes stale and launchd's next spawn dies with `OS_REASON_CODESIGNING`.

After a rebuild, restart with `launchctl kickstart -k gui/$(id -u)/com.kealjones.apotheosis.capture`.

After data behavior changes, verify:
- Evidence-tagged rows are protected from deletion
- Private data is not exported raw
- Summaries distinguish captured evidence from inference

## Custom Instructions

<!-- This section is maintained by developers and agents during day-to-day work.
     It is NOT auto-generated by codebase-summary and MUST be preserved during refreshes.
     Add project-specific conventions, gotchas, and workflow requirements here. -->

- MCP tools now support `compact` mode that reduces response sizes by 70-98%. Skills should always use `compact: true` — no disk saves or `jq` extraction needed.
- The capture daemon does window-only screenshots (not full screen) at the configured interval (default 15s) with 0.75 JPEG quality.
- OCR quality is dramatically better with window-only capture — full readable conversations with names vs garbled pixel noise.
- FileMonitor generates ~11K file_modified events/day — may need tuning.
- The Vision/Ollama pipeline code has been removed (VisionSummarizer.swift, OllamaConfig.swift, ollama_status tool deleted). The `vision_summary` DB column remains but is unused.
