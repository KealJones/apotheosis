import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { loadRubric, scoreReview, type CriterionScore, type ReviewResult, type Rubric } from "@/lib/data";
import { PageShell } from "@/components/page-shell";
import { LevelPickers, ReviewActions } from "@/components/review/review-controls";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const STATUS: Record<CriterionScore["status"], { label: string; className: string }> = {
  met: { label: "Met", className: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400" },
  partial: { label: "Partial", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  gap: { label: "Gap", className: "bg-destructive/10 text-destructive" },
  unscored: { label: "Not scored", className: "bg-muted text-muted-foreground" },
  not_applicable: { label: "N/A", className: "bg-muted text-muted-foreground" },
};

function Expectation({ label, text }: { label: string; text: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="whitespace-pre-line text-sm">{text ?? "No expectation at this level."}</p>
    </div>
  );
}

function CriterionCard({ c, review }: { c: CriterionScore; review: ReviewResult }) {
  const s = STATUS[c.status];
  return (
    <Card size="sm" id={`criterion-${c.criterion_id}`}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>{c.title}</CardTitle>
          <Badge className={s.className}>{s.label}</Badge>
        </div>
        {c.prompt && <CardDescription>{c.prompt}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Expectation label={`Target: ${review.target_level.code} ${review.target_level.title}`} text={c.target_expectation} />
          <Expectation label={`Current: ${review.current_level.code} ${review.current_level.title}`} text={c.current_expectation} />
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-sm">{c.rationale}</p>
          {c.error && <p className="text-xs text-destructive">{c.error}</p>}
          {c.status !== "met" && c.missing && (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Missing:</span> {c.missing}
            </p>
          )}
        </div>

        {c.cited.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">Evidence ({c.cited.length})</p>
            <ul className="flex flex-col gap-1 text-sm">
              {c.cited.map((i) => (
                <li key={i.ref}>
                  <Link href={i.href} className="underline-offset-4 hover:underline" data-evidence-ref={i.ref}>
                    {i.date.slice(0, 10)} &middot; {i.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {c.rejected_citations.length > 0 && (
          <p className="text-xs text-destructive">
            Dropped {c.rejected_citations.length} citation{c.rejected_citations.length === 1 ? "" : "s"} the model
            invented: {c.rejected_citations.join(", ")}
          </p>
        )}
        {c.writing_violations.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Writing rules: {c.writing_violations.map((v) => v.message).join(" ")}
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          {c.sources.length === 0
            ? "No captured source feeds this criterion."
            : c.sources.map((src) => `${src.source} ${src.count}`).join(" · ")}
          {c.evidence_total > c.evidence_considered && c.decided_by === "model" &&
            ` · model saw ${c.evidence_considered} of ${c.evidence_total}, spread across the range`}
          {c.cached && " · cached"}
        </p>
        {c.sources.filter((src) => src.note).map((src) => (
          <p key={src.source} className="text-xs text-muted-foreground">
            {src.source}: {src.note}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

function Summary({ review }: { review: ReviewResult }) {
  const { summary } = review;
  const pct = summary.coverage == null ? "n/a" : `${Math.round(summary.coverage * 100)}%`;
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>
          {review.range.since.slice(0, 10)} to {review.range.until.slice(0, 10)} &middot; scored against{" "}
          {review.target_level.code} {review.target_level.title} &middot; model {review.model}
        </CardDescription>
        <CardTitle>
          Coverage {pct}
          {!summary.complete && <span className="font-normal text-muted-foreground"> (incomplete)</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {summary.met} met &middot; {summary.partial} partial &middot; {summary.gap} gap
          {summary.unscored > 0 && <> &middot; {summary.unscored} not scored</>}
          {summary.not_applicable > 0 && <> &middot; {summary.not_applicable} n/a</>}
        </p>
        {review.llm_error && <p className="text-sm text-destructive">{review.llm_error}</p>}
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">Strongest evidence</p>
          {review.top_evidence.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing cited yet.</p>
          ) : (
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
              {review.top_evidence.map(({ item, cited_by }) => (
                <li key={item.ref}>
                  <Link href={item.href} className="underline-offset-4 hover:underline" data-evidence-ref={item.ref}>
                    {item.date.slice(0, 10)} &middot; {item.title}
                  </Link>{" "}
                  <span className="text-muted-foreground">({cited_by.length} criteria)</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default async function ReviewPage({ searchParams }: PageProps<"/review">) {
  const params = (await searchParams) as Params;

  let rubric: Rubric;
  try {
    rubric = loadRubric();
  } catch (err) {
    return (
      <PageShell title="Review">
        <pre className="whitespace-pre-wrap text-sm text-destructive">
          {err instanceof Error ? err.message : String(err)}
        </pre>
      </PageShell>
    );
  }

  // Year to date by default. Written into the URL so the range picker shows it.
  if (!first(params.since)) {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (first(v)) next.set(k, first(v)!);
    // Local-time bounds so the picker reads Jan 1 to today; the scorer widens them to whole UTC days.
    const now = new Date();
    next.set("since", new Date(now.getFullYear(), 0, 1).toISOString());
    next.set(
      "until",
      first(params.until) ?? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString()
    );
    redirect(`/review?${next.toString()}`);
  }

  const reviewParams = {
    current_level: first(params.current) ?? rubric.defaults.current_level,
    target_level: first(params.target) ?? rubric.defaults.target_level,
    since: first(params.since)!,
    until: first(params.until) ?? new Date().toISOString(),
  };

  let review: ReviewResult;
  try {
    review = await scoreReview({ ...reviewParams, rubric, cacheOnly: true });
  } catch (err) {
    return (
      <PageShell title="Review">
        <p className="text-sm text-destructive">{err instanceof Error ? err.message : String(err)}</p>
      </PageShell>
    );
  }

  return (
    <PageShell title="Review">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Suspense>
            <LevelPickers
              levels={rubric.levels}
              current={review.current_level.id}
              target={review.target_level.id}
            />
          </Suspense>
          <ReviewActions params={reviewParams} unscored={review.summary.unscored} />
        </div>
        <Summary review={review} />
        <div className="flex flex-col gap-3">
          {review.criteria.map((c) => (
            <CriterionCard key={c.criterion_id} c={c} review={review} />
          ))}
        </div>
      </div>
    </PageShell>
  );
}
