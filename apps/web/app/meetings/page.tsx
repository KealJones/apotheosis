'use client';

import { useState, useEffect } from 'react';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { listMeetingsAction } from './actions';
import Link from 'next/link';

interface Meeting {
  id: number;
  title: string | null;
  start: string;
  duration_seconds: number | null;
  platform: string | null;
  has_summary: boolean;
  segment_count: number;
}

export default function MeetingsPage() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const loadMeetings = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await listMeetingsAction();
      if (result.success && result.data) {
        setMeetings(result.data.meetings);
      } else {
        setError(result.error || 'Failed to load meetings');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMeetings();
  }, []);

  const filteredMeetings = meetings.filter((m) =>
    m.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    m.platform?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return '-';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  return (
    <PageShell title="Meetings">
      <div className="space-y-4">
        <Input
          placeholder="Search meetings..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="max-w-sm"
        />

        {error && <div className="text-sm text-red-500">{error}</div>}

        {loading ? (
          <div className="text-sm text-muted-foreground">Loading meetings...</div>
        ) : filteredMeetings.length === 0 ? (
          <div className="text-sm text-muted-foreground">No meetings found</div>
        ) : (
          <div className="space-y-2">
            {filteredMeetings.map((meeting) => (
              <Link key={meeting.id} href={`/meetings/${meeting.id}`}>
                <Card className="p-4 hover:bg-accent transition-colors cursor-pointer">
                  <div className="flex justify-between items-start gap-4">
                    <div className="flex-1">
                      <h3 className="font-semibold">
                        {meeting.title || 'Untitled Meeting'}
                      </h3>
                      <div className="flex gap-2 mt-2">
                        {meeting.platform && (
                          <Badge variant="outline">{meeting.platform}</Badge>
                        )}
                        {meeting.has_summary && (
                          <Badge variant="secondary">Has Summary</Badge>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {meeting.segment_count} segments
                        </span>
                      </div>
                    </div>
                    <div className="text-right text-sm text-muted-foreground whitespace-nowrap">
                      <div>{new Date(meeting.start).toLocaleDateString()}</div>
                      <div>{new Date(meeting.start).toLocaleTimeString()}</div>
                      <div className="text-xs mt-1">{formatDuration(meeting.duration_seconds)}</div>
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}
