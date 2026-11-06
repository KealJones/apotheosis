# /whats-next

Recommend the single most important next action, based on current state.

## Steps

0. Call `log_usage` with `{ skill: "whats-next" }`.
1. Call `todo_list` with `{ limit: 1 }` — the single top-ranked open commitment across every
   source (standups, Slack, PRs, meetings, local git). Ranking already accounts for age,
   whether someone else is blocked on you, explicit promise vs. inferred, due proximity, and
   detector confidence (see `rankedCommitments.ts` if you need the exact weights) — do not
   re-derive priority from raw data yourself.

2. Synthesize a recommendation from the result:
   - If `todos` has an item, that item **is** the recommendation. Use its `title` for the
     one-sentence action, and build the "why" from `source` (e.g. "someone's waiting on
     you" for `github_review_requested`/`slack_ask`, "you said you would" for
     `slack_promise`), `counterparty` when present, and `age_days`. Include `source_url` as
     the clickable link if present.
   - If `todos` is empty, look at `total_open`: if it's 0, say "You're caught up — pick up
     where you left off. Run `/today` to see your recent context." If it's greater than 0
     (everything open is sitting below the confidence threshold, in the "maybe?" tray), say
     you're caught up on high-confidence items and mention the count so it's discoverable,
     e.g. "Nothing urgent — N low-confidence item(s) in the maybe tray, run `/today` for the
     full picture."

3. Output format:
   ```
   **Next action**: [one sentence]
   
   **Why**: [one sentence reasoning]
   
   [optional: 2-3 line context — counterparty, age, source link]
   ```

4. Keep total output under 10 lines. This runs automatically on session start — it must be fast and scannable.

## Notes
- This skill is triggered automatically by the SessionStart hook. Don't ask follow-up questions — just output the recommendation.
- If the MCP server isn't running or returns errors, say "apotheosis MCP unavailable — run `npm start` in apps/mcp/" and exit cleanly.
- Uses a single `todo_list` call — no disk saves needed.
