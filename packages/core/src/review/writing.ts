/**
 * Mechanical checks for promo-packet.yaml's `rules.writing`, run on any prose
 * the scorer or exporter drafts. Only rules that can be checked mechanically
 * are checked here; STAR, why-now, and the bias pass need a human read.
 *
 * Quoted source material (ladder expectation text, the user's own standups)
 * is not drafted prose and is not run through this.
 */
import type { WritingRule } from './rubric.js';

export interface WritingViolation {
  rule_id: string;
  /** The offending text as it appears. */
  match: string;
  index: number;
  message: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A bare count of work items standing in for an outcome ("merged 14 PRs").
const OUTPUT_COUNT_RE =
  /\b\d[\d,]*\+?\s+(?:(?:merged|closed|opened|reviewed|completed|resolved|shipped)\s+)?(?:pull requests?|PRs?|tickets?|Jira tickets?|issues?|commits?|stories|story points)\b/gi;

export function checkWriting(text: string, rules: WritingRule[]): WritingViolation[] {
  const out: WritingViolation[] = [];
  for (const rule of rules) {
    if (rule.id === 'banned_intensifiers') {
      const banned = rule.banned ?? [];
      if (banned.length === 0) continue;
      const re = new RegExp(`\\b(?:${banned.map(escapeRe).join('|')})\\b`, 'gi');
      for (const m of text.matchAll(re)) {
        out.push({
          rule_id: rule.id,
          match: m[0],
          index: m.index ?? 0,
          message: `"${m[0]}" is a banned intensifier. Replace it with the number it stands in for.`,
        });
      }
    } else if (rule.id === 'outcome_not_output') {
      for (const m of text.matchAll(OUTPUT_COUNT_RE)) {
        out.push({
          rule_id: rule.id,
          match: m[0],
          index: m.index ?? 0,
          message: `"${m[0]}" reports output, not outcome. State what the work changed.`,
        });
      }
    }
  }
  return out.sort((a, b) => a.index - b.index);
}
