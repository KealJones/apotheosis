import {
  markCommitmentDismissed,
  markCommitmentDone,
  markCommitmentNotAThing,
  type MutationResult,
} from './rankedCommitments.js';

export type TodoResolution = 'done' | 'dismissed' | 'not_a_thing';

export interface TodoResolveArgs {
  id: number;
  resolution: TodoResolution;
  /** Required — todo_resolve's whole contract is "always say why". */
  note: string;
}

/**
 * `todo_resolve`'s data layer: dispatches to C6's three row-action mutators. The three-way
 * split matters — `not_a_thing` is a distinct, tunable signal (the item should never have
 * been detected; see NOT_A_THING_TAG) from a generic `dismissed` (fair detection, just not
 * doing it) — collapsing them back into one status would destroy the future
 * detector-precision tuning the plan calls for.
 */
export function resolveTodo(args: TodoResolveArgs): MutationResult {
  if (!args.note?.trim()) return { ok: false, error: 'note is required' };

  switch (args.resolution) {
    case 'done':
      return markCommitmentDone(args.id, args.note);
    case 'not_a_thing':
      return markCommitmentNotAThing(args.id, args.note);
    case 'dismissed':
      return markCommitmentDismissed(args.id, args.note);
    default:
      return { ok: false, error: `Unknown resolution "${args.resolution as string}"` };
  }
}
