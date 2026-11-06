import { NextResponse } from "next/server";
import { runReadOnlyQuery, QueryRejectedError, QueryTimeoutError } from "@/lib/run-sql-query";

export async function POST(request: Request) {
  let body: { sql?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.sql !== "string") {
    return NextResponse.json({ error: "Missing 'sql' string field" }, { status: 400 });
  }

  try {
    const result = await runReadOnlyQuery(body.sql);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof QueryRejectedError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof QueryTimeoutError) {
      return NextResponse.json({ error: err.message }, { status: 504 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Query failed" },
      { status: 500 }
    );
  }
}
