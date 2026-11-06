/**
 * Scores evidence against the target level of the leveling ladder.
 *
 * Integrity rules, enforced in code rather than trusted to the model:
 * - No citeable evidence for a criterion means `gap`, decided without calling the model.
 * - The model may only cite refs it was shown. Anything else is dropped and reported.
 * - `met` or `partial` with zero surviving citations is downgraded to `gap`.
 * - `met` whose citations span less than rules.eligibility.sustained_behavior_months is held at `partial`.
 * - If the model is unreachable or returns junk, the criterion is `unscored`, never guessed.
 */
import { createHash } from 'crypto';
import { z } from 'zod';
import { ensureReviewScoreCache, getDb } from '../db.js';
import * as ollama from '../llm/ollama.js';
import {
  collectEvidence,
  itemFingerprint,
  UNCITEABLE_SOURCES,
  type EvidenceItem,
  type EvidenceSource,
} from './evidence.js';
import { getLevel, loadRubric, type Criterion, type Level, type Rubric } from './rubric.js';
import { checkWriting, type WritingViolation } from './writing.js';

/** Bump when the prompt or post-processing changes, so old cached scores stop matching. */
export const SCORER_VERSION = 4;
/** Most evidence items shown to the model per criterion. */
const MAX_ITEMS = 40;
/** Per-item text cap in the prompt. */
const MAX_ITEM_CHARS = 600;
const NUM_CTX = 16384;

export type CriterionStatus = 'met' | 'partial' | 'gap' | 'not_applicable' | 'unscored';

export interface SourceCoverage {
  source: EvidenceSource;
  count: number;
  /** Why a source contributes nothing, when it structurally cannot. */
  note?: string;
}

export interface CriterionScore {
  criterion_id: string;
  title: string;
  prompt?: string;
  status: CriterionStatus;
  rationale: string;
  /** What evidence would move this criterion up. */
  missing: string;
  /** Resolved citations. Every entry is a real record from this run's evidence set. */
  cited: EvidenceItem[];
  /** Refs the model cited that were not in the evidence it was shown. Dropped. */
  rejected_citations: string[];
  target_expectation: string | null;
  current_expectation: string | null;
  sources: SourceCoverage[];
  evidence_total: number;
  /** How many items the model actually saw (capped at MAX_ITEMS). */
  evidence_considered: number;
  /** No Apotheosis source feeds this criterion; it needs manual input. */
  manual_input_required: boolean;
  writing_violations: WritingViolation[];
  /** 'rule' = decided without the model (no evidence / not applicable). */
  decided_by: 'rule' | 'model' | 'none';
  cached: boolean;
  error?: string;
}

export interface ReviewResult {
  config_version: string;
  ladder: { id: string; title: string };
  levels: Level[];
  current_level: Level;
  target_level: Level;
  range: { since: string; until: string };
  model: string;
  criteria: CriterionScore[];
  summary: {
    met: number;
    partial: number;
    gap: number;
    unscored: number;
    not_applicable: number;
    /** (met + 0.5 * partial) / scored applicable criteria, 0..1. null if nothing is scored. */
    coverage: number | null;
    /** False while any applicable criterion is unscored. */
    complete: boolean;
  };
  /** Records cited by the most met/partial criteria. */
  top_evidence: { item: EvidenceItem; cited_by: string[] }[];
  /** Set when the model could not be reached; affected criteria are `unscored`. */
  llm_error: string | null;
}

export interface ScoreReviewOptions {
  current_level?: string;
  target_level?: string;
  /** ISO. Defaults to Jan 1 of the current year. Widened to the start of its UTC day. */
  since?: string;
  /** ISO. Defaults to today. Widened to the end of its UTC day. */
  until?: string;
  /** Ignore cached scores and rescore every model-decided criterion. */
  force?: boolean;
  /** Never call the model; uncached criteria come back `unscored`. For fast page loads. */
  cacheOnly?: boolean;
  /** Injectable for tests. Defaults to Ollama chat with format json. */
  chatFn?: (messages: ollama.OllamaChatMessage[]) => Promise<string>;
  /** Model label for the cache key. Defaults to the configured Ollama model. */
  model?: string;
  rubric?: Rubric;
}

// Small models sometimes return `missing` as a list; that is a shape quirk, not a verdict change.
const ModelVerdict = z.object({
  status: z.enum(['met', 'partial', 'gap']),
  cited_refs: z.array(z.string()),
  rationale: z.string(),
  missing: z.union([
    z.string(),
    z.array(z.string()).transform((a) => a.join('; ')),
    z.null().transform(() => ''),
  ]),
});

const REF_TOKEN_RE = /[a-z_]+:[\w.-]+/g;

/**
 * Match what the model cited against the refs it was shown. Small models echo
 * refs with the list's `[...]` wrapper, the rest of the header line, or several
 * run together, so every ref-shaped token is pulled out and must exactly equal
 * a shown ref. Nothing outside the shown set can match.
 */
function matchCitations(cited: string[], shown: Set<string>): { valid: string[]; rejected: string[] } {
  const valid = new Set<string>();
  const rejected = new Set<string>();
  for (const raw of cited) {
    let found = false;
    for (const token of raw.match(REF_TOKEN_RE) ?? []) {
      const ref = token.replace(/\.+$/, '');
      if (shown.has(ref)) {
        valid.add(ref);
        found = true;
      } else {
        rejected.add(ref);
      }
    }
    if (!found && !(raw.match(REF_TOKEN_RE)?.length)) rejected.add(raw);
  }
  return { valid: [...valid], rejected: [...rejected] };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days between the earliest and latest cited record. */
function citedSpanDays(items: EvidenceItem[]): number {
  if (items.length < 2) return 0;
  const ts = items.map((i) => new Date(i.date).getTime());
  return Math.floor((Math.max(...ts) - Math.min(...ts)) / DAY_MS);
}

function defaultSince(): string {
  return `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`;
}

/**
 * Reviews work in whole UTC days. The range is part of the cache key, so
 * without this an `until` of "now" would miss the cache on every call.
 */
function dayBound(iso: string, edge: 'start' | 'end'): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) throw new Error(`Invalid date: ${iso}`);
  const day = new Date(t).toISOString().slice(0, 10);
  return edge === 'start' ? `${day}T00:00:00.000Z` : `${day}T23:59:59.999Z`;
}

/** Evenly spaced picks across a chronologically sorted list, so no stretch of the range dominates. */
function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  if (n <= 0) return [];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor((i * items.length) / n)]);
  return out;
}

/** Share MAX_ITEMS across sources, handing unused quota from small sources to large ones. */
function pickShown(bySource: EvidenceItem[][]): EvidenceItem[] {
  const quotas = bySource.map(() => 0);
  let remaining = MAX_ITEMS;
  let open = bySource.map((_, i) => i).filter((i) => bySource[i].length > 0);
  while (remaining > 0 && open.length > 0) {
    const share = Math.max(1, Math.floor(remaining / open.length));
    for (const i of open) {
      const take = Math.min(share, bySource[i].length - quotas[i], remaining);
      quotas[i] += take;
      remaining -= take;
      if (remaining === 0) break;
    }
    open = open.filter((i) => quotas[i] < bySource[i].length);
  }
  return bySource.flatMap((items, i) => spread(items, quotas[i]));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

function buildPrompt(
  c: Criterion,
  current: Level,
  target: Level,
  targetText: string,
  currentText: string | null,
  shown: EvidenceItem[]
): ollama.OllamaChatMessage[] {
  const system =
    `You are a strict promotion-committee reviewer checking one leveling criterion against recorded evidence. ` +
    `The candidate is a ${current.title} (${current.code}) being assessed for ${target.title} (${target.code}). ` +
    `Grade only against the ${target.code} expectation. Be conservative: this is a real career record and ` +
    `overstating coverage harms the candidate.\n\n` +
    `Statuses:\n` +
    `- "met": the evidence directly shows the specific ${target.code} behaviors, not just ${current.code} ones.\n` +
    `- "partial": some ${target.code} behaviors are shown, or they are shown but thinly.\n` +
    `- "gap": the evidence shows only ${current.code}-level work, is unrelated, or is missing.\n\n` +
    `Rules:\n` +
    `- Cite evidence only by the exact ref strings given in the list, one bare ref per array entry ` +
    `(for example "standups:12", without brackets or titles). Never invent a ref.\n` +
    `- Every "met" or "partial" must cite at least one ref that shows the behavior.\n` +
    `- Do not infer behavior the evidence does not state. Activity volume is not impact.\n` +
    `- Work on the candidate's own promotion case, self-review, or performance paperwork is not evidence for any ` +
    `criterion. Metrics the candidate compiled about themselves are self-reported.\n` +
    `- "met" means sustained behavior: cite records from across the range, not one week.\n` +
    `- Slack messages marked "Sent by me" are self-reported; recognition counts only when from others.\n` +
    `- Write the rationale as one plain sentence. No intensifiers (significantly, very, greatly, and so on).\n` +
    `- "missing" names the concrete evidence that would raise the status.\n\n` +
    `Respond with ONLY a JSON object: ` +
    `{"status": "met" | "partial" | "gap", "cited_refs": ["..."], "rationale": "...", "missing": "..."}`;

  const user =
    `Criterion: ${c.title}${c.prompt ? ` (${c.prompt})` : ''}\n\n` +
    `${target.code} expectation (the bar):\n${targetText}\n\n` +
    (currentText ? `${current.code} expectation (current level, for contrast only):\n${currentText}\n\n` : '') +
    `Evidence (${shown.length} items):\n` +
    shown
      .map((i) => `[${i.ref}] ${i.date.slice(0, 10)} ${i.title}\n${truncate(i.text, MAX_ITEM_CHARS)}`)
      .join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function stripFences(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : t;
}

interface CachedScore {
  status: CriterionStatus;
  rationale: string;
  missing: string;
  cited_refs: string[];
  rejected_citations: string[];
}

function cacheKey(parts: (string | number)[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function blank(c: Criterion, targetText: string | null, currentText: string | null, sources: SourceCoverage[]): CriterionScore {
  return {
    criterion_id: c.id,
    title: c.title,
    prompt: c.prompt,
    status: 'gap',
    rationale: '',
    missing: '',
    cited: [],
    rejected_citations: [],
    target_expectation: targetText,
    current_expectation: currentText,
    sources,
    evidence_total: 0,
    evidence_considered: 0,
    manual_input_required: false,
    writing_violations: [],
    decided_by: 'rule',
    cached: false,
  };
}

export async function scoreReview(opts: ScoreReviewOptions = {}): Promise<ReviewResult> {
  const rubric = opts.rubric ?? loadRubric();
  const current = getLevel(rubric, opts.current_level ?? rubric.defaults.current_level);
  const target = getLevel(rubric, opts.target_level ?? rubric.defaults.target_level);
  const since = dayBound(opts.since ?? defaultSince(), 'start');
  const until = dayBound(opts.until ?? new Date().toISOString(), 'end');
  if (since > until) throw new Error(`Range start ${since} is after its end ${until}.`);

  const model = opts.model ?? (opts.chatFn ? 'injected' : ollama.getOllamaModel());
  const chatFn =
    opts.chatFn ??
    // think:false because qwen3.5:9b's reasoning pass took over 120s per criterion vs ~40s without.
    // temperature 0 because at the default, the same evidence flipped role_focus met/gap/partial across runs.
    ((messages: ollama.OllamaChatMessage[]) =>
      ollama.chat(messages, { format: 'json', numCtx: NUM_CTX, think: false, temperature: 0, timeoutMs: 300_000 }));

  const db = getDb();
  ensureReviewScoreCache(db);

  const allSources = [...new Set(rubric.criteria.flatMap((c) => c.evidence_sources))];
  const evidence = collectEvidence({ since, until }, allSources);

  let llmChecked = false;
  let llmError: string | null = null;
  const ensureLlm = async (): Promise<boolean> => {
    if (opts.chatFn) return true;
    if (!llmChecked) {
      llmChecked = true;
      if (!(await ollama.isAvailable())) {
        llmError =
          `Ollama is not reachable at ${ollama.getOllamaUrl()}. Start it (e.g. \`ollama serve\`, and make sure ` +
          `model "${ollama.getOllamaModel()}" is pulled) and score again.`;
      }
    }
    return llmError === null;
  };

  const results: CriterionScore[] = [];
  for (const c of rubric.criteria) {
    const targetText = c.expectations[target.id] ?? null;
    const currentText = c.expectations[current.id] ?? null;
    const perSource = c.evidence_sources.map((s) => evidence[s]);
    const sources: SourceCoverage[] = c.evidence_sources.map((s, i) => ({
      source: s,
      count: perSource[i].length,
      ...(UNCITEABLE_SOURCES[s] ? { note: UNCITEABLE_SOURCES[s] } : {}),
    }));
    const candidates = perSource.flat();
    const score = blank(c, targetText, currentText, sources);
    score.evidence_total = candidates.length;

    if (targetText == null) {
      score.status = 'not_applicable';
      score.rationale = `The ladder has no ${target.code} expectation for this criterion.`;
      results.push(score);
      continue;
    }
    if (c.evidence_sources.length === 0) {
      score.manual_input_required = true;
      score.rationale = 'No captured source feeds this criterion, so it cannot be scored from evidence.';
      score.missing = 'Supply this manually (for example, years of related experience).';
      results.push(score);
      continue;
    }
    if (candidates.length === 0) {
      score.rationale = `No evidence in range from ${c.evidence_sources.join(', ')}.`;
      score.missing = `Evidence from ${c.evidence_sources.join(', ')} showing the ${target.code} expectation.`;
      results.push(score);
      continue;
    }

    const shown = pickShown(perSource);
    const shownByRef = new Map(shown.map((i) => [i.ref, i]));
    score.evidence_considered = shown.length;
    score.decided_by = 'model';

    const fingerprint = createHash('sha256')
      .update(candidates.map(itemFingerprint).sort().join(','))
      .digest('hex');
    const key = cacheKey([
      SCORER_VERSION, rubric.config_version, c.id, current.id, target.id, since, until, model, fingerprint,
    ]);

    let verdict: CachedScore | null = null;
    if (!opts.force) {
      const row = db.prepare('SELECT result FROM review_score_cache WHERE cache_key = ?').get(key) as
        | { result: string }
        | undefined;
      if (row) {
        verdict = JSON.parse(row.result) as CachedScore;
        score.cached = true;
      }
    }

    if (!verdict) {
      if (opts.cacheOnly) {
        score.status = 'unscored';
        score.decided_by = 'none';
        score.rationale = 'Not scored yet for this range and level pair.';
        results.push(score);
        continue;
      }
      if (!(await ensureLlm())) {
        score.status = 'unscored';
        score.decided_by = 'none';
        score.rationale = 'Not scored: the local model is unreachable.';
        score.error = llmError ?? undefined;
        results.push(score);
        continue;
      }

      let parsed: z.infer<typeof ModelVerdict>;
      try {
        const raw = await chatFn(buildPrompt(c, current, target, targetText, currentText, shown));
        const result = ModelVerdict.safeParse(JSON.parse(stripFences(raw)));
        if (!result.success) throw new Error(`model output did not match the verdict shape: ${z.prettifyError(result.error)}`);
        parsed = result.data;
      } catch (err) {
        score.status = 'unscored';
        score.decided_by = 'none';
        score.rationale = 'Not scored: the model call failed.';
        score.error = err instanceof Error ? err.message : String(err);
        results.push(score);
        continue;
      }

      const { valid, rejected } = matchCitations(parsed.cited_refs, new Set(shownByRef.keys()));
      let status: CriterionStatus = parsed.status;
      let rationale = parsed.rationale.trim();
      if ((status === 'met' || status === 'partial') && valid.length === 0) {
        rationale = `Downgraded from "${status}" to "gap": the model cited no evidence it was shown. ${rationale}`;
        status = 'gap';
      }
      verdict = {
        status,
        rationale,
        missing: parsed.missing.trim(),
        cited_refs: valid,
        rejected_citations: rejected,
      };
      db.prepare(
        'INSERT OR REPLACE INTO review_score_cache (cache_key, criterion_id, result, created_at) VALUES (?, ?, ?, ?)'
      ).run(key, c.id, JSON.stringify(verdict), Date.now());
    }

    score.status = verdict.status;
    score.rationale = verdict.rationale;
    score.missing = verdict.missing;
    // Re-resolve against this run's evidence: a cached ref that is no longer shown cannot be cited.
    score.cited = verdict.cited_refs.map((r) => shownByRef.get(r)).filter((i): i is EvidenceItem => i != null);
    score.rejected_citations = verdict.rejected_citations;
    if ((score.status === 'met' || score.status === 'partial') && score.cited.length === 0) {
      score.status = 'gap';
    }
    // rules.eligibility: "met" needs behavior sustained over N months, so the cited records must span it.
    const months = rubric.sustained_behavior_months;
    if (score.status === 'met' && months != null) {
      const span = citedSpanDays(score.cited);
      if (span < months * 30) {
        score.status = 'partial';
        score.rationale =
          `Held at partial: the cited evidence spans ${span} days, and the packet rules ask for behavior ` +
          `sustained over ${months} months. ${score.rationale}`;
      }
    }
    score.writing_violations = checkWriting(`${score.rationale}\n${score.missing}`, rubric.writing_rules);
    results.push(score);
  }

  return summarize(rubric, current, target, { since, until }, model, results, llmError);
}

function summarize(
  rubric: Rubric,
  current: Level,
  target: Level,
  range: { since: string; until: string },
  model: string,
  criteria: CriterionScore[],
  llmError: string | null
): ReviewResult {
  const count = (s: CriterionStatus) => criteria.filter((c) => c.status === s).length;
  const met = count('met');
  const partial = count('partial');
  const gap = count('gap');
  const unscored = count('unscored');
  const scored = met + partial + gap;

  const tally = new Map<string, { item: EvidenceItem; cited_by: string[]; weight: number }>();
  for (const c of criteria) {
    if (c.status !== 'met' && c.status !== 'partial') continue;
    for (const item of c.cited) {
      const t = tally.get(item.ref) ?? { item, cited_by: [], weight: 0 };
      t.cited_by.push(c.criterion_id);
      t.weight += c.status === 'met' ? 2 : 1;
      tally.set(item.ref, t);
    }
  }
  const top_evidence = [...tally.values()]
    .sort((a, b) => b.weight - a.weight || b.item.date.localeCompare(a.item.date))
    .slice(0, 3)
    .map(({ item, cited_by }) => ({ item, cited_by }));

  return {
    config_version: rubric.config_version,
    ladder: rubric.ladder,
    levels: rubric.levels,
    current_level: current,
    target_level: target,
    range,
    model,
    criteria,
    summary: {
      met,
      partial,
      gap,
      unscored,
      not_applicable: count('not_applicable'),
      coverage: scored > 0 ? (met + 0.5 * partial) / scored : null,
      complete: unscored === 0,
    },
    top_evidence,
    llm_error: llmError,
  };
}
