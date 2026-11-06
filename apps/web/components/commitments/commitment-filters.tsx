'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

const selectClass =
  'h-8 rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30 focus-visible:ring-3 focus-visible:ring-ring/50 outline-none';

interface CommitmentFiltersProps {
  sources: readonly string[];
  statuses: readonly string[];
  source: string;
  status: string;
}

/** Source/status filter pickers for /commitments, backed by URL params so a filtered view is linkable. */
export function CommitmentFilters({ sources, statuses, source, status }: CommitmentFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function set(key: 'source' | 'status', value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'all') {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        Source
        <select
          className={selectClass}
          value={source}
          onChange={(e) => set('source', e.target.value)}
          aria-label="Filter by source"
        >
          <option value="all">All sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        Status
        <select
          className={selectClass}
          value={status}
          onChange={(e) => set('status', e.target.value)}
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
