"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Play, Terminal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

interface TableSummary {
  name: string;
  rowCount: number;
}

interface TableRowsResponse {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}

interface RawQueryResponse {
  columns: string[];
  rows: Record<string, unknown>[];
  appliedLimit: number;
  sql: string;
}

const PAGE_SIZE_OPTIONS = [25, 50, 100, 250];
const FILTER_DEBOUNCE_MS = 300;

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function DbBrowser() {
  const [tables, setTables] = useState<TableSummary[] | null>(null);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [filterDrafts, setFilterDrafts] = useState<Record<string, string>>({});

  const [data, setData] = useState<TableRowsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);

  const [sqlOpen, setSqlOpen] = useState(false);
  const [sqlText, setSqlText] = useState("SELECT * FROM samples");
  const [sqlResult, setSqlResult] = useState<RawQueryResponse | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [sqlLoading, setSqlLoading] = useState(false);

  // Load the table list once.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/db/tables")
      .then((res) => res.json())
      .then((json: { tables?: TableSummary[]; error?: string }) => {
        if (cancelled) return;
        if (json.error) {
          setTablesError(json.error);
          return;
        }
        setTables(json.tables ?? []);
        if (json.tables && json.tables.length > 0) {
          setSelectedTable(json.tables[0].name);
        }
      })
      .catch((err) => !cancelled && setTablesError(String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  // Selecting a table is a direct user action, so the paging/sort/filter
  // reset happens right in the handler rather than in a reactive effect.
  function handleSelectTable(name: string) {
    setSelectedTable(name);
    setPage(1);
    setSortColumn(null);
    setSortDir("asc");
    setFilters({});
    setFilterDrafts({});
  }

  // Debounce filter text into the applied `filters` state.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters(filterDrafts);
      setPage(1);
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filterDrafts]);

  const buildQueryString = useCallback(
    (format?: "csv") => {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      if (sortColumn) {
        params.set("sort", sortColumn);
        params.set("dir", sortDir);
      }
      const activeFilters = Object.fromEntries(
        Object.entries(filters).filter(([, v]) => v.trim() !== "")
      );
      if (Object.keys(activeFilters).length > 0) {
        params.set("filters", JSON.stringify(activeFilters));
      }
      if (format) params.set("format", format);
      return params.toString();
    },
    [page, pageSize, sortColumn, sortDir, filters]
  );

  // Fetches the current page of rows. Defined as its own function (rather
  // than setting state directly in the effect body below) so a stale
  // in-flight request can be told to stand down via requestIdRef.
  const requestIdRef = useRef(0);
  const fetchRows = useCallback(async () => {
    if (!selectedTable) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setRowsError(null);
    try {
      const res = await fetch(
        `/api/db/tables/${encodeURIComponent(selectedTable)}?${buildQueryString()}`
      );
      const json: TableRowsResponse & { error?: string } = await res.json();
      if (requestIdRef.current !== requestId) return;
      if (json.error) {
        setRowsError(json.error);
        setData(null);
        return;
      }
      setData(json);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setRowsError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [selectedTable, buildQueryString]);

  // Fetch the current page of rows whenever the table/paging/sort/filters
  // change. Deferred to a microtask (rather than calling fetchRows directly)
  // so its setState calls don't run synchronously within the effect body —
  // see react-hooks/set-state-in-effect.
  useEffect(() => {
    queueMicrotask(() => {
      void fetchRows();
    });
  }, [fetchRows]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  function toggleSort(column: string) {
    if (sortColumn !== column) {
      setSortColumn(column);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortColumn(null);
      setSortDir("asc");
    }
    setPage(1);
  }

  function handleExportCsv() {
    if (!selectedTable) return;
    const url = `/api/db/tables/${encodeURIComponent(selectedTable)}?${buildQueryString("csv")}`;
    // A plain <a download> click triggers the browser's file-save flow
    // without navigating away from the app (unlike window.location.href).
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selectedTable}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async function runRawQuery() {
    setSqlLoading(true);
    setSqlError(null);
    setSqlResult(null);
    try {
      const res = await fetch("/api/db/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: sqlText }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSqlError(json.error ?? "Query failed");
        return;
      }
      setSqlResult(json);
    } catch (err) {
      setSqlError(err instanceof Error ? err.message : String(err));
    } finally {
      setSqlLoading(false);
    }
  }

  const columns = data?.columns ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="table-picker" className="sr-only">
            Table
          </Label>
          {tables === null ? (
            <span className="text-sm text-muted-foreground">Loading tables…</span>
          ) : tablesError ? (
            <span className="text-sm text-destructive">{tablesError}</span>
          ) : (
            <Select value={selectedTable ?? undefined} onValueChange={(v) => handleSelectTable(v as string)}>
              <SelectTrigger id="table-picker">
                <SelectValue placeholder="Select a table" />
              </SelectTrigger>
              <SelectContent>
                {tables.map((t) => (
                  <SelectItem key={t.name} value={t.name}>
                    {t.name}
                    <Badge variant="secondary" className="ml-1.5">
                      {t.rowCount.toLocaleString()}
                    </Badge>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={!selectedTable}>
            <Download />
            Export CSV (current view)
          </Button>
          <Sheet open={sqlOpen} onOpenChange={setSqlOpen}>
            <SheetTrigger render={<Button variant="outline" size="sm" />}>
              <Terminal />
              Raw SQL
            </SheetTrigger>
            <SheetContent className="w-full sm:max-w-2xl">
              <SheetHeader>
                <SheetTitle>Raw SQL query</SheetTitle>
              </SheetHeader>
              <div className="flex flex-col gap-3 px-4 pb-4">
                <p className="text-xs text-muted-foreground">
                  Read-only. Only a single SELECT (or WITH … SELECT) statement is allowed,
                  and results are capped at 1000 rows.
                </p>
                <Textarea
                  value={sqlText}
                  onChange={(e) => setSqlText(e.target.value)}
                  rows={6}
                  className="font-mono text-sm"
                  placeholder="SELECT * FROM samples LIMIT 100"
                />
                <div>
                  <Button size="sm" onClick={runRawQuery} disabled={sqlLoading}>
                    <Play />
                    {sqlLoading ? "Running…" : "Run query"}
                  </Button>
                </div>
                {sqlError && (
                  <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                    {sqlError}
                  </p>
                )}
                {sqlResult && (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-muted-foreground">
                      {sqlResult.rows.length} row(s) — limit applied: {sqlResult.appliedLimit}
                    </p>
                    <div className="max-h-[50vh] overflow-auto rounded-md ring-1 ring-border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {sqlResult.columns.map((col) => (
                              <TableHead key={col}>{col}</TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {sqlResult.rows.map((row, i) => (
                            <TableRow key={i}>
                              {sqlResult.columns.map((col) => (
                                <TableCell key={col}>{formatCellValue(row[col])}</TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {rowsError && (
        <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{rowsError}</p>
      )}

      <div className="overflow-auto rounded-md ring-1 ring-border">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead key={col}>
                  <button
                    type="button"
                    className="flex items-center gap-1 hover:text-foreground"
                    onClick={() => toggleSort(col)}
                  >
                    {col}
                    {sortColumn === col ? (
                      sortDir === "asc" ? (
                        <ArrowUp className="size-3.5" />
                      ) : (
                        <ArrowDown className="size-3.5" />
                      )
                    ) : (
                      <ArrowUpDown className="size-3.5 opacity-40" />
                    )}
                  </button>
                </TableHead>
              ))}
            </TableRow>
            <TableRow>
              {columns.map((col) => (
                <TableHead key={`filter-${col}`} className="pt-0">
                  <Input
                    value={filterDrafts[col] ?? ""}
                    onChange={(e) =>
                      setFilterDrafts((prev) => ({ ...prev, [col]: e.target.value }))
                    }
                    placeholder="filter…"
                    className="h-6 text-xs"
                  />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.rows.map((row, i) => (
              <TableRow key={i}>
                {columns.map((col) => (
                  <TableCell key={col}>{formatCellValue(row[col])}</TableCell>
                ))}
              </TableRow>
            ))}
            {!loading && data && data.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={Math.max(1, columns.length)} className="text-center text-muted-foreground">
                  No rows match the current filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          {data ? `${data.total.toLocaleString()} row(s) total` : loading ? "Loading…" : null}
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="page-size" className="text-muted-foreground">
            Rows per page
          </Label>
          <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}>
            <SelectTrigger id="page-size" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            Prev
          </Button>
          <span className="text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
