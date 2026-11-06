import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { CommitmentRowActions } from '@/components/commitments/commitment-row-actions';
import type { TodoItem } from '@/lib/data';

interface TodoPanelProps {
  todos: TodoItem[];
  totalOpen: number;
}

/**
 * Today's To-Do panel (C6/C8): the ranked, capped-at-7 list from `getTodoList`. Purely
 * presentational over server-fetched props - after a row action mutates the DB,
 * `CommitmentRowActions` calls `router.refresh()`, which re-runs `app/page.tsx` and passes
 * fresh `todos` back down; no client-side state to keep in sync here.
 */
export function TodoPanel({ todos, totalOpen }: TodoPanelProps) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {totalOpen} open across every source
        {todos.length < totalOpen ? ` - showing the top ${todos.length}` : ''}.
      </p>

      {todos.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing open right now - either genuinely caught up, or detectors haven&rsquo;t run yet
          (see the scheduled runner in the README).
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {todos.map((t) => (
            <li key={t.id} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge variant="outline">{t.source}</Badge>
                    {t.counterparty && <span>{t.counterparty}</span>}
                    <span>{t.age_days}d old</span>
                    {t.due_hint && <span>due {t.due_hint}</span>}
                  </p>
                </div>
              </div>
              <div className="mt-2">
                <CommitmentRowActions id={t.id} sourceUrl={t.source_url} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <Link href="/commitments" className="self-start text-xs text-primary underline underline-offset-4">
        View full ledger &rarr;
      </Link>
    </div>
  );
}
