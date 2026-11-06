"use server";

import { revalidatePath } from "next/cache";
import { deleteSamples, linkEvidence } from "@/lib/data";

/**
 * Links samples to a project. This is also how a sample gets "tagged as
 * evidence" — linkEvidence() sets is_evidence=1 on every linked sample as
 * part of the same write, so there's no separate untagged-evidence action.
 */
export async function linkSampleToProjectAction(sampleIds: number[], projectSlug: string) {
  if (sampleIds.length === 0) return { error: "No samples selected." };
  if (!projectSlug) return { error: "No project selected." };

  const result = linkEvidence({ project_slug: projectSlug, sample_ids: sampleIds });
  revalidatePath("/timeline");
  return result;
}

/**
 * Deletes samples (DB row + screenshot file). deleteSamples() itself refuses
 * anything already tagged as evidence, so this is safe to call directly from
 * a row action without an extra confirmation round-trip to the server.
 */
export async function deleteSampleAction(sampleIds: number[]) {
  if (sampleIds.length === 0) return { deleted: [], refused: [], errors: [], summary: "Nothing to delete." };

  const result = deleteSamples({ ids: sampleIds });
  revalidatePath("/timeline");
  return result;
}
