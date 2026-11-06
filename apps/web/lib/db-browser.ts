// Server-only helpers for the B5 database-browser feature (/db).
//
// Every query here is built from identifiers that were first checked against
// a server-fetched whitelist (real table names from sqlite_master, real
// column names from PRAGMA table_info) — never raw client text. Filter/sort
// VALUES are always passed as bound `?` parameters, never interpolated.
// This is the "known tables" browsing path; the separate raw-SQL box (see
// app/api/db/query/route.ts) is what runs arbitrary user-typed SQL.
import "server-only";
import { getReadOnlyDb } from "@/lib/data";

export interface TableSummary {
  name: string;
  rowCount: number;
}

export interface TableRowsResult {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
}

export interface TableRowsQuery {
  page: number;
  pageSize: number;
  sortColumn?: string;
  sortDir?: "asc" | "desc";
  filters?: Record<string, string>;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Real, user-created tables only — excludes sqlite's own bookkeeping tables. */
export function listTables(): TableSummary[] {
  const db = getReadOnlyDb();
  const names = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    )
    .all() as { name: string }[];

  return names.map(({ name }) => {
    const { c } = db.prepare(`SELECT COUNT(*) as c FROM ${quoteIdent(name)}`).get() as { c: number };
    return { name, rowCount: c };
  });
}

/** Throws if `table` isn't a real table name from sqlite_master (the whitelist). */
export function assertRealTable(table: string): void {
  const db = getReadOnlyDb();
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  if (!row) {
    throw new Error(`Unknown table: ${table}`);
  }
}

export function getTableColumns(table: string): string[] {
  assertRealTable(table);
  const db = getReadOnlyDb();
  const info = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[];
  return info.map((c) => c.name);
}

const MAX_PAGE_SIZE = 500;

export function queryTableRows(table: string, query: TableRowsQuery): TableRowsResult {
  assertRealTable(table);
  const columns = getTableColumns(table);
  const columnSet = new Set(columns);

  const pageSize = Math.min(Math.max(1, query.pageSize), MAX_PAGE_SIZE);
  const page = Math.max(1, query.page);
  const offset = (page - 1) * pageSize;

  const db = getReadOnlyDb();

  const whereClauses: string[] = [];
  const params: string[] = [];
  for (const [col, value] of Object.entries(query.filters ?? {})) {
    if (!columnSet.has(col) || value.trim() === "") continue;
    whereClauses.push(`${quoteIdent(col)} LIKE ?`);
    params.push(`%${value}%`);
  }
  const where = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const { total } = db
    .prepare(`SELECT COUNT(*) as total FROM ${quoteIdent(table)} ${where}`)
    .get(...params) as { total: number };

  let orderBy = "";
  if (query.sortColumn && columnSet.has(query.sortColumn)) {
    const dir = query.sortDir === "desc" ? "DESC" : "ASC";
    orderBy = `ORDER BY ${quoteIdent(query.sortColumn)} ${dir}`;
  }

  const rows = db
    .prepare(
      `SELECT * FROM ${quoteIdent(table)} ${where} ${orderBy} LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset) as Record<string, unknown>[];

  return { columns, rows, total };
}

export function rowsToCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const str = String(value);
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [columns.map(escape).join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => escape(row[col])).join(","));
  }
  return lines.join("\n");
}
