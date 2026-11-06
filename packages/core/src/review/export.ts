/**
 * Markdown promo-packet draft from a scored review, following
 * promo-packet.yaml's `sections` order. Evidence is centralized in the
 * appendix and referenced from sections by bookmark ([E3](#evidence-e3)),
 * never by inline URL, as the packet template asks.
 *
 * Only facts the review holds are written. Narrative sections the app has no
 * data for are left as TODO placeholders carrying the template's guidance.
 */
import type { EvidenceItem } from './evidence.js';
import type { PacketSection, Rubric } from './rubric.js';
import type { CriterionScore, ReviewResult } from './score.js';
import { checkWriting, type WritingViolation } from './writing.js';

export interface PacketDraft {
  markdown: string;
  /** Drafted words per section, against the section's limit where it has one. */
  word_counts: { section_id: string; words: number; limit: number | null; over_limit: boolean }[];
  /** Rule violations in prose this exporter drafted (not in quoted evidence or ladder text). */
  writing_violations: (WritingViolation & { section_id: string })[];
}

function words(s: string): number {
  return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function todo(section: PacketSection): string {
  return `> TODO: ${section.guidance ?? 'Fill in.'}${section.word_limit ? ` (${section.word_limit} words max)` : ''}`;
}

function quote(text: string): string {
  return text.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
}

const STATUS_LABEL: Record<string, string> = {
  met: 'Met',
  partial: 'Partial',
  gap: 'Gap',
  unscored: 'Not scored',
  not_applicable: 'Not applicable',
};

/** `min_providers` is keyed by level id, with `default` covering levels not listed. */
function minProviders(section: PacketSection, targetLevelId: string): number | null {
  const mp = section.min_providers;
  if (!mp) return null;
  return mp[targetLevelId] ?? mp.default ?? null;
}

export function renderPacketMarkdown(review: ReviewResult, rubric: Rubric): PacketDraft {
  // Number every cited record once, in chronological order, for bookmarks.
  const cited = new Map<string, EvidenceItem>();
  for (const c of review.criteria) for (const i of c.cited) cited.set(i.ref, i);
  const ordered = [...cited.values()].sort((a, b) => a.date.localeCompare(b.date));
  const label = new Map(ordered.map((i, n) => [i.ref, `E${n + 1}`]));
  const bookmark = (i: EvidenceItem) => {
    const l = label.get(i.ref)!;
    return `[${l}](#evidence-${l.toLowerCase()})`;
  };

  const out: string[] = [];
  const counts: PacketDraft['word_counts'] = [];
  const violations: PacketDraft['writing_violations'] = [];
  const draft = (sectionId: string, text: string) => {
    for (const v of checkWriting(text, rubric.writing_rules)) violations.push({ ...v, section_id: sectionId });
    return text;
  };

  out.push(`# Promotion packet draft: ${review.current_level.title} to ${review.target_level.title}`);
  out.push(
    `Evidence range ${review.range.since.slice(0, 10)} to ${review.range.until.slice(0, 10)}. ` +
      `Scored against the ${review.target_level.code} column of the ${review.ladder.title} ladder.`
  );

  const assessable = (c: CriterionScore) => c.status !== 'not_applicable';

  for (const section of rubric.sections) {
    const body: string[] = [];
    let drafted = '';

    switch (section.kind) {
      case 'metadata':
        for (const f of section.fields ?? []) {
          const name = f.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase());
          const value =
            f === 'current_position'
              ? `${review.current_level.title} (${review.current_level.code})`
              : f === 'proposed_position'
                ? `${review.target_level.title} (${review.target_level.code})`
                : 'TODO';
          body.push(`- **${name}:** ${value}`);
        }
        break;

      case 'assessment':
        body.push(`> ${section.guidance ?? ''}`.trimEnd());
        for (const c of review.criteria.filter(assessable)) {
          body.push(`### ${c.title}`);
          body.push(`**Status:** ${STATUS_LABEL[c.status]}`);
          if (c.target_expectation) {
            body.push(`**${review.target_level.code} expectation:**`);
            body.push(quote(c.target_expectation));
          }
          const assessment = draft(section.id, c.rationale);
          drafted += ` ${assessment}`;
          body.push(`**Assessment:** ${assessment}`);
          if (c.cited.length) {
            body.push('**Evidence:**');
            for (const i of [...c.cited].sort((a, b) => a.date.localeCompare(b.date))) {
              body.push(`- ${i.date.slice(0, 10)}, ${i.title} ${bookmark(i)}`);
            }
          }
          if (c.status !== 'met' && c.missing) {
            const missing = draft(section.id, c.missing);
            drafted += ` ${missing}`;
            body.push(`**Missing:** ${missing}`);
          }
        }
        break;

      case 'narrative':
        if (section.id === 'growth_areas') {
          const [lo, hi] = section.count ?? [2, 3];
          const gaps = review.criteria
            .filter((c) => c.status === 'gap' || c.status === 'partial')
            .filter((c) => !c.manual_input_required)
            .slice(0, hi);
          body.push(todo(section));
          if (gaps.length < lo) {
            body.push(`> Fewer than ${lo} scored gaps; add growth areas from manager feedback.`);
          }
          for (const c of gaps) {
            const line = draft(section.id, c.missing || c.rationale);
            drafted += ` ${line}`;
            body.push(`- **${c.title}:** ${line}`);
          }
        } else {
          body.push(todo(section));
          const n = minProviders(section, review.target_level.id);
          if (n != null) body.push(`> Needs at least ${n} feedback providers for ${review.target_level.code}.`);
        }
        break;

      case 'appendix': {
        body.push(`> ${section.guidance ?? ''}`.trimEnd());
        if (ordered.length === 0) {
          body.push('No evidence was cited.');
          break;
        }
        const github = ordered.filter((i) => i.source === 'prs');
        const other = ordered.filter((i) => i.source !== 'prs');
        const groups: [string, EvidenceItem[]][] = [];
        for (const g of section.groups ?? []) groups.push([g, g === 'GitHub' ? github : []]);
        if (!(section.groups ?? []).includes('GitHub') && github.length) groups.push(['GitHub', github]);
        groups.push(['Captured activity', other]);
        for (const [name, items] of groups) {
          body.push(`### ${name}`);
          if (items.length === 0) {
            body.push('None captured.');
            continue;
          }
          for (const i of items) {
            const l = label.get(i.ref)!;
            const link = i.external_url ?? i.href;
            body.push(`- <a id="evidence-${l.toLowerCase()}"></a>**${l}.** ${i.date.slice(0, 10)}, [${i.title}](${link})`);
          }
        }
        break;
      }
    }

    const n = words(drafted);
    const limit = section.word_limit ?? null;
    counts.push({ section_id: section.id, words: n, limit, over_limit: limit != null && n > limit });
    out.push(`## ${section.title}`);
    out.push(body.join('\n\n'));
  }

  const checks = [
    `Draft checks (${review.target_level.code}, config ${review.config_version}):`,
    violations.length
      ? violations.map((v) => `- [${v.section_id}] ${v.message}`).join('\n')
      : '- No banned intensifiers or output-count padding in drafted prose.',
    ...counts.filter((c) => c.over_limit).map((c) => `- [${c.section_id}] ${c.words} words, limit ${c.limit}.`),
    '- STAR structure, quantification, why-now, and the bias checklist need a human pass.',
  ].join('\n');

  return {
    markdown: `<!--\n${checks}\n-->\n\n${out.join('\n\n')}\n`,
    word_counts: counts,
    writing_violations: violations,
  };
}
