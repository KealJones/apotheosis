// Executes the raw-SQL box's user-typed query. This is the ONE place in the
// app that runs SQL text a human typed directly, so it gets the paranoid
// treatment:
//
//   1. validateSelectOnlyQuery() (packages/core/src/sqlGuard.ts) rejects
//      anything that isn't a single SELECT/WITH-SELECT, and rewrites the
//      LIMIT down to at most 1000 rows.
//   2. The query runs in a worker_thread, on its OWN node:sqlite connection
//      (opened readOnly, with enableDefensive(true) and a setAuthorizer that
//      denies every action except SELECT/READ/FUNCTION/RECURSIVE). This is
//      real, verified defense-in-depth — see packages/core/test/readonlyDb.test.ts
//      and sqlGuard.ts's header comment for what was actually tested.
//   3. node:sqlite's DatabaseSync is fully synchronous with no cancellation
//      API, so a runaway query (e.g. a pathological recursive CTE) would
//      block the thread it runs on forever. Running it in a worker_thread
//      means we can call worker.terminate() after a timeout to actually kill
//      it — verified manually: a `WITH RECURSIVE` counting to 2*10^8 gets
//      forcibly terminated instead of blocking.
import "server-only";
import { Worker } from "node:worker_threads";
import { getDbPath, validateSelectOnlyQuery } from "@/lib/data";

// Plain CommonJS source run via `eval: true` — this avoids any path
// resolution mismatch between `next dev` and a built `next start` output,
// since worker_threads can't reliably locate a sibling .ts/.js file across
// both without a bundler-specific asset pipeline.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync, constants } = require('node:sqlite');

try {
  const db = new DatabaseSync(workerData.dbPath, { readOnly: true });
  db.enableDefensive(true);
  db.setAuthorizer((action) => {
    const allowed = new Set([
      constants.SQLITE_SELECT,
      constants.SQLITE_READ,
      constants.SQLITE_FUNCTION,
      constants.SQLITE_RECURSIVE,
    ]);
    return allowed.has(action) ? constants.SQLITE_OK : constants.SQLITE_DENY;
  });
  const stmt = db.prepare(workerData.sql);
  const rows = stmt.all();
  db.close();
  parentPort.postMessage({ ok: true, rows });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
`;

export class QueryRejectedError extends Error {}
export class QueryTimeoutError extends Error {}

export interface RunQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  appliedLimit: number;
  sql: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_LIMIT = 1000;

export async function runReadOnlyQuery(
  rawSql: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<RunQueryResult> {
  const validation = validateSelectOnlyQuery(rawSql, MAX_LIMIT);
  if (!validation.ok) {
    throw new QueryRejectedError(validation.error);
  }

  const dbPath = getDbPath();

  const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { dbPath, sql: validation.sql },
    });

    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new QueryTimeoutError(`Query timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    worker.on(
      "message",
      (msg: { ok: boolean; rows?: Record<string, unknown>[]; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        if (msg.ok) {
          resolve(msg.rows ?? []);
        } else {
          reject(new QueryRejectedError(msg.error ?? "Query failed"));
        }
      }
    );

    worker.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    worker.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Query worker exited unexpectedly (code ${code})`));
    });
  });

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  return { columns, rows, appliedLimit: validation.appliedLimit, sql: validation.sql };
}
