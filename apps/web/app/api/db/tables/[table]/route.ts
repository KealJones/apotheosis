import { NextResponse } from "next/server";
import { queryTableRows, rowsToCsv } from "@/lib/db-browser";

interface RouteParams {
  params: Promise<{ table: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  const { table } = await params;
  const { searchParams } = new URL(request.url);

  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.max(1, parseInt(searchParams.get("pageSize") ?? "50", 10) || 50);
  const sortColumn = searchParams.get("sort") ?? undefined;
  const sortDir = searchParams.get("dir") === "desc" ? "desc" : "asc";
  const format = searchParams.get("format") === "csv" ? "csv" : "json";

  let filters: Record<string, string> = {};
  const filtersParam = searchParams.get("filters");
  if (filtersParam) {
    try {
      const parsed = JSON.parse(filtersParam);
      if (parsed && typeof parsed === "object") {
        filters = Object.fromEntries(
          Object.entries(parsed).filter(([, v]) => typeof v === "string")
        ) as Record<string, string>;
      }
    } catch {
      return NextResponse.json({ error: "Invalid filters parameter" }, { status: 400 });
    }
  }

  try {
    const result = queryTableRows(table, { page, pageSize, sortColumn, sortDir, filters });

    if (format === "csv") {
      const csv = rowsToCsv(result.columns, result.rows);
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${table}-page${page}.csv"`,
        },
      });
    }

    return NextResponse.json({
      columns: result.columns,
      rows: result.rows,
      total: result.total,
      page,
      pageSize,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to query table" },
      { status: 400 }
    );
  }
}
