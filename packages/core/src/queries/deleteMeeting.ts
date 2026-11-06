import * as fs from 'fs';
import { getDb, transaction } from '../db.js';

export interface DeleteMeetingArgs {
  meeting_id: number;
}

interface MeetingRow {
  id: number;
  audio_path: string | null;
}

export interface DeleteMeetingResult {
  deleted: boolean;
  errors: string[];
  summary: string;
}

export function deleteMeeting(args: DeleteMeetingArgs): DeleteMeetingResult {
  const db = getDb();
  const errors: string[] = [];
  let deleted = false;

  transaction(db, () => {
    const row = db.prepare(
      'SELECT id, audio_path FROM meetings WHERE id = ?'
    ).get(args.meeting_id) as MeetingRow | undefined;

    if (!row) {
      errors.push(`Meeting ${args.meeting_id} not found.`);
      return;
    }

    // `meeting_segments.meeting_id` has ON DELETE CASCADE and `foreign_keys` is ON
    // (db.ts), but delete explicitly anyway so this doesn't silently depend on that
    // pragma staying set.
    db.prepare('DELETE FROM meeting_segments WHERE meeting_id = ?').run(args.meeting_id);
    db.prepare('DELETE FROM meetings WHERE id = ?').run(args.meeting_id);
    deleted = true;

    // `audio_path` is the meeting's directory (`<meeting_id>/{me,them}.caf`), not a
    // single file, and may already be null (audio deleted once transcription finished).
    if (row.audio_path) {
      try {
        if (fs.existsSync(row.audio_path)) {
          fs.rmSync(row.audio_path, { recursive: true, force: true });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Could not delete audio for meeting ${args.meeting_id}: ${msg}`);
      }
    }
  });

  return {
    deleted,
    errors,
    summary: deleted
      ? `Deleted meeting ${args.meeting_id}.`
      : `Meeting ${args.meeting_id} not found.`,
  };
}
