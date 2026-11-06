import { DatabaseSync } from 'node:sqlite';
import { getDbPath } from './db.js';

/**
 * A SEPARATE connection from getDb()'s read-write singleton, used by the B5
 * database-browser feature (table picker, paginated grid). Opened with
 * node:sqlite's `readOnly` option, which enforces read-only at the SQLite
 * VFS level (verified manually: a DELETE/INSERT/UPDATE against a connection
 * opened this way throws "attempt to write a readonly database" — this is
 * not just an API label, it's real enforcement).
 *
 * This module is for browsing known tables/columns with server-built,
 * fully-parameterized queries. It intentionally does NOT run arbitrary
 * user-typed SQL — that's handled by db-query-worker.cjs in apps/web, which
 * opens its own connection per-query inside a worker thread so a runaway
 * query can be killed with worker.terminate().
 */
let _roDb: DatabaseSync | null = null;

export function getReadOnlyDb(): DatabaseSync {
  if (_roDb) return _roDb;
  _roDb = new DatabaseSync(getDbPath(), { readOnly: true });
  return _roDb;
}

/** @internal — Test-only: reset the singleton so getReadOnlyDb() reconnects. */
export function _resetReadOnlyDb(): void {
  if (_roDb) {
    try {
      _roDb.close();
    } catch {
      // already closed — ignore
    }
  }
  _roDb = null;
}
