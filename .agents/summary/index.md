# Apotheosis Documentation Index

> **For AI assistants**: Start here. This index tells you which file to read for any given task.

## Quick Reference

| Question | Read |
|----------|------|
| What is this project? | `AGENTS.md` (overview) or `README.md` (user guide) |
| How does the capture pipeline work? | `AI_CONTEXT.md` > "Capture pipeline" |
| How does data flow from samples to standups? | `AI_CONTEXT.md` > "Three-level aggregation" |
| What MCP tools are available? | `AI_CONTEXT.md` > "MCP tools" or `apps/mcp/src/server.ts` |
| What skills/slash commands exist? | `.claude/skills/` — each has a `SKILL.md` |
| What are the project rules? | `CLAUDE.md` (3 rules) + `AGENTS.md` (core principles) |
| How do I build? | `AGENTS.md` > "Build and Verification" |
| What's the DB schema? | `apps/mcp/src/db.ts` |
| What's the promotion evidence model? | `AGENTS.md` > "Promotion Evidence Priorities" |

## Documentation Files

- **`AGENTS.md`** — Primary context for AI agents. Project overview, architecture, safe editing, build commands.
- **`AI_CONTEXT.md`** — Deep technical reference. Data model, capture pipeline, summarization logic, secret redaction, modification patterns.
- **`CLAUDE.md`** — Project rules (no fabrication, use real tools, treat data as sensitive).
- **`README.md`** — User-facing guide with setup, daily workflow, architecture diagram.
