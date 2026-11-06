/**
 * Fuzzy text matching for the standup carryover detector. No embedding/similarity utility
 * or local-model (Ollama) client exists elsewhere in this codebase yet, so this is a
 * dependency-free string-similarity heuristic rather than a semantic one.
 *
 * Two signals, combined:
 *  1. Shared identifiers (PR/issue refs like "#123" or "agent-tools#91", ticket refs like
 *     "IP-349") are treated as a definite match. Real standup text leans heavily on these —
 *     "Get #107, #108 reviewed" today vs. "agent-tools #107/#108 merged" as yesterday — and
 *     word-overlap alone underweights a single shared number buried in otherwise different
 *     phrasing.
 *  2. Otherwise, an overlap coefficient (shared content words / smaller side's word count)
 *     with a minimum shared-word floor — see the two constants below for why *this* combo
 *     and not a plain symmetric ratio (Dice/Jaccard). Both were tried against real standup
 *     history and neither alone held up.
 */

const MARKDOWN_LINK = /\[([^\]]+)\]\([^)]+\)/g;
const URL = /https?:\/\/\S+/g;
const ISSUE_REF = /[\w.-]*#\d+/g;
const TICKET_REF = /\b[A-Z]{2,}-\d+\b/g;

/**
 * Words filtered out before computing Dice overlap. Standup text is full of boilerplate
 * phrasing ("Follow up on...", "Continue...") that isn't specific to any one task — without
 * this, two *different* "Follow up on X" items score high on shared filler words alone
 * (found by running the detector against real standup history: "Follow up on design-docs
 * PR #2035" scored 0.3+ Dice against unrelated items like "Follow up on any open threads",
 * enough to cross the threshold below). Stripping them forces the score to reflect actual
 * topic overlap (names, projects, PR numbers as words) instead of sentence-template overlap.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'to', 'for', 'with', 'at', 'by', 'from',
  'up', 'about', 'into', 'over', 'after', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'as', 'so', 'not', 'no',
  'follow', 'continue', 'get', 'review', 'check', 'checked', 'today', 'yesterday',
  'work', 'working', 'out', 'any', 'all', 'still', 'just', 'also', 'more', 'some',
  'my', 'me', 'i', 'open', 'ongoing', 'need', 'needed', 'if', 'once', 'then',
]);

/**
 * PR/issue refs ("#123", "org/repo#123") and ticket refs ("IP-349"), lowercased. A ref with
 * a repo prefix also contributes its bare "#123" form, so "design-docs#2035" (as
 * written when the repo is clear from context) still matches a same-day "PR #2035" mention
 * that dropped the prefix — this is how real standup text refers back to the same PR.
 */
export function extractIdentifiers(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(ISSUE_REF)) {
    const full = m[0].toLowerCase();
    ids.add(full);
    ids.add(full.slice(full.indexOf('#')));
  }
  for (const m of text.matchAll(TICKET_REF)) ids.add(m[0].toLowerCase());
  return ids;
}

/** Lowercased, markdown-unwrapped, punctuation-stripped word tokens (len > 1), deduped by caller. */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(MARKDOWN_LINK, '$1')
    .replace(URL, ' ')
    .replace(/[^a-z0-9\s#-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** `normalizeWords()` with boilerplate/filler words removed — see STOPWORDS. */
export function contentWords(text: string): string[] {
  return normalizeWords(text).filter((w) => !STOPWORDS.has(w));
}

/** |A∩B| and |A∩B| / min(|A|,|B|), over unique tokens. 0/0 if either side is empty. */
export function overlapCoefficient(a: string[], b: string[]): { count: number; coefficient: number } {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return { count: 0, coefficient: 0 };
  let count = 0;
  for (const w of setA) if (setB.has(w)) count++;
  return { count, coefficient: count / Math.min(setA.size, setB.size) };
}

/**
 * Picked by running the detector against real standup history (27 standups, see
 * standupCarryover.ts doc comment) and spot-checking the carryover candidates it produced.
 * A plain symmetric ratio (Dice/Jaccard: shared / *combined* size) undercounted genuine
 * matches whenever one side was much longer than the other — very common here, since a
 * terse "today" plan ("Continue agent-tools work — `SkillToolUI.tsx` was open early this
 * morning") gets confirmed by a much longer "yesterday" recap the next day. That real pair
 * shared 3 content words but scored only 0.19 on Dice (below any reasonable threshold)
 * because the recap alone had ~14 unique words.
 *
 * Switching to an overlap coefficient (shared / *smaller* side) fixed that — 3/5 = 0.60 —
 * but on its own is too lenient for short strings: "ml-agent-service#1683 waiting on human
 * reviews..." vs "agent-tools#121 waiting for review" are unrelated blockers that happen to
 * both say "waiting", scoring 1/2 = 0.50 — the same as some genuine matches. The minimum
 * shared-word count is what excludes it (count 1, below the floor of 3) while still passing
 * the genuine matches (which all shared >= 3 content words in this dataset).
 */
const MIN_SHARED_CONTENT_WORDS = 3;
const OVERLAP_COEFFICIENT_THRESHOLD = 0.5;

/** True if `a` and `b` most likely describe the same underlying task/item. */
export function isFuzzyMatch(a: string, b: string): boolean {
  const idsA = extractIdentifiers(a);
  if (idsA.size > 0) {
    const idsB = extractIdentifiers(b);
    for (const id of idsA) if (idsB.has(id)) return true;
  }
  const { count, coefficient } = overlapCoefficient(contentWords(a), contentWords(b));
  return count >= MIN_SHARED_CONTENT_WORDS && coefficient >= OVERLAP_COEFFICIENT_THRESHOLD;
}
