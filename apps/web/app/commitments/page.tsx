import { listCommitments, COMMITMENT_SOURCES } from "@/lib/data";
import type { CommitmentSource, CommitmentStatus } from "@/lib/data";
import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { CommitmentFilters } from "@/components/commitments/commitment-filters";
import { CommitmentRowActions } from "@/components/commitments/commitment-row-actions";

const STATUSES: readonly CommitmentStatus[] = ["open", "snoozed", "done", "dismissed"];

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const RESOLVED_BADGE: Record<string, { label: string; className: string }> = {
  done: { label: "Done", className: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400" },
  dismissed: { label: "Dismissed", className: "bg-muted text-muted-foreground" },
  not_a_thing: { label: "Not a thing", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
};

export default async function CommitmentsPage({ searchParams }: PageProps<"/commitments">) {
  const params = (await searchParams) as Params;
  const sourceParam = first(params.source);
  const statusParam = first(params.status);

  const source = sourceParam && (COMMITMENT_SOURCES as readonly string[]).includes(sourceParam)
    ? (sourceParam as CommitmentSource)
    : undefined;
  const status = statusParam && STATUSES.includes(statusParam as CommitmentStatus)
    ? (statusParam as CommitmentStatus)
    : undefined;

  const { commitments, total } = listCommitments({ source, status, limit: 200 });

  return (
    <PageShell title="Commitments">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CommitmentFilters
            sources={COMMITMENT_SOURCES}
            statuses={STATUSES}
            source={source ?? "all"}
            status={status ?? "all"}
          />
          <p className="text-xs text-muted-foreground">{total} matching</p>
        </div>

        {commitments.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing matches this filter.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {commitments.map((c) => {
              const isActionable = c.status === "open" || c.status === "snoozed";
              const resolvedKey = c.status === "dismissed" && c.is_not_a_thing ? "not_a_thing" : c.status;
              const resolvedBadge = !isActionable ? RESOLVED_BADGE[resolvedKey] : undefined;

              return (
                <li key={c.id} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{c.title}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <Badge variant="outline">{c.source}</Badge>
                        {c.status === "snoozed" && <Badge variant="secondary">Snoozed</Badge>}
                        {resolvedBadge && <Badge className={resolvedBadge.className}>{resolvedBadge.label}</Badge>}
                        {c.counterparty && <span>{c.counterparty}</span>}
                        {c.due_hint && <span>due {c.due_hint}</span>}
                        <span>detected {new Date(c.detected_at * 1000).toLocaleDateString()}</span>
                      </p>
                      {c.detail && <p className="mt-1 text-xs text-muted-foreground">{c.detail}</p>}
                      {!isActionable && c.resolution_note && (
                        <p className="mt-1 text-xs text-muted-foreground">Note: {c.resolution_note}</p>
                      )}
                    </div>
                  </div>
                  {isActionable && (
                    <div className="mt-2">
                      <CommitmentRowActions id={c.id} sourceUrl={c.source_url} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </PageShell>
  );
}
