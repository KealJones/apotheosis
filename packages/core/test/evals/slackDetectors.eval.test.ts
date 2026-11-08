/**
 * Precision/recall of the Slack detectors against YOUR real captured messages and a real
 * local model. Skipped unless APOTHEOSIS_SLACK_EVAL=1 (needs the real DB and Ollama).
 *
 *   APOTHEOSIS_SLACK_EVAL=1 APOTHEOSIS_OLLAMA_MODEL=gemma4:e2b \
 *     pnpm --filter @apotheosis/core exec vitest run test/evals/slackDetectors.eval.test.ts
 *
 * slack-labels.json holds hand labels keyed by dedupe_hash only (sha256 of the permalink),
 * so no message text lives in the repo; the text is joined from the local DB at run time.
 * Sets (all sent by/to me, Aug 2026 unless noted):
 *   promise          100 of my messages: every promise-prefilter survivor + random others,
 *                    so prefilter recall is measured too. Prompts were iterated against this.
 *   promise_heldout  60 of my July messages, labeled but NOT looked at while tuning, to
 *                    check the iteration didn't just overfit `promise`.
 *   inbound          100 messages to me: 70 random inbound-prefilter survivors, 30 others.
 *
 * The DB is opened read-only (SQLite-enforced). Classifications are memoized in a temp
 * file with the same cache keys the detectors use, so re-runs after a no-op are instant
 * and a PROMPT_VERSION bump re-classifies everything.
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { accepted, MIN_CONFIDENCE, PROMPT_VERSION } from '../../src/commitments/detectors/slackClassify.js';
import { classifyInbound, classifyOutbound, type Classified, type Scan } from '../../src/commitments/detectors/slackScan.js';
import { laterReplyFromMe, loadIdentity, loadMessages, promisePrefilter } from '../../src/commitments/detectors/slackMessages.js';
import { waitsOnMe } from '../../src/commitments/detectors/slackUnanswered.js';
import type { DetectorCache } from '../../src/commitments/types.js';
import labels from './slack-labels.json';

const ENABLED = process.env.APOTHEOSIS_SLACK_EVAL === '1';
const SINCE = Math.floor(Date.parse('2026-07-01T00:00:00Z') / 1000);

function fileCache(file: string): DetectorCache {
  const data: Record<string, string> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return {
    get: (k) => data[k],
    set: (k, v) => {
      data[k] = v;
      fs.writeFileSync(file, JSON.stringify(data));
    },
  };
}

interface Score { tp: number; fp: number; fn: number; tn: number; precision: number; recall: number }
function score(truth: Map<string, boolean>, predicted: Set<string>): Score {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const [h, t] of truth) {
    const p = predicted.has(h);
    if (t && p) tp++; else if (!t && p) fp++; else if (t && !p) fn++; else tn++;
  }
  return { tp, fp, fn, tn, precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn) };
}

describe.skipIf(!ENABLED)('slack detectors eval (real data, real model)', () => {
  const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), 'Library', 'Application Support', 'apotheosis');
  const db = ENABLED ? new DatabaseSync(path.join(dataDir, 'apotheosis.db'), { readOnly: true }) : null;
  const cache = fileCache(path.join(os.tmpdir(), 'apotheosis-slack-eval-cache.json'));

  function scan(): Scan {
    const id = loadIdentity();
    const all = loadMessages(db!, SINCE, id);
    return { id, all, mine: all.filter((m) => m.fromMe) };
  }

  // Vitest hides console output of passing tests; keep a file copy of the numbers.
  const reportFile = path.join(os.tmpdir(), 'apotheosis-slack-eval-report.txt');
  const log = (line: string) => {
    console.log(line);
    fs.appendFileSync(reportFile, line + '\n');
  };

  function report(name: string, s: Score, errs: Array<[string, Classified | undefined, string]>) {
    log(`\n== ${name} (prompt ${PROMPT_VERSION}, min_conf ${MIN_CONFIDENCE}, model ${process.env.APOTHEOSIS_OLLAMA_MODEL ?? 'default'})`);
    log(`   precision ${s.precision.toFixed(3)}  recall ${s.recall.toFixed(3)}  tp ${s.tp} fp ${s.fp} fn ${s.fn} tn ${s.tn}`);
    for (const [kind, x, text] of errs) {
      const c = x?.c;
      log(`   ${kind} ${c ? `conf=${c.confidence} quote="${c.quote}" title="${c.title}"` : '(not classified: prefilter rejected or model call failed)'} :: ${text.replace(/\s+/g, ' ').slice(0, 140)}`);
    }
  }

  it.each(['promise', 'promise_heldout'] as const)('slack_%s', { timeout: 4 * 3600_000 }, async (set_) => {
    const s = scan();
    const byHash = new Map(s.all.map((m) => [m.dedupe_hash, m]));
    const truth = new Map(Object.entries(labels[set_]).filter(([h]) => byHash.has(h)));
    expect(truth.size).toBe(Object.keys(labels[set_]).length);
    const set = [...truth.keys()].map((h) => byHash.get(h)!);
    const results = new Map((await classifyOutbound(s, set, { cache })).map((x) => [x.m.dedupe_hash, x]));
    const failed = set.filter((m) => promisePrefilter(m) && !results.has(m.dedupe_hash)).length;
    if (failed) log(`   WARNING ${failed} prefilter survivors failed to classify (timeout/bad JSON); re-run to retry`);
    const predicted = new Set([...results.values()].filter((x) => accepted(x.c, 'is_commitment')).map((x) => x.m.dedupe_hash));
    const sc = score(truth, predicted);
    const errs: Array<[string, Classified | undefined, string]> = [];
    for (const [h, t] of truth) {
      if (t !== predicted.has(h)) errs.push([t ? 'FN' : 'FP', results.get(h), byHash.get(h)!.text]);
    }
    report(`slack_${set_}`, sc, errs);
    const prefilterFn = [...truth].filter(([h, t]) => t && !promisePrefilter(byHash.get(h)!)).length;
    log(`   prefilter dropped ${prefilterFn} of ${sc.tp + sc.fn} true promises`);
  });

  it('slack_ask + slack_unanswered', { timeout: 4 * 3600_000 }, async () => {
    const s = scan();
    const byHash = new Map(s.all.map((m) => [m.dedupe_hash, m]));
    const entries = Object.entries(labels.inbound).filter(([h]) => byHash.has(h));
    expect(entries.length).toBe(Object.keys(labels.inbound).length);
    const set = entries.map(([h]) => byHash.get(h)!);
    const results = new Map((await classifyInbound(s, set, { cache })).map((x) => [x.m.dedupe_hash, x]));

    const askTruth = new Map(entries.map(([h, l]) => [h, l.ask]));
    const askPred = new Set([...results.values()].filter((x) => accepted(x.c, 'is_commitment')).map((x) => x.m.dedupe_hash));
    const askErrs: Array<[string, Classified | undefined, string]> = [];
    for (const [h, t] of askTruth) if (t !== askPred.has(h)) askErrs.push([t ? 'FN' : 'FP', results.get(h), byHash.get(h)!.text]);
    report('slack_ask', score(askTruth, askPred), askErrs);

    // Unanswered truth = labeled "question for me" AND no later reply from me. The reply
    // check is the same deterministic code the detector uses, so this measures the classifier.
    const unanswered = (h: string) => !laterReplyFromMe(byHash.get(h)!, s.mine);
    const qTruth = new Map(entries.filter(([h]) => unanswered(h)).map(([h, l]) => [h, l.question]));
    const qPred = new Set(
      [...results.values()]
        .filter((x) => unanswered(x.m.dedupe_hash) && accepted(x.c, 'expects_reply') && waitsOnMe(x, s.id))
        .map((x) => x.m.dedupe_hash),
    );
    const qErrs: Array<[string, Classified | undefined, string]> = [];
    for (const [h, t] of qTruth) if (t !== qPred.has(h)) qErrs.push([t ? 'FN' : 'FP', results.get(h), byHash.get(h)!.text]);
    report(`slack_unanswered (${qTruth.size} of ${entries.length} have no later reply from me)`, score(qTruth, qPred), qErrs);
  });
});
