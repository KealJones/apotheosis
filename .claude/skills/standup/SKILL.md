---
name: standup
# prettier-ignore
description: Generate a standup from captured activity. Defaults to yesterday, but supports any date or time range.
---

0. **Log usage**: Call `log_usage` with `{ skill: "standup" }` (and include any args the user passed).

1. **Build the timeline** (context pass):
   - **Date range**: The user can specify any date, date range, or time range. Examples:
     - `/standup` → yesterday 00:00 to 23:59 local
     - `/standup monday` → that Monday 00:00 to 23:59
     - `/standup may 10-12` → May 10 00:00 to May 12 23:59
     - `/standup but include up till 3am today` → yesterday 00:00 to today 03:00
   - Default: yesterday 00:00:00 to 23:59:59 local (both ISO8601). **On Monday, "yesterday" means the previous Friday**, not Sunday. Use that date everywhere "yesterday" appears below (data pass, GitHub pass).
   - Adjust the **Yesterday** header to match the actual range (e.g. "Monday", "May 10–12", "Yesterday + Early AM").
   - Call `summarize_window` with `{ since, until, compact: true, min_duration_min: 2, merge_gap_min: 5 }`.
   - This returns pre-merged **sessions** (not blocks) with metadata including JIRA tickets and PR URLs.
   - Process the returned sessions into a mental timeline:
     - Note the time ranges, apps used, and any JIRA tickets or PR numbers in `metadata`.
   - This timeline is your context for writing the standup — do NOT output it directly.

2. **Get structured standup data** (data pass):
   - Call `standup_draft` with `{ compact: true, since, until }` (the same range as step 1).
   - Returns `yesterday_sessions`, `slack`, `claude_sessions`, `pending_commitments`, `open_prs`, `recent_ideas`, and `context_summary`.
   - **`slack` and `claude_sessions` are the highest-signal sources. Read them first.** Screen sessions only show which app was open; these show what the work was about.
     - `slack.my_threads`: every thread or conversation I posted in, with the root message, my messages and who else was in it. Each one is almost always a standup bullet (support questions answered, investigations, decisions).
     - `slack.read`: conversations I only read, with message counts. Mention them only when they add context (e.g. a long support thread I followed).
     - `claude_sessions`: Claude Code sessions in the range, with the project and my prompts. Use them to say what the Claude time was spent on. Skip personal projects.
   - The `yesterday_sessions` field is the timeline. Each session includes `window_titles`, `metadata.jira_tickets`, `metadata.pr_urls`, and `duration_min`.
   - The `context_summary.event_counts` shows how many app switches, window focus changes, title changes, and file modifications happened. Use this to enrich the narrative (e.g. "heavy context switching" if app_switch count is high).
   - The `context_summary.files_modified` lists files changed outside of git — useful for identifying work on docs, config, or non-code artifacts.

2b. **Get today's ranked to-do items** — call `todo_list` with `{ limit: 5 }`. These are
    higher-signal candidates for the "Today" section than a guessed continuation from
    yesterday's sessions: someone is plausibly waiting on each one. Keep the returned order
    (already ranked) and note each item's `id` — you'll need it in step 6 to link the
    standup back to the commitment it came from.

3. **Get GitHub activity** (GitHub pass):
   - Use the GitHub MCP server tools to fetch activity for yesterday's date range:
     - Search for PRs authored or merged yesterday (use `search_issues` or similar with date qualifiers)
     - Search for PR reviews given yesterday (use `gh api user -q .login` to get the current user's GitHub username for the `--reviewed-by` filter)
     - Search for issues created or commented on yesterday
   - **For EVERY PR that appears in either the screen timeline OR the `reviewed-by` search results**, fetch the full review list using the GitHub API:
     - `gh api repos/<owner>/<repo>/pulls/<number>/reviews --jq '.[] | {user: .user.login, state, submitted_at, body}'`
     - `gh api repos/<owner>/<repo>/pulls/<number>/comments --jq '.[] | select(.user.login == "<your-github-username>") | {body, created_at}'`
   - Do not skip a PR just because it had short screen time — if it appeared in `reviewed-by` results, fetch its reviews.
   - Incorporate any GitHub activity into the standup draft — PRs merged, reviews given, issues filed.
   - If the GitHub MCP server is unavailable or returns errors, skip this step gracefully and note it.

4. Draft standup prose using ALL three sources (timeline context from step 1, structured data from step 2, and GitHub activity from step 3):
   ```
   **Yesterday**
   <bullet per meaningful work session — use the timeline for sequencing, sessions for detail>

   **Today**
   <one bullet per item from step 2b's `todo_list`, in the order returned, phrased from its
   `title`/`detail` rather than paraphrased from scratch — these outrank guessed
   continuations because todo_list already knows someone's plausibly waiting. Then, if room
   remains within the 3-6 bullet max, add a bullet for an obvious continuation from
   yesterday's sessions that todo_list didn't surface (e.g. in-progress work with no
   detector coverage yet). Track, in order, which bullets came from a todo_list item and
   which were freehand — you need that mapping for step 6.>

   **Blockers**
   <pending follow-ups or PRs awaiting review, or "None">
   ```
   Keep it concise — 3-6 bullets per section max. This is for a Slack standup, not a novel.

   **PR link format:** When referencing pull requests, always link them as `[repo#number](url)` — e.g. `[widgets#2365](https://github.com/acme/widgets/pull/2365)`. Extract the repo name and PR number from window titles (which contain patterns like "Pull Request #2365 · acme/widgets") or from GitHub MCP results. The repo name should be just the repo (not org/repo).

   **PR review accuracy — use precise language based on actual evidence:**
   - Say **"approved"** if the review state is `APPROVED` (even if the body is just "+1" — that is still a real approval).
   - Say **"requested changes on"** if the review state is `CHANGES_REQUESTED`.
   - Say **"reviewed"** for a submitted `COMMENTED` review with substantive inline comments.
   - Say **"left comments on"** if there are inline PR comments but no submitted review object.
   - Say **"looked at"** or **"checked"** if the PR appeared in the screen timeline with 5–10+ minutes of focus time but GitHub shows no review activity.
   - Say nothing about a PR if it appeared only briefly (<5 min total in the timeline) and has no GitHub review activity — it was just a glance.
   - When the review body contains shorthand like "+1", "LGTM", or "QA +1", include that in the description (e.g. "approved [repo#N] (+1)").
   - Cross-reference: sum the `duration_min` for all timeline sessions whose window titles contain the PR number to get total time spent on that PR.

   **People and meetings:** Extract names from the data:
   - **Slack DMs**: Window titles contain full names — e.g. `"Jane Doe (She/Her) (DM)"`. Name who you were talking to.
   - **Google Meet**: Window titles show participants — e.g. `"Meet - Jane / Sam"`. Name the meeting and attendees.
   - **Slack channels**: Note which channels were active (e.g. #team-help, #frontend).
   - **Meeting context**: For meetings found in the timeline, if participant names are visible in window titles or session metadata, include them. If more detail is needed, make a separate non-compact `summarize_window` call scoped to just the meeting time range to get OCR excerpts with participant names.

   **Sensitive content filtering:** Omit clearly personal/non-work activity from the standup — job searches, personal browsing, non-work Messages conversations, etc. If it wouldn't belong in a team standup, leave it out.

5. Surface any pending follow-ups using `get_inbox`:
   - Call `get_inbox` (uses default 48h lookback for mentions).
   - Display inline after the standup:
   ```
   **Needs attention:**
   - @mention from [app] at [time]: [context]
   - PR review: [title] — [url]
   ```

6. **Auto-log the standup** — call `log_standup` immediately with `date` (today's date), `yesterday`, `today`, and `blockers` sections as strings, plus `today_commitment_ids`: an array parallel to the "Today" section's bullets, in order — the `id` from the `todo_list` item that produced each bullet, or `null` for a freehand bullet (from the mapping you tracked in step 4). This is what finally populates `standup_items.commitment_id`, so tomorrow's standup-carryover detector can reconcile these items directly instead of re-deriving the match through fuzzy text comparison — the standup now both consumes and produces commitments. Do not ask for confirmation. Mention at the end that it was logged.

Do not run `/cleanup-samples` as part of the standup. Deleting samples is a separate, deliberate step.

## Notes
- If no samples exist for yesterday, say so clearly and suggest running `/today` to see if capture is working.
- Don't fabricate activity. Only report what the MCP data shows.
- The pass approach (summarize_window → standup_draft → todo_list → GitHub MCP) gives you timeline context, Slack and Claude Code activity, ranked to-do items, and GitHub activity. Use `slack` and `claude_sessions` for what the work was, the timeline for sequencing, todo_list for what goes in "Today", and GitHub data for code contributions.
- Any PR review I left counts, whatever its state.
- All tool calls use **compact mode** and return responses small enough to fit in context. No disk saves or jq extraction needed.
