'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { getMeetingAction, summarizeMeetingAction, deleteMeetingAction, searchMeetingsAction } from '../actions';

interface TranscriptLine {
  time: string;
  speaker: string;
  text: string;
}

interface Meeting {
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
  action_items: any | null;
  participants: any | null;
  transcript_status: string;
  segment_count: number;
  has_summary: boolean;
  transcript?: TranscriptLine[];
}

interface MeetingSummary {
  title: string;
  key_points: string[];
  action_items: Array<{ task: string; assignee?: string }>;
}

export default function MeetingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const meetingId = parseInt(params.id as string);

  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summarizing, setSummarizing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [transcriptSearch, setTranscriptSearch] = useState('');

  const loadMeeting = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await getMeetingAction(meetingId);
      if (result.success && result.data) {
        setMeeting(result.data);
      } else {
        setError(result.error || 'Failed to load meeting');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMeeting();
  }, [meetingId]);

  const handleSummarize = async (force: boolean = false) => {
    setSummarizing(true);
    setError('');
    try {
      const result = await summarizeMeetingAction(meetingId, force);
      if (result.success) {
        // Reload meeting to get updated summary
        const getResult = await getMeetingAction(meetingId);
        if (getResult.success && getResult.data) {
          setMeeting(getResult.data);
        }
      } else {
        setError(result.error || 'Failed to summarize meeting');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSummarizing(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this meeting?')) return;

    setDeleting(true);
    setError('');
    try {
      const result = await deleteMeetingAction(meetingId);
      if (result.success) {
        router.push('/meetings');
      } else {
        setError(result.error || 'Failed to delete meeting');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setDeleting(false);
    }
  };

  const filteredTranscript = meeting?.transcript?.filter((line) =>
    line.text.toLowerCase().includes(transcriptSearch.toLowerCase()) ||
    line.speaker.toLowerCase().includes(transcriptSearch.toLowerCase())
  );

  if (loading) {
    return (
      <PageShell title="Meeting">
        <div className="text-sm text-muted-foreground">Loading meeting...</div>
      </PageShell>
    );
  }

  if (!meeting) {
    return (
      <PageShell title="Meeting">
        <div className="text-sm text-red-500">Meeting not found</div>
      </PageShell>
    );
  }

  let summary: MeetingSummary | null = null;
  if (meeting.summary) {
    try {
      summary = JSON.parse(meeting.summary);
    } catch {
      // Summary is not valid JSON, will display as raw text
    }
  }

  return (
    <PageShell title={meeting.title || 'Meeting'}>
      <div className="space-y-6">
        {error && <div className="text-sm text-red-500">{error}</div>}

        {/* Meeting header */}
        <Card className="p-4">
          <div className="space-y-3">
            <h1 className="text-2xl font-bold">{meeting.title || 'Untitled Meeting'}</h1>
            <div className="flex flex-wrap gap-2">
              {meeting.platform && <Badge>{meeting.platform}</Badge>}
              <Badge variant="outline">
                {new Date(meeting.start).toLocaleDateString()}{' '}
                {new Date(meeting.start).toLocaleTimeString()}
              </Badge>
              {meeting.duration_seconds && (
                <Badge variant="outline">
                  {Math.floor(meeting.duration_seconds / 60)}m
                </Badge>
              )}
              <Badge variant={meeting.has_summary ? 'default' : 'secondary'}>
                {meeting.transcript_status}
              </Badge>
            </div>
            {meeting.url && (
              <p>
                <a href={meeting.url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
                  Meeting Link
                </a>
              </p>
            )}
          </div>
        </Card>

        {/* Action buttons */}
        <div className="flex gap-2">
          {!meeting.has_summary ? (
            <Button onClick={() => handleSummarize(false)} disabled={summarizing}>
              {summarizing ? 'Summarizing...' : 'Generate Summary'}
            </Button>
          ) : (
            <Button onClick={() => handleSummarize(true)} variant="outline" disabled={summarizing}>
              {summarizing ? 'Regenerating...' : 'Regenerate Summary'}
            </Button>
          )}
          <Button onClick={handleDelete} variant="destructive" disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </div>

        {/* Summary section */}
        {meeting.has_summary && summary && (
          <Card className="p-4 space-y-3">
            <h2 className="text-lg font-semibold">Summary</h2>
            {summary.key_points && summary.key_points.length > 0 && (
              <div>
                <h3 className="font-medium mb-2">Key Points:</h3>
                <ul className="list-disc list-inside space-y-1">
                  {summary.key_points.map((point, i) => (
                    <li key={i} className="text-sm">
                      {point}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {summary.action_items && summary.action_items.length > 0 && (
              <div>
                <h3 className="font-medium mb-2">Action Items:</h3>
                <ul className="list-disc list-inside space-y-1">
                  {summary.action_items.map((item, i) => (
                    <li key={i} className="text-sm">
                      {item.task}
                      {item.assignee && <span className="text-muted-foreground"> ({item.assignee})</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {meeting.summary_generated_at && (
              <p className="text-xs text-muted-foreground">
                Generated {new Date(meeting.summary_generated_at).toLocaleString()} via {meeting.summary_model}
              </p>
            )}
          </Card>
        )}

        {/* Transcript section */}
        {meeting.segment_count > 0 && (
          <Card className="p-4 space-y-3">
            <h2 className="text-lg font-semibold">Transcript ({meeting.segment_count} segments)</h2>
            <Input
              placeholder="Search transcript..."
              value={transcriptSearch}
              onChange={(e) => setTranscriptSearch(e.target.value)}
            />
            <div className="max-h-96 overflow-y-auto space-y-2">
              {filteredTranscript && filteredTranscript.length > 0 ? (
                filteredTranscript.map((line, i) => (
                  <div key={i} className="text-sm py-2">
                    <span className="font-medium text-xs text-muted-foreground">[{line.time}]</span>
                    <span className="font-medium ml-2">
                      {line.speaker === 'me' ? (
                        <span className="text-blue-600">You:</span>
                      ) : line.speaker === 'them' ? (
                        <span className="text-gray-600">Other:</span>
                      ) : (
                        <span>{line.speaker}:</span>
                      )}
                    </span>
                    <span className="ml-2">{line.text}</span>
                  </div>
                ))
              ) : (
                <div className="text-sm text-muted-foreground">No results found</div>
              )}
            </div>
          </Card>
        )}

        {/* Metadata section */}
        <Card className="p-4 space-y-2 text-sm">
          <h3 className="font-semibold">Metadata</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-muted-foreground">Participants</p>
              <p>
                {meeting.participants
                  ? typeof meeting.participants === 'string'
                    ? meeting.participants
                    : Array.isArray(meeting.participants)
                      ? meeting.participants.join(', ')
                      : 'Unknown'
                  : 'Not recorded'}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Transcript Status</p>
              <p>{meeting.transcript_status}</p>
            </div>
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
