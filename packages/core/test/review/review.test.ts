import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { ensureReviewScoreCache } from '../../src/db.js';
import {
  checkWriting,
  collectEvidence,
  getEvidenceItem,
  getLevel,
  loadRubric,
  renderPacketMarkdown,
  scoreReview,
  type Rubric,
} from '../../src/review/index.js';
import type { OllamaChatMessage } from '../../src/llm/ollama.js';

// The committed example rubric, never the user's own config in the data dir.
const REPO_CONFIG = path.resolve(__dirname, '../../../../config');
// A year the shared fixture has no rows in, so every review row here is ours.
const RANGE = { since: '2024-01-01T00:00:00Z', until: '2024-12-31T23:59:59Z' };
const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

let db: DatabaseSync;
let rubric: Rubric;
let aiLogDir: string;

beforeAll(() => {
  db = setupTestDb();
  ensureReviewScoreCache(db);
  rubric = loadRubric(REPO_CONFIG);
  aiLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-ailog-'));
  process.env.APOTHEOSIS_AI_USAGE_LOG_DIR = aiLogDir;
});
afterAll(() => {
  teardownTestDb();
  fs.rmSync(aiLogDir, { recursive: true, force: true });
  delete process.env.APOTHEOSIS_AI_USAGE_LOG_DIR;
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.exec('DELETE FROM review_score_cache');
});

function insertStandup(date: string, yesterday: string): number {
  return Number(
    db.prepare('INSERT INTO standups (date, yesterday, today, blockers, generated_at) VALUES (?, ?, NULL, NULL, ?)')
      .run(date, yesterday, at(date)).lastInsertRowid
  );
}

/** Pulls every `[ref]` the scorer showed the model out of the user message. */
function shownRefs(messages: OllamaChatMessage[]): string[] {
  return [...messages[1].content.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]);
}

function criterionOf(messages: OllamaChatMessage[]): string {
  return messages[1].content.match(/^Criterion: ([^\n(]+)/)![1].trim();
}

// ── rubric ────────────────────────────────────────────────────────────────────

describe('loadRubric', () => {
  function tempConfig(mutateLadder: (s: string) => string, mutatePacket: (s: string) => string = (s) => s): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-rubric-'));
    for (const f of ['promo-packet.yaml', 'leveling-example.yaml']) {
      const raw = fs.readFileSync(path.join(REPO_CONFIG, f), 'utf8');
      fs.writeFileSync(path.join(dir, f), f.startsWith('promo') ? mutatePacket(raw) : mutateLadder(raw));
    }
    return dir;
  }

  it('loads the example config, resolving ladder_ref', () => {
    expect(rubric.levels.map((l) => l.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(rubric.criteria).toHaveLength(7);
    expect(rubric.defaults).toEqual({ current_level: 'p3', target_level: 'p4' });
    // Legitimately empty cells survive as null.
    expect(rubric.criteria.find((c) => c.id === 'software_design')!.expectations.p1).toBeNull();
  });

  it('throws on an evidence source the evidence layer does not produce', () => {
    const dir = tempConfig((s) => s.replace('evidence_sources: [projects, standups]', 'evidence_sources: [projects, jira_tickets]'));
    expect(() => loadRubric(dir)).toThrow(/"jira_tickets", which the evidence layer does not produce/);
  });

  it('throws on an unknown default level', () => {
    const dir = tempConfig((s) => s, (s) => s.replace('target_level: p4', 'target_level: p9'));
    expect(() => loadRubric(dir)).toThrow(/defaults.target_level is "p9"/);
  });

  it('throws when a criterion is missing a level', () => {
    const dir = tempConfig((s) => s.replace(/      p1: \|-\n        I ship well-scoped tasks with guidance from teammates\n/, ''));
    expect(() => loadRubric(dir)).toThrow(/"role_focus" is missing level "p1"/);
  });

  it('getLevel throws on an unknown level instead of defaulting', async () => {
    expect(() => getLevel(rubric, 'p10')).toThrow(/Unknown level "p10"/);
    await expect(scoreReview({ rubric, target_level: 'staff', ...RANGE })).rejects.toThrow(/Unknown level "staff"/);
  });
});

// ── writing rules ─────────────────────────────────────────────────────────────

describe('checkWriting', () => {
  it('flags every banned intensifier, case-insensitively, on word boundaries', () => {
    const v = checkWriting('This Significantly cut build time and was very well received. Everybody agreed.', rubric.writing_rules);
    expect(v.filter((x) => x.rule_id === 'banned_intensifiers').map((x) => x.match)).toEqual(['Significantly', 'very']);
  });

  it('flags bare output counts under outcome_not_output', () => {
    const v = checkWriting('Merged 14 PRs and closed 30 tickets.', rubric.writing_rules);
    expect(v.filter((x) => x.rule_id === 'outcome_not_output').map((x) => x.match)).toEqual(['14 PRs', '30 tickets']);
  });

  it('passes clean, quantified prose', () => {
    expect(checkWriting('Cut CI time from 22 to 9 minutes for 6 teams.', rubric.writing_rules)).toEqual([]);
  });
});

// ── evidence + scoring ────────────────────────────────────────────────────────

describe('scoreReview integrity', () => {
  it('scores every applicable criterion as a rule-decided gap when there is no evidence, without calling the model', async () => {
    const chatFn = vi.fn();
    const r = await scoreReview({ rubric, ...RANGE, chatFn });
    expect(chatFn).not.toHaveBeenCalled();
    for (const c of r.criteria) {
      expect(c.status).toBe('gap');
      expect(c.decided_by).toBe('rule');
      expect(c.cited).toEqual([]);
    }
    expect(r.criteria.find((c) => c.criterion_id === 'required_experience')!.manual_input_required).toBe(true);
    expect(r.summary.coverage).toBe(0);
  });

  it('flip test: a met criterion drops as its cited rows are deleted', async () => {
    const leadA = insertStandup('2024-02-05', 'Led the cross-team migration to the new build system for 4 teams.');
    const leadB = insertStandup('2024-06-10', 'Led the cross-team rollout of the release checklist for 3 teams.');
    const otherId = insertStandup('2024-03-05', 'Fixed a typo in the README.');

    // A model that calls role_focus "met" on any leadership standup it sees, and cites all of them.
    const chatFn = vi.fn(async (messages: OllamaChatMessage[]) => {
      const leads = shownRefs(messages).filter((r) => r === `standups:${leadA}` || r === `standups:${leadB}`);
      if (criterionOf(messages) === 'Role Focus' && leads.length) {
        return JSON.stringify({ status: 'met', cited_refs: leads, rationale: 'Led cross-team rollouts.', missing: '' });
      }
      return JSON.stringify({ status: 'gap', cited_refs: [], rationale: 'Nothing at the bar.', missing: 'More.' });
    });
    const role = async () => (await scoreReview({ rubric, ...RANGE, chatFn })).criteria.find((c) => c.criterion_id === 'role_focus')!;

    const before = await role();
    expect(before.status).toBe('met');
    expect(before.cited.map((i) => i.ref).sort()).toEqual([`standups:${leadA}`, `standups:${leadB}`].sort());
    // Each citation resolves to the real row.
    for (const i of before.cited) expect(getEvidenceItem(i.ref)!.text).toMatch(/^Done: Led the cross-team/);

    // Delete one cited row: the remaining citation no longer shows sustained behavior.
    db.prepare('DELETE FROM standups WHERE id = ?').run(leadB);
    expect(getEvidenceItem(`standups:${leadB}`)).toBeNull();
    const mid = await role();
    expect(mid.cached).toBe(false); // evidence fingerprint changed, so the cached "met" was not reused
    expect(mid.status).toBe('partial');
    expect(mid.rationale).toMatch(/^Held at partial/);

    // Delete the other: nothing left to cite.
    db.prepare('DELETE FROM standups WHERE id = ?').run(leadA);
    const after = await role();
    expect(after.status).toBe('gap');
    expect(after.cited).toEqual([]);

    db.prepare('DELETE FROM standups WHERE id = ?').run(otherId);
  });

  it('holds a met at partial when citations do not span the sustained-behavior window', async () => {
    const a = insertStandup('2024-02-01', 'Led the incident review.');
    const b = insertStandup('2024-02-20', 'Led the follow-up.');
    const r = await scoreReview({
      rubric,
      ...RANGE,
      chatFn: async (m) => JSON.stringify({ status: 'met', cited_refs: shownRefs(m), rationale: 'Led reviews.', missing: '' }),
    });
    const c = r.criteria.find((x) => x.criterion_id === 'role_focus')!;
    expect(rubric.sustained_behavior_months).toBe(3);
    expect(c.status).toBe('partial');
    expect(c.rationale).toMatch(/spans 19 days/);
    db.prepare('DELETE FROM standups WHERE id IN (?, ?)').run(a, b);
  });

  it('matches refs echoed with header text or run together, but never a near-miss id', async () => {
    const id1 = insertStandup('2024-04-15', 'Wrote the design doc for the queue.');
    const id2 = insertStandup('2024-04-16', 'Reviewed the queue design with the platform team.');
    const r = await scoreReview({
      rubric,
      ...RANGE,
      chatFn: async () =>
        JSON.stringify({
          status: 'partial',
          cited_refs: [
            `[standups:${id1}] 2024-04-15 Standup 2024-04-15`,
            `standups:${id2}][standups:${id2}0`,
            'unrelated prose with no ref',
          ],
          rationale: 'Some.',
          missing: ['a', 'b'],
        }),
    });
    const c = r.criteria.find((x) => x.criterion_id === 'role_focus')!;
    expect(c.status).toBe('partial');
    expect(c.cited.map((i) => i.ref).sort()).toEqual([`standups:${id1}`, `standups:${id2}`].sort());
    expect(c.rejected_citations).toEqual([`standups:${id2}0`, 'unrelated prose with no ref']);
    expect(c.missing).toBe('a; b');
    db.prepare('DELETE FROM standups WHERE id IN (?, ?)').run(id1, id2);
  });

  it('drops fabricated citations and downgrades an uncited met to gap', async () => {
    const id = insertStandup('2024-04-01', 'Paired with a new hire on the release checklist.');
    const chatFn = vi.fn(async () =>
      JSON.stringify({ status: 'met', cited_refs: ['standups:987654', 'slack_signals:1'], rationale: 'Clearly met.', missing: '' })
    );
    const r = await scoreReview({ rubric, ...RANGE, chatFn });
    const c = r.criteria.find((x) => x.criterion_id === 'role_focus')!;
    expect(c.status).toBe('gap');
    expect(c.cited).toEqual([]);
    expect(c.rejected_citations).toEqual(['standups:987654', 'slack_signals:1']);
    expect(c.rationale).toMatch(/^Downgraded from "met" to "gap"/);
    db.prepare('DELETE FROM standups WHERE id = ?').run(id);
  });

  it('caches by evidence fingerprint: reuses on no change, rescores when evidence is added', async () => {
    const id = insertStandup('2024-05-01', 'Wrote the on-call runbook.');
    const chatFn = vi.fn(async (messages: OllamaChatMessage[]) =>
      JSON.stringify({ status: 'partial', cited_refs: shownRefs(messages).slice(0, 1), rationale: 'Some.', missing: 'More.' })
    );
    await scoreReview({ rubric, ...RANGE, chatFn });
    const firstCalls = chatFn.mock.calls.length;
    expect(firstCalls).toBeGreaterThan(0);

    const again = await scoreReview({ rubric, ...RANGE, chatFn });
    expect(chatFn.mock.calls.length).toBe(firstCalls);
    expect(again.criteria.find((c) => c.criterion_id === 'role_focus')!.cached).toBe(true);

    // Same days, different clock time: ranges are whole UTC days, so still a cache hit.
    await scoreReview({ rubric, since: '2024-01-01T15:00:00Z', until: '2024-12-31T08:00:00Z', chatFn });
    expect(chatFn.mock.calls.length).toBe(firstCalls);

    const id2 = insertStandup('2024-05-02', 'Ran the incident review.');
    await scoreReview({ rubric, ...RANGE, chatFn });
    expect(chatFn.mock.calls.length).toBeGreaterThan(firstCalls);

    // A different target level is a different cache entry.
    const callsBefore = chatFn.mock.calls.length;
    await scoreReview({ rubric, ...RANGE, chatFn, target_level: 'p5' });
    expect(chatFn.mock.calls.length).toBeGreaterThan(callsBefore);

    db.prepare('DELETE FROM standups WHERE id IN (?, ?)').run(id, id2);
  });

  it('never guesses when Ollama is unreachable: criteria with evidence are unscored', async () => {
    const id = insertStandup('2024-06-01', 'Shipped the thing.');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const r = await scoreReview({ rubric, ...RANGE });
    expect(r.llm_error).toMatch(/Ollama is not reachable/);
    const c = r.criteria.find((x) => x.criterion_id === 'role_focus')!;
    expect(c.status).toBe('unscored');
    expect(c.cited).toEqual([]);
    expect(r.summary.complete).toBe(false);
    db.prepare('DELETE FROM standups WHERE id = ?').run(id);
  });

  it('marks a criterion unscored (not defaulted) when the model returns junk', async () => {
    const id = insertStandup('2024-07-01', 'Did work.');
    const r = await scoreReview({ rubric, ...RANGE, chatFn: async () => '{"status":"excellent"}' });
    const c = r.criteria.find((x) => x.criterion_id === 'role_focus')!;
    expect(c.status).toBe('unscored');
    expect(c.error).toMatch(/did not match the verdict shape/);
    db.prepare('DELETE FROM standups WHERE id = ?').run(id);
  });

  it('flags banned intensifiers in the model rationale', async () => {
    const id = insertStandup('2024-08-01', 'Led the design review for the payments API.');
    const r = await scoreReview({
      rubric,
      ...RANGE,
      chatFn: async (m) =>
        JSON.stringify({ status: 'partial', cited_refs: shownRefs(m).slice(0, 1), rationale: 'Significantly improved design.', missing: 'More.' }),
    });
    const c = r.criteria.find((x) => x.criterion_id === 'role_focus')!;
    expect(c.writing_violations.map((v) => v.match)).toEqual(['Significantly']);
    db.prepare('DELETE FROM standups WHERE id = ?').run(id);
  });
});

describe('collectEvidence', () => {
  it('only returns records in range, each resolvable by ref', () => {
    const inRange = insertStandup('2024-09-01', 'In range.');
    const outOfRange = insertStandup('2023-12-31', 'Out of range.');
    db.prepare('INSERT INTO slack_messages (captured_at, channel, sender, text, dedupe_hash) VALUES (?, ?, ?, ?, ?)')
      .run(at('2024-09-02'), 'eng', 'Pat Lee', 'Thanks for unblocking the release!', 'review-test-1');
    const ev = collectEvidence(RANGE);
    expect(ev.standups.map((i) => i.key)).toEqual([String(inRange)]);
    expect(ev.slack_signals).toHaveLength(1);
    expect(ev.slack_signals[0].text).toMatch(/^From Pat Lee \(not me\)/);
    for (const i of [...ev.standups, ...ev.slack_signals]) expect(getEvidenceItem(i.ref)?.ref).toBe(i.ref);
    db.prepare('DELETE FROM standups WHERE id IN (?, ?)').run(inRange, outOfRange);
    db.prepare("DELETE FROM slack_messages WHERE dedupe_hash = 'review-test-1'").run();
  });

  it('refuses path traversal through an ai_usage_wins ref', () => {
    expect(getEvidenceItem('ai_usage_wins:../../etc/passwd')).toBeNull();
  });
});

describe('renderPacketMarkdown', () => {
  it('follows section order, uses bookmarks, and flags banned words in drafted prose', async () => {
    const id = insertStandup('2024-10-01', 'Led the rollout; see https://example.com/pr/1.');
    const r = await scoreReview({
      rubric,
      ...RANGE,
      chatFn: async (m) =>
        JSON.stringify({ status: 'met', cited_refs: shownRefs(m).slice(0, 1), rationale: 'This was a very strong rollout.', missing: '' }),
    });
    const draft = renderPacketMarkdown(r, rubric);
    const headings = [...draft.markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(rubric.sections.map((s) => s.title));

    const assessment = draft.markdown.split('## Promotion Assessment')[1].split('## 360 Feedback')[0];
    expect(assessment).toMatch(/\[E1\]\(#evidence-e1\)/);
    expect(assessment).not.toMatch(/\]\(https?:/); // no inline external links outside the appendix
    expect(draft.markdown).toMatch(/<a id="evidence-e1"><\/a>\*\*E1\.\*\*/);

    expect(draft.writing_violations.some((v) => v.match === 'very' && v.section_id === 'promotion_assessment')).toBe(true);
    expect(draft.markdown).toMatch(/"very" is a banned intensifier/);
    db.prepare('DELETE FROM standups WHERE id = ?').run(id);
  });
});
