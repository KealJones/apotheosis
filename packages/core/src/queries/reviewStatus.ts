import { scoreReview, type ReviewResult } from '../review/score.js';

export interface ReviewStatusArgs {
  target_level?: string;
  current_level?: string;
  since?: string;
  until?: string;
  /** Rescore instead of using cached scores. */
  force?: boolean;
}

export type ReviewStatusResult =
  | { error: string }
  | (Omit<ReviewResult, 'criteria' | 'top_evidence' | 'levels'> & {
      levels: string[];
      criteria: {
        criterion_id: string;
        title: string;
        status: string;
        rationale: string;
        missing: string;
        target_expectation: string | null;
        current_expectation: string | null;
        citations: { ref: string; date: string; title: string; href: string; external_url: string | null }[];
        rejected_citations: string[];
        sources: { source: string; count: number; note?: string }[];
        manual_input_required: boolean;
        writing_violations: string[];
        error?: string;
      }[];
      top_evidence: { ref: string; title: string; date: string; cited_by: string[] }[];
    });

/**
 * Scored leveling coverage for the review / promo packet, for Claude Code.
 * Citations are refs into real records; resolve one with the dashboard's
 * /review/evidence/<ref> page. Evidence text is omitted to keep this compact.
 */
export async function reviewStatus(args: ReviewStatusArgs): Promise<ReviewStatusResult> {
  let r: ReviewResult;
  try {
    r = await scoreReview(args);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  return {
    ...r,
    levels: r.levels.map((l) => `${l.id} (${l.title})`),
    criteria: r.criteria.map((c) => ({
      criterion_id: c.criterion_id,
      title: c.title,
      status: c.status,
      rationale: c.rationale,
      missing: c.missing,
      target_expectation: c.target_expectation,
      current_expectation: c.current_expectation,
      citations: c.cited.map((i) => ({ ref: i.ref, date: i.date, title: i.title, href: i.href, external_url: i.external_url })),
      rejected_citations: c.rejected_citations,
      sources: c.sources,
      manual_input_required: c.manual_input_required,
      writing_violations: c.writing_violations.map((v) => v.message),
      ...(c.error ? { error: c.error } : {}),
    })),
    top_evidence: r.top_evidence.map((t) => ({ ref: t.item.ref, title: t.item.title, date: t.item.date, cited_by: t.cited_by })),
  };
}
