import { getDb } from '../db.js';

export interface LinkMeetingCalendarEventArgs {
  meeting_id: number;
  calendar_event_id: string;
  title?: string;
  participants?: string[];
}

export type LinkMeetingCalendarEventResult =
  | { error: string }
  | { status: 'linked'; meeting_id: number; calendar_event_id: string }
  | { status: 'already_linked'; meeting_id: number; calendar_event_id: string };

/**
 * Additive, idempotent calendar correlation. Only ever sets
 * `calendar_event_id` when it is currently NULL — an existing correlation is
 * never overwritten, so calling this twice (or the skill re-running over the
 * same meeting on a later pass) is always safe. `title`/`participants` are
 * populated in the same guarded UPDATE, since they're part of the one
 * correlation event, not touched again afterwards; `COALESCE` additionally
 * protects any pre-existing title if the caller omits it.
 */
export function linkMeetingCalendarEvent(
  args: LinkMeetingCalendarEventArgs
): LinkMeetingCalendarEventResult {
  const db = getDb();

  const row = db.prepare(
    'SELECT id, calendar_event_id FROM meetings WHERE id = ?'
  ).get(args.meeting_id) as { id: number; calendar_event_id: string | null } | undefined;

  if (!row) {
    return { error: `Meeting ${args.meeting_id} not found.` };
  }

  if (row.calendar_event_id != null) {
    return {
      status: 'already_linked',
      meeting_id: args.meeting_id,
      calendar_event_id: row.calendar_event_id,
    };
  }

  const participantsJson = args.participants ? JSON.stringify(args.participants) : null;

  db.prepare(
    `UPDATE meetings
     SET calendar_event_id = ?,
         title = COALESCE(?, title),
         participants = COALESCE(?, participants)
     WHERE id = ? AND calendar_event_id IS NULL`
  ).run(args.calendar_event_id, args.title ?? null, participantsJson, args.meeting_id);

  return {
    status: 'linked',
    meeting_id: args.meeting_id,
    calendar_event_id: args.calendar_event_id,
  };
}
