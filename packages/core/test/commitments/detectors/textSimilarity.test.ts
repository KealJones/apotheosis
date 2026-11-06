import { describe, it, expect } from 'vitest';
import { isFuzzyMatch, overlapCoefficient, normalizeWords, extractIdentifiers } from '../../../src/commitments/detectors/textSimilarity.js';

describe('textSimilarity', () => {
  it('matches the same task re-described in different words (true positive)', () => {
    expect(isFuzzyMatch(
      'Ship IP-500 config validator',
      'Shipped the IP-500 config validator, ready for review',
    )).toBe(true);
  });

  it('matches purely on a shared PR/ticket identifier even with very different wording', () => {
    expect(isFuzzyMatch(
      'Get #107, #108, #109 reviewed and merged',
      'agent-tools #107/#108/#109 all merged this morning',
    )).toBe(true);
  });

  it('does not match two unrelated items (true negative)', () => {
    expect(isFuzzyMatch(
      'Ship IP-500 config validator',
      'Reviewed Morgan\'s design-docs PR',
    )).toBe(false);
  });

  it('does not match two different generic "PR awaiting review" blockers, even though they share one word', () => {
    // Both short, both say "waiting" — high overlap *ratio* (1/2), but only 1 shared
    // content word, below MIN_SHARED_CONTENT_WORDS. This is the case that ruled out a
    // plain overlap-coefficient-only rule (see textSimilarity.ts doc comment).
    expect(isFuzzyMatch(
      'ml-agent-service#1683 waiting on human reviews',
      'agent-tools#121 waiting for review',
    )).toBe(false);
  });

  it('matches a terse plan against a much longer later recap that names the same thing', () => {
    // Real example found spot-checking against actual standup history: a short "today"
    // plan confirmed by a much longer "yesterday" recap the next day. This is the case
    // that ruled out a plain Dice/Jaccard rule (see textSimilarity.ts doc comment).
    expect(isFuzzyMatch(
      'Continue agent-tools work — `SkillToolUI.tsx` was open early this morning',
      'Big coding session on agent-tools skill builder: SkillBuilderPage.tsx, SkillToolUI.tsx, '
        + 'UpdateSkillToolUI.tsx, RecordUserEditsToolUI.tsx, useClientToolLifecycle.ts, useSkillUndoCursor.ts',
    )).toBe(true);
  });

  it('extracts PR/issue and ticket identifiers, including the bare "#N" form for prefixed refs', () => {
    expect(extractIdentifiers('agent-tools#91 fixes IP-352')).toEqual(new Set(['agent-tools#91', '#91', 'ip-352']));
  });

  it('matches a prefixed ref against a same-day bare "#N" mention of the same PR', () => {
    expect(isFuzzyMatch('agent-tools#91 needs a follow up', 'Merged PR #91')).toBe(true);
  });

  it('overlap coefficient is 1 for identical token sets and 0 for disjoint or empty sets', () => {
    expect(overlapCoefficient(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual({ count: 3, coefficient: 1 });
    expect(overlapCoefficient(['a', 'b'], ['c', 'd'])).toEqual({ count: 0, coefficient: 0 });
    expect(overlapCoefficient([], ['a'])).toEqual({ count: 0, coefficient: 0 });
  });

  it('overlap coefficient normalizes by the smaller side, unlike a symmetric ratio', () => {
    // 2 shared out of a 2-word side and a 10-word side: overlap coefficient is 1 (fully
    // contained in the smaller side), whereas Dice/Jaccard would be dragged down by |B|.
    expect(overlapCoefficient(['a', 'b'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])).toEqual({
      count: 2,
      coefficient: 1,
    });
  });

  it('normalizeWords unwraps markdown links and strips punctuation/urls', () => {
    expect(normalizeWords('See [agent-tools#91](https://github.com/x/y/pull/91) for details.')).toEqual(
      expect.arrayContaining(['agent-tools#91', 'for', 'details']),
    );
  });
});
