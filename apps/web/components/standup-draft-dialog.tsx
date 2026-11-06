'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet';
import { getStandupDraftAction, logStandupAction } from '@/app/standups/actions';

interface StandupDraftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function StandupDraftDialog({ open, onOpenChange, onSuccess }: StandupDraftDialogProps) {
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<any | null>(null);
  const [today, setToday] = useState('');
  const [blockers, setBlockers] = useState('');
  const [error, setError] = useState('');

  const handleGenerateDraft = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await getStandupDraftAction(selectedDate);
      if (result.success) {
        setDraft(result.data);
        setToday('');
        setBlockers('');
      } else {
        setError(result.error || 'Failed to generate draft');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!draft) return;

    setLoading(true);
    setError('');
    try {
      const result = await logStandupAction({
        date: draft.date,
        yesterday: draft.yesterday || '',
        today: today || undefined,
        blockers: blockers || undefined,
      });

      if (result.success) {
        onSuccess();
        onOpenChange(false);
        setDraft(null);
        setToday('');
        setBlockers('');
      } else {
        setError(result.error || 'Failed to save standup');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="max-w-2xl">
        <SheetHeader>
          <SheetTitle>Generate Standup</SheetTitle>
        </SheetHeader>

        <div className="space-y-4 py-4">
          {!draft ? (
            <>
              <div>
                <Label htmlFor="date">Date</Label>
                <Input
                  id="date"
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  disabled={loading}
                />
              </div>
              <Button onClick={handleGenerateDraft} disabled={loading} className="w-full">
                {loading ? 'Generating...' : 'Generate Draft'}
              </Button>
            </>
          ) : (
            <>
              <div>
                <Label>Date: {draft.date}</Label>
              </div>
              <div>
                <Label htmlFor="yesterday">Yesterday's Summary</Label>
                <p className="text-sm text-muted-foreground mt-2 max-h-32 overflow-y-auto">
                  {draft.yesterday || 'No summary available'}
                </p>
              </div>
              <div>
                <Label htmlFor="today">Today's Plans</Label>
                <Textarea
                  id="today"
                  placeholder="What are you planning to work on today?"
                  value={today}
                  onChange={(e) => setToday(e.target.value)}
                  disabled={loading}
                  rows={4}
                />
              </div>
              <div>
                <Label htmlFor="blockers">Blockers</Label>
                <Textarea
                  id="blockers"
                  placeholder="Any blockers or challenges?"
                  value={blockers}
                  onChange={(e) => setBlockers(e.target.value)}
                  disabled={loading}
                  rows={3}
                />
              </div>
              {draft.pending_commitments && draft.pending_commitments.length > 0 && (
                <div>
                  <Label>Pending Commitments</Label>
                  <div className="text-sm space-y-1">
                    {draft.pending_commitments.slice(0, 3).map((c: any) => (
                      <div key={c.id} className="text-muted-foreground">
                        - {c.title}
                      </div>
                    ))}
                    {draft.pending_commitments.length > 3 && (
                      <div className="text-muted-foreground">
                        + {draft.pending_commitments.length - 3} more
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          {error && <div className="text-sm text-red-500">{error}</div>}
        </div>

        <SheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          {draft && (
            <Button onClick={handleSave} disabled={loading}>
              {loading ? 'Saving...' : 'Save Standup'}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
