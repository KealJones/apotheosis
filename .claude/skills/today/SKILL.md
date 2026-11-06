# /today

Show a human-readable timeline of what you've done so far today.

## Steps

0. Call `log_usage` with `{ skill: "today" }`.
1. Compute `since` = today at 00:00:00 local time (ISO8601).
2. Call `summarize_window` with `{ since, until: <now ISO>, compact: true, merge_gap_min: 5 }`.
   - This returns pre-merged **sessions** with metadata (JIRA tickets, PR URLs).
3. Format as a timeline:
   ```
   ## Today's timeline — [date]
   
   [HH:mm – HH:mm] **[App Name]** — [window title(s)] (X min)
   [HH:mm – HH:mm] **[App Name]** — [window title(s)] (X min)
   ...
   ```
   - Sessions are already merged by app within 5-min gaps — no additional merging needed.
   - Show duration in parens: `(42 min)`.
   - If metadata has a JIRA ticket ID or PR number, include it: `(42 min • PLAT-1234)`.

4. After the timeline, call `context_timeline` with `{ since: <today 00:00 ISO>, until: <now ISO> }` to get event-driven data.

5. Show a summary block after the timeline:
   ```
   Total tracked: X hours Y min across Z apps
   Context: N app switches · M window focus changes · K files modified
   ```
   - Only show context line if there are any context events.
   - If `files_modified` events exist, optionally list a few notable ones (skip node_modules, .git, etc.).

6. Call `todo_list` with `{}` (defaults: top 7, no maybe tray) and show it as its own section
   **after** the summary block — this is additive alongside the timeline, not a replacement
   for anything above:
   ```
   ## To-Do
   [source badge] Title — counterparty, age_days old
   ...
   ```
   - One line per item in `todos`, in the order returned (already ranked).
   - If `todos` is empty, show "Nothing ranked right now — run `/whats-next` or check `total_open`" only if `total_open` > 0; otherwise omit the section entirely.

7. If no samples exist for today, say: "No samples captured yet today. Is the capture daemon running? Check the menu bar icon."

## Notes
- This is a read-only, orientation skill. No follow-up questions.
- Use it when you come back to your desk after a break and need context fast.
- All tool calls use **compact mode** — responses fit in context, no disk saves needed.
