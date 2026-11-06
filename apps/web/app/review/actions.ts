'use server';

import { loadRubric, renderPacketMarkdown, scoreReview } from '@/lib/data';

export interface ReviewParams {
  current_level: string;
  target_level: string;
  since: string;
  until: string;
}

/** Runs the model on every uncached criterion. Slow (one local-model call per criterion). */
export async function scoreReviewAction(params: ReviewParams, force = false) {
  try {
    const r = await scoreReview({ ...params, force });
    return { success: true as const, llm_error: r.llm_error, unscored: r.summary.unscored };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : 'Scoring failed' };
  }
}

/** Markdown packet draft from cached scores only; never calls the model. */
export async function exportPacketAction(params: ReviewParams) {
  try {
    const rubric = loadRubric();
    const review = await scoreReview({ ...params, rubric, cacheOnly: true });
    const draft = renderPacketMarkdown(review, rubric);
    return {
      success: true as const,
      markdown: draft.markdown,
      violations: draft.writing_violations.length,
      unscored: review.summary.unscored,
    };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : 'Export failed' };
  }
}
