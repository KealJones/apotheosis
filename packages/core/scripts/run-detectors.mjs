#!/usr/bin/env node
// Scheduled entry point for the commitment detector run (C8). Invoked by the
// com.kealjones.apotheosis.detectors LaunchAgent (see the plist next to this
// file), not by the web server - the plan is explicit that the dashboard
// "reads the table; it never blocks on `gh`." Runs against the real database
// (getDataDir()'s default), same as the capture daemon and MCP server.
//
// Manual invocation for testing: `node packages/core/scripts/run-detectors.mjs`
// (requires `pnpm --filter @apotheosis/core build` first, since this imports
// the compiled dist, not the TypeScript source).
import { runScheduledPass } from '../dist/index.js';

const started = Date.now();
const pass = await runScheduledPass({ guard: true });
const report = pass.detectors;
const elapsedMs = Date.now() - started;

const totalDetected = report.detectors.reduce((n, d) => n + d.detected, 0);
const totalInserted = report.detectors.reduce((n, d) => n + d.inserted, 0);
const totalResolved = report.detectors.reduce((n, d) => n + d.resolved, 0);
const errors = report.detectors.flatMap((d) => d.errors.map((e) => `${d.id}: ${e}`));

console.log(
  `[run-detectors] ${new Date(report.now * 1000).toISOString()} ` +
  `detected=${totalDetected} inserted=${totalInserted} resolved=${totalResolved} ` +
  `woken=${report.woken} expired=${report.expired} elapsed_ms=${elapsedMs}`,
);

if (pass.local_model_skipped) {
  console.log(`[run-detectors] skipped local-model work: ${pass.local_model_skipped}`);
}
if (pass.digest) {
  const d = pass.digest;
  console.log(`[run-detectors] slack digest: conversations=${d.conversations} digested=${d.digested} unchanged=${d.unchanged}`);
  errors.push(...d.errors.map((e) => `slack_digest: ${e}`));
}
if (pass.unloaded_model) console.log('[run-detectors] unloaded local model');

if (errors.length > 0) {
  console.error(`[run-detectors] ${errors.length} detector error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
}

// A detector throwing is recorded in the report, not fatal to the run (see runner.ts) -
// so this process exits 0 even with errors logged above. A LaunchAgent retrying a
// transient `gh`/Ollama failure every interval is the desired behavior, not a crash loop.
