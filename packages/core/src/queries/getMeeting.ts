import { getDb } from '../db.js';

export interface GetMeetingArgs {
  meeting_id: number;
  include_transcript?: boolean;
}

interface MeetingRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  platform: string | null;
  external_id: string | null;
  title: string | null;
  url: string | null;
  calendar_event_id: string | null;
  audio_path: string | null;
  transcript_status: string;
  summary: string | null;
  summary_model: string | null;
  summary_generated_at: number | null;
  action_items: string | null;
  participants: string | null;
}

interface SegmentRow {
  started_ms: number;
  channel: string;
  speaker: string | null;
  text: string;
}

export interface TranscriptLine {
  time: string;
  speaker: string;
  text: string;
}

export interface GetMeetingResult {
  id: number;
  title: string | null;
  start: string;
  end: string | null;
  duration_seconds: number | null;
  platform: string | null;
  url: string | null;
  summary: string | null;
  summary_model: string | null;
  summary_generated_at: string | null;
  action_items: unknown | null;
  participants: unknown | null;
  transcript_status: string;
  segment_count: number;
  has_summary: boolean;
  transcript?: TranscriptLine[];
}

/**
 * Get a single meeting by ID, with optional full transcript.
 * Transcript is rendered as [mm:ss] speaker: text lines.
 */
export function getMeeting(args: GetMeetingArgs): GetMeetingResult {
  const db = getDb();

  const meeting = db.prepare(`
    SELECT id, started_at, ended_at, platform, external_id, title, url,
           calendar_event_id, audio_path, transcript_status, summary,
           summary_model, summary_generated_at, action_items, participants
    FROM meetings
    WHERE id = ?
  `).get(args.meeting_id) as MeetingRow | undefined;

  if (!meeting) {
    throw new Error(`Meeting ${args.meeting_id} not found`);
  }

  // Get segment count and optionally the full transcript
  const segments = db.prepare(`
    SELECT started_ms, channel, speaker, text
    FROM meeting_segments
    WHERE meeting_id = ?
    ORDER BY started_ms ASC
  `).all(meeting.id) as SegmentRow[];

  let actionItems: unknown = null;
  let participants: unknown = null;

  // Parse JSON fields defensively
  if (meeting.action_items) {
    try {
      actionItems = JSON.parse(meeting.action_items);
    } catch {
      actionItems = null;
    }
  }
  if (meeting.participants) {
    try {
      participants = JSON.parse(meeting.participants);
    } catch {
      participants = null;
    }
  }

  const result: GetMeetingResult = {
    id: meeting.id,
    title: meeting.title,
    start: new Date(meeting.started_at * 1000).toISOString(),
    end: meeting.ended_at != null ? new Date(meeting.ended_at * 1000).toISOString() : null,
    duration_seconds: meeting.ended_at != null ? meeting.ended_at - meeting.started_at : null,
    platform: meeting.platform,
    url: meeting.url,
    summary: meeting.summary,
    summary_model: meeting.summary_model,
    summary_generated_at:
      meeting.summary_generated_at != null
        ? new Date(meeting.summary_generated_at * 1000).toISOString()
        : null,
    action_items: actionItems,
    participants: participants,
    transcript_status: meeting.transcript_status,
    segment_count: segments.length,
    has_summary: meeting.summary != null && meeting.summary.length > 0,
  };

  if (args.include_transcript && segments.length > 0) {
    result.transcript = segments.map(seg => {
      const mins = Math.floor(seg.started_ms / 60000);
      const secs = Math.floor((seg.started_ms % 60000) / 1000);
      const time = `${mins}:${String(secs).padStart(2, '0')}`;
      // Prefer speaker name if available; otherwise use channel
      const speaker = seg.speaker || seg.channel;
      return {
        time,
        speaker,
        text: seg.text,
      };
    });
  }

  return result;
}
