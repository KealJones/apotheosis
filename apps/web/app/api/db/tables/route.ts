import { NextResponse } from "next/server";
import { listTables } from "@/lib/db-browser";

export async function GET() {
  try {
    const tables = listTables();
    return NextResponse.json({ tables });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list tables" },
      { status: 500 }
    );
  }
}
