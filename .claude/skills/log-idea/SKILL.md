# /log-idea

Capture a quick idea into the inbox and surface possible duplicates.

## Steps

0. Call `log_usage` with `{ skill: "log-idea" }`.
1. The user invokes as `/log-idea <text>` — the args after the skill name are the idea body.
   - If no args: ask "What's the idea?" and wait for their reply.

2. Call MCP tool `log_idea` with `{ body: "<text>", source: "manual" }`.

3. The tool response includes:
   - The saved idea (id, body, created_at)
   - Any similar existing ideas (body LIKE first 20 chars)

4. If similar ideas exist, show them:
   ```
   Saved. Similar ideas already in your inbox:
   - [id] [date]: "[body]"
   ```
   Ask: "Same thing, or a new angle?"
   - If same: note it (no action needed — user can cluster later).
   - If new: confirm it's saved as a distinct entry.

5. If no duplicates: just confirm "Saved: [body]"

## Notes
- Keep responses short — this is a quick-capture tool. Don't generate prose or ask follow-up questions unless there are duplicates.
- Source should always be "manual" for this skill. The capture daemon uses "screen" and "hotkey".
