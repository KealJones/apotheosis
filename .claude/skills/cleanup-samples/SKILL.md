---
name: cleanup-samples
# prettier-ignore
description: Triage captured screen samples for a given date — tag as evidence, keep, or delete. Removes both the DB row and screenshot file from disk.
---

# /cleanup-samples [date]

Walk through a given date's screen samples and triage them: tag as evidence, keep raw, or delete. No auto-deletion — every destructive action requires your confirmation.

## Steps

0. Call `log_usage` with `{ skill: "cleanup-samples" }` (include the date arg if provided).
1. Parse the date arg (default: yesterday, format yyyy-mm-dd).
2. Call `triage_samples` with `{ date, compact: true }`.
   - Returns clusters: `{ app_name, window_title, sample_ids, start, end, duration_min, signal }`.
   - Sorted by signal desc (high → medium → low).

3. **Group clusters into categories** for faster triage rather than showing one-by-one. Present grouped tables:
   - **Work: PRs, JIRA, code** (high signal) — suggest Evidence with project slug
   - **Work: Slack, VS Code, meetings** (medium signal) — suggest Keep
   - **Personal browsing** (any signal, non-work content) — suggest Delete
   - **Low signal misc** (Finder, new tabs, brief blips) — suggest Delete

   For each category, show a table with app, window summary, sample count, and suggested action.

4. Execute actions for each category:
   - **Evidence**: call `link_evidence` with `{ project_slug, sample_ids }`.
     - Before linking, call `get_project` with the slug to check if it exists. If it doesn't exist (error or null result), automatically call `create_project` to create it (use the slug as the slug and a reasonable human-readable name derived from it), then proceed with `link_evidence`. Handle project creation silently — do not prompt the user.
   - **Keep**: no action (samples stay as-is).
   - **Personal browsing** and **Low signal misc**: call `delete_samples` automatically — no confirmation needed. These categories are always safe to delete.
   - **Ambiguous deletes** (anything not clearly personal or low-signal): show count, ask "Delete these [N] samples? (yes/no)". Only call `delete_samples` after explicit yes.
   - `delete_samples` removes both the SQLite row and the screenshot file from disk.

5. At the end, show a summary:
   ```
   Cleanup complete:
   - [N] linked as evidence
   - [N] kept
   - [N] deleted
   - [N] skipped
   ```

## Critical rules
- Auto-delete **personal browsing** and **low signal misc** — no confirmation needed.
- For anything else being deleted, always get explicit "yes" before calling `delete_samples`.
- `delete_samples` will refuse `is_evidence=1` rows — that's a server-side safeguard, but don't offer them for deletion in the first place.
- If a project slug doesn't exist when linking evidence, automatically create it with `create_project` before linking. Do not prompt the user.
- **Sensitive content filtering**: When presenting clusters, don't read out personal browsing content in detail — just summarize as "personal browsing" with a count.
- All tool calls use **compact mode** — responses fit in context, no disk saves needed.
