---
name: calendar-correlation
# prettier-ignore
description: Match captured meetings to Google Calendar events by start time to fill in the real title and attendee list. Meant to be run periodically (e.g. via /loop or a scheduled task), not on demand.
---

0. **Log usage**: Call `log_usage` with `{ skill: "calendar-correlation" }`.

1. **Find candidates**: Call `list_uncorrelated_meetings`. This returns every meeting with
   `calendar_event_id IS NULL` — id, title, start/end (ISO8601), url, and platform.
   - If it returns zero meetings, say so briefly and stop. Nothing else to do.

2. **Find the calendar tool**: The calendar MCP server's tools may be deferred in this
   session. If `list_events` isn't already loaded, use `ToolSearch` (e.g.
   `"select:mcp__<calendar-server-id>__list_events"`, or search by keyword `"calendar list
   events"` if you don't know the server id) to load it before calling it. Use `list_events`,
   not `search_events` — `search_events` is keyword/semantic search with no time-range
   parameter, and matching here is purely by timestamp.

3. **For each candidate meeting, one at a time:**
   a. Compute a ±5 minute window around the meeting's `start`: `startTime = start - 5min`,
      `endTime = start + 5min` (ISO8601, UTC is fine — `list_events` accepts any ISO8601
      offset).
   b. Call `list_events` with that `startTime`/`endTime` (and `orderBy: "startTime"`). Omit
      `calendarId` to use the primary calendar unless the user has said otherwise.
   c. Look at the returned `events[]`. Each event has `id`, `summary` (title), `start.dateTime`
      / `end.dateTime`, and `attendees[]` (each with `email`, optional `displayName`,
      optional `resource: true` for meeting-room/resource calendars — exclude those from the
      participant list).
   d. **Match rule**: an event matches if `|event.start.dateTime - meeting.start| <= 5
      minutes`. If more than one event matches, pick the one with the smallest time
      difference; if still tied, skip the meeting rather than guessing (leave it for the next
      run — a human can correlate it manually via `link_meeting_calendar_event` if needed).
   e. **No match**: leave the meeting alone. Do not error, do not retry within this run —
      just move to the next candidate. This is expected and common (personal blocks, calls
      outside the calendar, etc.).
   f. **Match found**: build the participant list from `attendees[]`, preferring
      `displayName` when present, otherwise deriving a readable name from the email's local
      part (e.g. `jane.doe@example.com` → `"jane doe"`). Drop resource/room attendees.
      Then call `link_meeting_calendar_event` with:
      ```
      { meeting_id, calendar_event_id: event.id, title: event.summary, participants: [...names] }
      ```
      This is additive and idempotent server-side — it only ever sets `calendar_event_id`
      when it's currently NULL, so calling it again on an already-linked meeting is always
      safe and won't clobber a prior correlation.

4. **Summarize**: report how many meetings were linked, how many had no match, in one or two
   short lines. Don't list every meeting unless asked.

## Notes
- This skill is designed to run **periodically**, not interactively — e.g. `/loop 30m
  /calendar-correlation` or a scheduled task, since new meetings and new calendar events both
  accumulate over time. Running it repeatedly is safe: matched meetings drop out of
  `list_uncorrelated_meetings` on the next pass, and the linking call is idempotent.
- Only ever touches `calendar_event_id`, `title`, and `participants`, and only on the single
  linking call for a given meeting — it never modifies `transcript_status`, `summary`,
  `action_items`, or anything else on the row.
- Matching is by timestamp only. It does not attempt to disambiguate same-time events by
  platform/URL — if that turns out to be a real problem (e.g. two meetings starting within
  the same 5-minute window), that's a follow-up refinement, not something this skill
  currently handles.
