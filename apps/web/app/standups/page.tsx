'use client';

import { useState, useEffect } from 'react';
import { PageShell } from '@/components/page-shell';
import { StandupDraftDialog } from '@/components/standup-draft-dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { listStandupsAction } from './actions';

interface Standup {
  date: string;
  yesterday: string | null;
  today: string | null;
  blockers: string | null;
  generated_at: string;
}

export default function StandupsPage() {
  const [standups, setStandups] = useState<Standup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draftDialogOpen, setDraftDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const loadStandups = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await listStandupsAction(100, 0);
      if (result.success && result.data) {
        setStandups(result.data.standups);
      } else {
        setError(result.error || 'Failed to load standups');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStandups();
  }, []);

  const filteredStandups = standups.filter((s) =>
    s.date.includes(searchQuery) ||
    s.today?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.blockers?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <PageShell title="Standups">
      <div className="space-y-4">
        <div className="flex gap-3">
          <Input
            placeholder="Search standups..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="max-w-sm"
          />
          <Button onClick={() => setDraftDialogOpen(true)}>Generate for Date</Button>
        </div>

        {error && <div className="text-sm text-red-500">{error}</div>}

        {loading ? (
          <div className="text-sm text-muted-foreground">Loading standups...</div>
        ) : filteredStandups.length === 0 ? (
          <div className="text-sm text-muted-foreground">No standups found</div>
        ) : (
          <div className="space-y-2">
            {filteredStandups.map((standup) => (
              <Card key={standup.date} className="p-4">
                <div className="flex justify-between items-start gap-4">
                  <div className="flex-1">
                    <h3 className="font-semibold">{standup.date}</h3>
                    {standup.today && (
                      <div className="text-sm mt-2">
                        <p className="font-medium">Today:</p>
                        <p className="text-muted-foreground">{standup.today}</p>
                      </div>
                    )}
                    {standup.blockers && (
                      <div className="text-sm mt-2">
                        <p className="font-medium">Blockers:</p>
                        <p className="text-muted-foreground">{standup.blockers}</p>
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(standup.generated_at).toLocaleDateString()}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <StandupDraftDialog
        open={draftDialogOpen}
        onOpenChange={setDraftDialogOpen}
        onSuccess={loadStandups}
      />
    </PageShell>
  );
}
