// Shared date-range resolution for pages driven by the `?since=&until=` URL
// search params (see components/date-range-picker.tsx and components/page-shell.tsx).
// Keeping the default window in one place means every route interprets an
// absent range the same way, and the range stays linkable/shareable once set.

export interface ResolvedDateRange {
  since: string;
  until: string;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // last 24 hours

export type SearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function resolveDateRange(searchParams: SearchParams): ResolvedDateRange {
  const since = firstValue(searchParams.since);
  const until = firstValue(searchParams.until);

  const untilIso = until ?? new Date().toISOString();
  const sinceIso = since ?? new Date(new Date(untilIso).getTime() - DEFAULT_WINDOW_MS).toISOString();

  return { since: sinceIso, until: untilIso };
}
