'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { getStandupDraftAction, logStandupAction } from '@/app/standups/actions';

interface StandupPanelInitial {
  yesterday: string | null;
  today: string | null;
  blockers: string | null;
}

interface StandupPanelProps {
  /** Local YYYY-MM-DD, resolved server-side (see lib/date.ts). */
  today: string;
  /** Set only when a standup row already exists for `today` (see app/page.tsx). */
  initial: StandupPanelInitial | null;
}

/**
 * Inline standup panel for `/` (C8) - an editable form directly in the panel rather than
 * reusing StandupDraftDialog's sheet, per the plan's call: a "glance and edit" panel reads
 * better inline than behind an open-a-sheet step. Reuses the same underlying server actions
 * as the dialog (getStandupDraftAction / logStandupAction from app/standups/actions.ts) so
 * there's exactly one write path for standups, not two.
 */
export function StandupPanel({ today, initial }: StandupPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(initial != null);
  const [yesterday, setYesterday] = useState(initial?.yesterday ?? '');
  const [todayText, setTodayText] = useState(initial?.today ?? '');
  const [blockers, setBlockers] = useState(initial?.blockers ?? '');

  function generateDraft() {
    setError(null);
    startTransition(async () => {
      const result = await getStandupDraftAction(today);
      if (!result.success || !result.data) {
        setError(result.error ?? 'Failed to generate draft');
        return;
      }
      setYesterday(result.data.yesterday ?? '');
      setLoaded(true);
    });
  }

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await logStandupAction({
        date: today,
        yesterday,
        today: todayText || undefined,
        blockers: blockers || undefined,
      });
      if (!result.success) {
        setError(result.error ?? 'Failed to save standup');
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  if (!loaded) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-muted-foreground">No standup logged for {today} yet.</p>
        <Button size="sm" onClick={generateDraft} disabled={pending}>
          {pending ? 'Generating…' : 'Generate draft'}
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Yesterday</p>
        <p className="max-h-24 overflow-y-auto whitespace-pre-line text-sm text-muted-foreground">
          {yesterday || 'No summary available.'}
        </p>
      </div>
      <div>
        <label htmlFor="standup-panel-today" className="mb-1 block text-xs font-medium text-muted-foreground">
          Today
        </label>
        <Textarea
          id="standup-panel-today"
          value={todayText}
          onChange={(e) => setTodayText(e.target.value)}
          disabled={pending}
          rows={3}
          placeholder="What are you planning to work on today?"
        />
      </div>
      <div>
        <label htmlFor="standup-panel-blockers" className="mb-1 block text-xs font-medium text-muted-foreground">
          Blockers
        </label>
        <Textarea
          id="standup-panel-blockers"
          value={blockers}
          onChange={(e) => setBlockers(e.target.value)}
          disabled={pending}
          rows={2}
          placeholder="Any blockers?"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {saved && !pending && <span className="text-xs text-muted-foreground">Saved.</span>}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </div>
  );
}
