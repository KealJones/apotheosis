'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, buttonVariants } from '@/components/ui/button';
import { resolveCommitmentAction, snoozeCommitmentAction } from '@/app/commitments/actions';

const snoozeSelectClass =
  'h-7 rounded-lg border border-input bg-transparent px-2 text-xs dark:bg-input/30 focus-visible:ring-3 focus-visible:ring-ring/50 outline-none disabled:cursor-not-allowed disabled:opacity-50';

interface CommitmentRowActionsProps {
  id: number;
  sourceUrl: string | null;
}

/**
 * The four one-click row actions C6/C8 specify: Done / Snooze / Not a thing / Open source.
 * Only rendered for open/snoozed rows - a done/dismissed row is terminal (see runner.ts's
 * "terminal is terminal" rule), so there's nothing left to act on.
 */
export function CommitmentRowActions({ id, sourceUrl }: CommitmentRowActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function resolve(resolution: 'done' | 'not_a_thing', note: string) {
    setError(null);
    startTransition(async () => {
      const result = await resolveCommitmentAction(id, resolution, note);
      if (!result.success) {
        setError(result.error ?? 'Failed');
        return;
      }
      router.refresh();
    });
  }

  function snooze(until: string) {
    setError(null);
    startTransition(async () => {
      const result = await snoozeCommitmentAction(id, until);
      if (!result.success) {
        setError(result.error ?? 'Failed');
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => resolve('done', 'Marked done from dashboard')}
      >
        Done
      </Button>

      <select
        className={snoozeSelectClass}
        disabled={pending}
        defaultValue=""
        aria-label="Snooze until"
        onChange={(e) => {
          const value = e.target.value;
          e.target.value = '';
          if (value) snooze(value);
        }}
      >
        <option value="" disabled>
          Snooze&hellip;
        </option>
        <option value="tomorrow">Tomorrow</option>
        <option value="next monday">Next Monday</option>
        <option value="next week">Next week</option>
      </select>

      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => resolve('not_a_thing', 'Not a thing (dashboard)')}
      >
        Not a thing
      </Button>

      {sourceUrl && (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          Open source
        </a>
      )}

      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
