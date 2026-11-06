# /follow-ups

Review your pending @mentions, PR review requests, and follow-up items. Mark each as acknowledged or resolved.

## Steps

0. Call `log_usage` with `{ skill: "follow-ups" }`.
1. Call `get_inbox` — returns compact mentions, pending PR reviews, and open follow-ups in one call.

2. Display mentions grouped by app:
   ```
   **@-mentions (last 48h)**
   
   [App] — [window_title] ([count] mentions, first: [time], last: [time])
   ```

3. Display open PRs:
   ```
   **PRs awaiting review**
   - [#number] [title] — [url] (last updated [date])
   ```

4. Display open follow-ups:
   ```
   **Open follow-ups**
   - #[id] [source]: [title] (detected [time])
   ```

5. For each follow-up item, ask: "[D]one | d[I]smiss | [N]ot a thing | [S]kip"
   - Done: call `todo_resolve` with `{ id, resolution: "done", note }`.
   - Dismiss: call `todo_resolve` with `{ id, resolution: "dismissed", note }`.
   - Not a thing (should never have been detected): `{ id, resolution: "not_a_thing", note }`.
   - Skip: do nothing. `note` is a one-line reason; ask for one if the user didn't give it.

6. For PR reviews: no persistence yet — just remind the user which ones are stale.

## Notes
- This is surfaced automatically by `/standup` and `/whats-next`, but you can run it standalone any time.
- Mention detection has blind spots: it only sees text that was on-screen during a sample (every 15s by default) and caught by OCR. Missed DMs or quickly-dismissed notifications won't appear here.
- Uses `get_inbox` for a single compact call — no disk saves needed.
