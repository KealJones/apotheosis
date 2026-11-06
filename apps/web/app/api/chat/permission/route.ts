import { resolvePermission } from "@/lib/chat/agent";
import { isCrossSiteRequest } from "@/lib/host-guard";

export const runtime = "nodejs";

/** POST { requestId, allow } — answers a pending write-tool confirmation. */
export async function POST(request: Request) {
  if (isCrossSiteRequest(request)) return Response.json({ error: "Cross-site request refused" }, { status: 403 });

  let body: { requestId?: unknown; allow?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.requestId !== "string" || typeof body.allow !== "boolean") {
    return Response.json({ error: "Expected { requestId: string, allow: boolean }" }, { status: 400 });
  }
  if (!resolvePermission(body.requestId, body.allow)) {
    return Response.json({ error: "No pending request with that id (already answered, or the turn ended)" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
