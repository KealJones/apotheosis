import * as fs from "node:fs";
import * as path from "node:path";
import { NextRequest, NextResponse } from "next/server";

import { getDb, getDataDir } from "@/lib/data";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

interface ScreenshotRow {
  screenshot_path: string;
}

/**
 * Serves a sample's screenshot off disk.
 *
 * Security model: the client supplies only a sample `id`; the real file path
 * always comes from the `samples` table, never from client input directly.
 * As defense in depth (in case a screenshot_path value were ever corrupted
 * or crafted), the resolved path is also re-checked against the screenshots
 * directory before the file is read — a `..`-laden path is rejected even if
 * it somehow made it into the DB.
 */
export async function GET(request: NextRequest) {
  const idParam = request.nextUrl.searchParams.get("id");
  const id = idParam ? Number(idParam) : NaN;

  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid or missing sample id" }, { status: 400 });
  }

  const db = getDb();
  const row = db
    .prepare("SELECT screenshot_path FROM samples WHERE id = ?")
    .get(id) as ScreenshotRow | undefined;

  if (!row) {
    return NextResponse.json({ error: "sample not found" }, { status: 404 });
  }

  const screenshotsDir = path.join(getDataDir(), "screenshots");
  const resolved = path.resolve(row.screenshot_path);
  const relative = path.relative(screenshotsDir, resolved);
  const isInsideScreenshotsDir =
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));

  if (!isInsideScreenshotsDir) {
    return NextResponse.json({ error: "path escapes screenshots directory" }, { status: 403 });
  }

  if (!fs.existsSync(resolved)) {
    return NextResponse.json({ error: "screenshot file missing on disk" }, { status: 404 });
  }

  const data = fs.readFileSync(resolved);
  const contentType = CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";

  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
