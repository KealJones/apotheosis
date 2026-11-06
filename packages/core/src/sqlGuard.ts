/**
 * Server-side validation for the B5 database-browser's raw SQL box.
 *
 * IMPORTANT: this module is a fast, user-friendly *pre-check* that rejects
 * obviously-unsafe input with a clear error message before we even open a
 * connection. It is NOT the actual security boundary — a hand-rolled SQL
 * parser in JS is exactly the kind of naive allowlist that gets bypassed.
 * The real enforcement is:
 *   1. The query only ever runs against a connection opened with
 *      node:sqlite's `readOnly: true` (physically refuses writes at the
 *      SQLite VFS level — verified empirically, see readonlyDb.ts).
 *   2. That connection also installs a `setAuthorizer` callback (see
 *      apps/web/lib/db-query-worker.cjs) that denies every SQLite action
 *      except SELECT/READ/FUNCTION/RECURSIVE, and `enableDefensive(true)`.
 *      This is what actually stops tricks like `WITH x AS (...) INSERT ...`
 *      that start with a keyword this module allows.
 * This module's job is just to give a good error message for the common
 * case, and to enforce/rewrite the LIMIT clause (which the authorizer can't
 * do — denying isn't the same as capping row count).
 */

const FORBIDDEN_KEYWORDS = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create',
  'attach', 'detach', 'replace', 'truncate', 'vacuum', 'pragma',
  'reindex', 'savepoint', 'release', 'grant', 'revoke',
  'begin', 'commit', 'rollback', 'trigger',
];

export interface SqlValidationOk {
  ok: true;
  /** The (possibly LIMIT-rewritten) SQL to actually execute. */
  sql: string;
  /** The LIMIT that will actually apply, after taking the min with maxLimit. */
  appliedLimit: number;
}
export interface SqlValidationError {
  ok: false;
  error: string;
}
export type SqlValidationResult = SqlValidationOk | SqlValidationError;

/**
 * Replaces the contents of every string literal, quoted identifier, and
 * comment with spaces (preserving length/offsets so callers can still slice
 * the ORIGINAL string using indices found in the masked one). Also reports
 * whether a comment was found, since we reject those outright rather than
 * try to safely strip them.
 */
function maskStringsAndComments(sql: string): { masked: string; hasComment: boolean } {
  const chars = sql.split('');
  const masked = chars.slice();
  let hasComment = false;
  let i = 0;
  const n = chars.length;

  while (i < n) {
    const c = chars[i];

    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      masked[i] = ' ';
      i++;
      while (i < n) {
        if (chars[i] === quote) {
          // Doubled quote ('' or "") is an escaped quote inside the literal.
          if (chars[i + 1] === quote) {
            masked[i] = ' ';
            masked[i + 1] = ' ';
            i += 2;
            continue;
          }
          masked[i] = ' ';
          i++;
          break;
        }
        masked[i] = ' ';
        i++;
      }
      continue;
    }

    if (c === '[') {
      masked[i] = ' ';
      i++;
      while (i < n && chars[i] !== ']') {
        masked[i] = ' ';
        i++;
      }
      if (i < n) {
        masked[i] = ' ';
        i++;
      }
      continue;
    }

    if (c === '-' && chars[i + 1] === '-') {
      hasComment = true;
      while (i < n && chars[i] !== '\n') {
        masked[i] = ' ';
        i++;
      }
      continue;
    }

    if (c === '/' && chars[i + 1] === '*') {
      hasComment = true;
      masked[i] = ' ';
      masked[i + 1] = ' ';
      i += 2;
      while (i < n && !(chars[i] === '*' && chars[i + 1] === '/')) {
        masked[i] = ' ';
        i++;
      }
      if (i < n) {
        masked[i] = ' ';
        masked[i + 1] = ' ';
        i += 2;
      }
      continue;
    }

    i++;
  }

  return { masked: masked.join(''), hasComment };
}

export function validateSelectOnlyQuery(input: string, maxLimit = 1000): SqlValidationResult {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { ok: false, error: 'Query is empty.' };
  }

  // Strip exactly one trailing semicolon (a single statement ending with
  // ";" is normal and fine) before any structural checks.
  let body = input.trim();
  if (body.endsWith(';')) {
    body = body.slice(0, -1).trimEnd();
  }
  if (body.length === 0) {
    return { ok: false, error: 'Query is empty.' };
  }

  const { masked, hasComment } = maskStringsAndComments(body);

  if (hasComment) {
    return { ok: false, error: 'SQL comments (-- or /* */) are not allowed in the query box.' };
  }

  if (masked.includes(';')) {
    return { ok: false, error: 'Only a single SQL statement is allowed (remove the extra ";").' };
  }

  const firstWordMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(masked);
  const firstWord = firstWordMatch?.[1]?.toLowerCase();
  if (firstWord !== 'select' && firstWord !== 'with') {
    return { ok: false, error: 'Only SELECT (or WITH ... SELECT) queries are allowed.' };
  }

  const forbiddenRegex = new RegExp(`\\b(${FORBIDDEN_KEYWORDS.join('|')})\\b`, 'i');
  const forbiddenMatch = forbiddenRegex.exec(masked);
  if (forbiddenMatch) {
    return {
      ok: false,
      error: `"${forbiddenMatch[1].toUpperCase()}" is not allowed — only read-only SELECT queries are allowed.`,
    };
  }

  // Enforce/rewrite LIMIT. We take the LAST top-level "LIMIT n" occurrence
  // as the query's outer limit (a reasonable heuristic for hand-typed SQL —
  // subqueries with their own LIMIT are rare, and capping them too is not a
  // safety problem, just a possible over-restriction we accept here).
  const limitRegex = /\blimit\s+(\d+)/gi;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = limitRegex.exec(masked)) !== null) {
    lastMatch = m;
  }

  let sql = body;
  let appliedLimit: number;
  if (lastMatch) {
    const existing = parseInt(lastMatch[1], 10);
    appliedLimit = Math.min(existing, maxLimit);
    if (appliedLimit !== existing) {
      const start = lastMatch.index;
      const end = start + lastMatch[0].length;
      sql = body.slice(0, start) + `LIMIT ${appliedLimit}` + body.slice(end);
    }
  } else {
    appliedLimit = maxLimit;
    sql = `${body} LIMIT ${maxLimit}`;
  }

  return { ok: true, sql, appliedLimit };
}
